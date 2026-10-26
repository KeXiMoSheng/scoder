import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { extractErrorMessage } from '../../lib/errorMessage'
import type { TerminalPanelHandle, TerminalPanelProps } from './types'

/** 用应用主题的 CSS 变量构造 xterm 配色，与面板背景/前景保持一致 */
function buildTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement)
  const cssVar = (name: string): string => styles.getPropertyValue(name).trim()
  return {
    background: cssVar('--bg'),
    foreground: cssVar('--text'),
    cursor: cssVar('--text'),
    selectionBackground: cssVar('--selection')
  }
}

/** 按运行平台返回终端标签名：Windows 用 powershell，其余（Linux/macOS）用 bash */
function resolveTerminalTitle(): string {
  return window.electron.process.platform === 'win32' ? 'powershell' : 'bash'
}

/** 单个终端会话：一个 xterm 实例 + 其 pty 进程（pty id 在创建回执后就位） */
interface TerminalSessionView {
  /** 前端本地 id（React 标签 key，与 pty id 无关） */
  uid: number
  /** xterm 实例及其容器（隐藏时 display:none，会话保持存活） */
  term: Terminal
  fitAddon: FitAddon
  container: HTMLDivElement
  /** pty 会话 id；创建回执前与进程退出后为 null */
  ptyId: number | null
}

/** 标签栏渲染所需的轻量元数据（xterm 实例无法放入 state，保存在 ref 中） */
interface TerminalTab {
  uid: number
  title: string
}

/** 仅显示激活会话的容器（其余会话隐藏但保持挂载，进程继续运行） */
function showActiveContainer(sessions: TerminalSessionView[], activeUid: number): void {
  for (const session of sessions) {
    session.container.style.display = session.uid === activeUid ? '' : 'none'
  }
}

/** 同步全部会话的 xterm 配色 */
function applyTerminalTheme(sessions: TerminalSessionView[], theme: ITheme): void {
  for (const session of sessions) {
    session.term.options.theme = theme
  }
}

/**
 * 底部命令行面板：支持多个终端会话（VS Code 风格标签页）。
 * 每个标签对应一个独立的 xterm + pty 会话，切换标签只切换显示；
 * 首次展开惰性创建首个会话，关闭最后一个标签时收起面板（下次展开再创建）
 */
const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(function TerminalPanel(
  { visible, height, cwd, themeId, onRequestHide },
  ref
): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // 全部会话（含各自 xterm 实例），事件分发与命令式操作都读它
  const sessionsRef = useRef<TerminalSessionView[]>([])
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  // 激活会话的 uid；渲染态与 ref 双份：事件回调和命令式逻辑需要即时读最新值
  const [activeUid, setActiveUid] = useState<number | null>(null)
  const activeUidRef = useRef<number | null>(null)
  const nextUidRef = useRef(1)
  // 会话创建是异步的：pty id 回执前收到的输出/退出先按 pty id 缓存，待认领后回放
  const pendingDataByPtyIdRef = useRef(new Map<number, string[]>())
  const pendingExitByPtyIdRef = useRef(new Map<number, number>())
  // 合并同一帧内的多次适配请求（拖拽面板时 ResizeObserver 会高频触发）
  const fitFrameRef = useRef<number | null>(null)
  // 新建会话时用 ref 取最新的启动目录，避免回调闭包读到旧值
  const cwdRef = useRef(cwd)

  useEffect(() => {
    cwdRef.current = cwd
  }, [cwd])

  /** 按容器当前尺寸适配指定会话，尺寸有变化时同步其 pty 的列数/行数 */
  const fitSession = useCallback((session: TerminalSessionView): void => {
    // 容器未布局（面板收起为 display:none 时尺寸为 0）时跳过：
    // 此时 FitAddon 会因内部 Math.max(2/1, …) 提出 2×1 的极小尺寸，
    // 触发 pty 收缩 → bash 重绘提示符，反复收起/展开会累积多余提示行。
    // 保持 pty 上一次的真实尺寸，展开时由 ResizeObserver 再重新适配
    if (session.container.clientWidth === 0 || session.container.clientHeight === 0) {
      return
    }
    const previousCols = session.term.cols
    const previousRows = session.term.rows
    session.fitAddon.fit()
    if (
      (session.term.cols !== previousCols || session.term.rows !== previousRows) &&
      session.ptyId !== null
    ) {
      window.api.resizeTerminal(session.ptyId, session.term.cols, session.term.rows)
    }
  }, [])

  const fitActiveSession = useCallback((): void => {
    const session = sessionsRef.current.find((item) => item.uid === activeUidRef.current)
    if (session) {
      fitSession(session)
    }
  }, [fitSession])

  const scheduleFit = useCallback((): void => {
    if (fitFrameRef.current !== null) {
      return
    }
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null
      fitActiveSession()
    })
  }, [fitActiveSession])

  /** pty 进程退出：清除会话 id 并写出提示（标签保留，供用户查看最终输出） */
  const handlePtyExit = useCallback((session: TerminalSessionView, exitCode: number): void => {
    session.ptyId = null
    session.term.write(`\r\n\x1b[90m[进程已退出（退出码 ${exitCode}）]\x1b[0m\r\n`)
  }, [])

  /** 激活会话：仅切换显示层（其余会话保持存活），并重新适配尺寸、聚焦 */
  const activateSession = useCallback(
    (uid: number): void => {
      activeUidRef.current = uid
      showActiveContainer(sessionsRef.current, uid)
      setActiveUid(uid)
      const session = sessionsRef.current.find((item) => item.uid === uid)
      if (session) {
        // 从 display:none 切回可见后必须重新适配（隐藏期间容器无尺寸，fit 不生效）
        fitSession(session)
        session.term.focus()
      }
    },
    [fitSession]
  )

  /** 新建终端会话（标签）并激活；容器与 xterm 均为命令式创建，React 只渲染标签栏 */
  const createSession = useCallback((): void => {
    const body = bodyRef.current
    if (!body) {
      return
    }
    const container = document.createElement('div')
    container.className = 'h-full w-full'
    body.appendChild(container)

    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: buildTerminalTheme()
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)

    const session: TerminalSessionView = {
      uid: nextUidRef.current,
      term,
      fitAddon,
      container,
      ptyId: null
    }
    nextUidRef.current += 1
    const title = resolveTerminalTitle()

    // 用户键入 → pty（进程已退出时静默忽略）
    term.onData((data) => {
      if (session.ptyId !== null) {
        window.api.writeTerminal(session.ptyId, data)
      }
    })

    // 复制/粘贴：有选区时 Ctrl+C 复制而非发送 SIGINT；Ctrl+V / Ctrl+Shift+V 粘贴
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || (!event.ctrlKey && !event.metaKey)) {
        return true
      }
      if (event.code === 'KeyC') {
        const selection = term.getSelection()
        if (event.shiftKey || selection) {
          void navigator.clipboard.writeText(selection)
          return false
        }
        return true
      }
      if (event.code === 'KeyV') {
        void navigator.clipboard.readText().then((text) => {
          if (text && session.ptyId !== null) {
            window.api.writeTerminal(session.ptyId, text)
          }
        })
        return false
      }
      return true
    })

    sessionsRef.current.push(session)
    setTabs((prev) => [...prev, { uid: session.uid, title }])
    activateSession(session.uid)

    window.api
      .createTerminal(cwdRef.current, term.cols, term.rows)
      .then((id) => {
        session.ptyId = id
        // 回执期间容器可能已重新适配（如收起状态下新建、面板随即展开）：
        // 按当前行列补一次尺寸同步，避免 pty 停留在创建时的旧尺寸
        window.api.resizeTerminal(id, term.cols, term.rows)
        // 回执前已到达的输出按 pty id 缓存，认领后按序回放
        const buffered = pendingDataByPtyIdRef.current.get(id)
        if (buffered) {
          pendingDataByPtyIdRef.current.delete(id)
          term.write(buffered.join(''))
        }
        // 启动即退出的极罕见场景：退出事件先于回执到达
        const exitCode = pendingExitByPtyIdRef.current.get(id)
        if (exitCode !== undefined) {
          pendingExitByPtyIdRef.current.delete(id)
          handlePtyExit(session, exitCode)
        }
      })
      .catch((reason: unknown) => {
        term.write(`\x1b[31m终端启动失败：${extractErrorMessage(reason)}\x1b[0m\r\n`)
      })
  }, [activateSession, handlePtyExit])

  /** 关闭指定终端会话：杀死 pty 并释放 xterm；关闭最后一个时收起面板 */
  const closeSession = useCallback(
    (uid: number): void => {
      const index = sessionsRef.current.findIndex((item) => item.uid === uid)
      const session = sessionsRef.current[index]
      if (!session) {
        return
      }
      sessionsRef.current.splice(index, 1)
      if (session.ptyId !== null) {
        pendingDataByPtyIdRef.current.delete(session.ptyId)
        pendingExitByPtyIdRef.current.delete(session.ptyId)
        void window.api.disposeTerminal(session.ptyId)
        session.ptyId = null
      }
      session.term.dispose()
      session.container.remove()
      setTabs((prev) => prev.filter((tab) => tab.uid !== uid))

      if (sessionsRef.current.length === 0) {
        // 没有终端可显示：收起面板（底部拖拽条保留，展开时会自动创建新会话）
        activeUidRef.current = null
        setActiveUid(null)
        onRequestHide()
        return
      }
      if (activeUidRef.current === uid) {
        // 激活被关闭标签的相邻会话（优先右侧，越界时取左侧）
        const next = sessionsRef.current[Math.min(index, sessionsRef.current.length - 1)]
        if (next) {
          activateSession(next.uid)
        }
      }
    },
    [activateSession, onRequestHide]
  )

  // 供父级（全局快捷键 Ctrl+Shift+`）新建终端
  useImperativeHandle(ref, () => ({ createSession }), [createSession])

  // 面板级单次订阅：输出/退出事件按 pty id 分发给对应会话
  useEffect(() => {
    const unsubscribeData = window.api.onTerminalData(({ id, data }) => {
      const session = sessionsRef.current.find((item) => item.ptyId === id)
      if (session) {
        session.term.write(data)
        return
      }
      // 会话的 createTerminal 尚未返回：先按 pty id 缓存，认领后回放
      const queue = pendingDataByPtyIdRef.current.get(id)
      if (queue) {
        queue.push(data)
      } else {
        pendingDataByPtyIdRef.current.set(id, [data])
      }
    })
    const unsubscribeExit = window.api.onTerminalExit(({ id, exitCode }) => {
      const session = sessionsRef.current.find((item) => item.ptyId === id)
      if (session) {
        handlePtyExit(session, exitCode)
        return
      }
      pendingExitByPtyIdRef.current.set(id, exitCode)
    })
    return () => {
      unsubscribeData()
      unsubscribeExit()
    }
  }, [handlePtyExit])

  // 容器尺寸变化（拖拽面板高度/窗口缩放）→ 重新适配激活会话
  useEffect(() => {
    const body = bodyRef.current
    if (!body) {
      return
    }
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(body)
    return () => observer.disconnect()
  }, [scheduleFit])

  // 展开时：无可用的会话（首次展开或全部关闭后）惰性创建；否则重新适配并聚焦
  useEffect(() => {
    if (!visible) {
      return
    }
    if (sessionsRef.current.length === 0) {
      createSession()
      return
    }
    fitActiveSession()
    const session = sessionsRef.current.find((item) => item.uid === activeUidRef.current)
    session?.term.focus()
  }, [visible, createSession, fitActiveSession])

  // 主题切换：同步所有终端配色
  useEffect(() => {
    applyTerminalTheme(sessionsRef.current, buildTerminalTheme())
  }, [themeId])

  // 组件卸载：释放全部会话（xterm、pty 进程与挂载容器）
  useEffect(() => {
    // 清空的是惰性创建的 Map 本体（不会被替换），先取引用以满足 lint 的清洁性检查
    const pendingData = pendingDataByPtyIdRef.current
    const pendingExit = pendingExitByPtyIdRef.current
    return () => {
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = null
      }
      for (const session of sessionsRef.current) {
        if (session.ptyId !== null) {
          void window.api.disposeTerminal(session.ptyId)
          session.ptyId = null
        }
        session.term.dispose()
        session.container.remove()
      }
      sessionsRef.current = []
      pendingData.clear()
      pendingExit.clear()
    }
  }, [])

  return (
    <section
      className="flex min-h-0 shrink-0 flex-col overflow-hidden border-t border-line bg-base"
      style={{ height, display: visible ? undefined : 'none' }}
      aria-hidden={!visible}
    >
      <header className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-elevated px-1.5 text-[12px] text-dim">
        <div
          className="scrollbar-none flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden"
          role="tablist"
          aria-label="终端会话"
        >
          {tabs.map((tab) => {
            const active = tab.uid === activeUid
            return (
              <div
                key={tab.uid}
                role="tab"
                aria-selected={active}
                className={
                  active
                    ? 'group inline-flex h-[22px] max-w-[160px] shrink-0 cursor-pointer items-center gap-1.5 rounded-[3px] bg-base pl-2.5 pr-1 text-fg select-none hover:bg-hover'
                    : 'group inline-flex h-[22px] max-w-[160px] shrink-0 cursor-pointer items-center gap-1.5 rounded-[3px] pl-2.5 pr-1 select-none hover:bg-hover'
                }
                title={tab.title}
                onClick={() => activateSession(tab.uid)}
              >
                <span className="truncate">{tab.title}</span>
                <button
                  type="button"
                  className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border-none bg-transparent p-0 text-inherit transition-opacity hover:bg-[color-mix(in_srgb,var(--text)_14%,transparent)] hover:text-fg ${
                    active
                      ? 'pointer-events-auto opacity-100'
                      : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
                  }`}
                  aria-label={`关闭 ${tab.title}`}
                  title="关闭终端"
                  onClick={(event) => {
                    // 阻止冒泡，避免同时触发标签激活
                    event.stopPropagation()
                    closeSession(tab.uid)
                  }}
                >
                  <X className="size-2.5" />
                </button>
              </div>
            )
          })}
        </div>
        <div className="inline-flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className="inline-flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent p-0 text-[14px] leading-none text-dim transition-colors hover:bg-hover hover:text-fg"
            onClick={createSession}
            title="新建终端（Ctrl+Shift+`）"
            aria-label="新建终端"
          >
            +
          </button>
          <button
            type="button"
            className="inline-flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent p-0 text-[14px] leading-none text-dim transition-colors hover:bg-hover hover:text-fg"
            onClick={onRequestHide}
            title="收起命令行面板（Ctrl+`）"
            aria-label="收起命令行面板"
          >
            ×
          </button>
        </div>
      </header>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-hidden" />
    </section>
  )
})

export default TerminalPanel
