import { useCallback, useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { extractErrorMessage } from '../../lib/errorMessage'
import type { TerminalPanelProps } from './types'

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

/**
 * 底部命令行面板：首次展开时惰性创建 xterm 与 pty 会话，
 * 之后收起仅隐藏外观（display:none），shell 会话在面板隐藏期间保持存活
 */
export default function TerminalPanel({
  visible,
  height,
  cwd,
  themeId,
  onRequestHide
}: TerminalPanelProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<number | null>(null)
  // 会话创建是异步的：id 返回渲染进程前 pty 已产生的输出先暂存，待 id 就位后回放
  const pendingOutputRef = useRef<string[]>([])
  // 组件卸载时统一释放惰性创建的资源（xterm / 订阅 / pty 会话）
  const teardownRef = useRef<(() => void) | null>(null)
  // 会话只在首次展开时创建，用 ref 取最新的启动目录，避免初始化闭包读到旧值
  const cwdRef = useRef(cwd)
  // 合并同一帧内的多次适配请求（拖拽面板时 ResizeObserver 会高频触发）
  const fitFrameRef = useRef<number | null>(null)

  useEffect(() => {
    cwdRef.current = cwd
  }, [cwd])

  /** 按容器当前尺寸重新适配终端，并同步 pty 的列数/行数 */
  const fitAndResize = useCallback((): void => {
    const term = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!term || !fitAddon) {
      return
    }
    const previousCols = term.cols
    const previousRows = term.rows
    fitAddon.fit()
    if (
      (term.cols !== previousCols || term.rows !== previousRows) &&
      sessionIdRef.current !== null
    ) {
      window.api.resizeTerminal(sessionIdRef.current, term.cols, term.rows)
    }
  }, [])

  const scheduleFit = useCallback((): void => {
    if (fitFrameRef.current !== null) {
      return
    }
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null
      fitAndResize()
    })
  }, [fitAndResize])

  /** 首次展开时初始化：xterm 实例、订阅连接、pty 会话与尺寸联动 */
  const initializeTerminal = useCallback((): void => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: buildTerminalTheme()
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()
    terminalRef.current = term
    fitAddonRef.current = fitAddon

    // 输出订阅先于会话创建注册，避免丢失 shell 的首屏提示符
    const unsubscribeData = window.api.onTerminalData(({ id, data }) => {
      if (sessionIdRef.current === null) {
        pendingOutputRef.current.push(data)
        return
      }
      if (id === sessionIdRef.current) {
        term.write(data)
      }
    })
    const unsubscribeExit = window.api.onTerminalExit(({ id, exitCode }) => {
      if (id !== sessionIdRef.current) {
        return
      }
      sessionIdRef.current = null
      term.write(`\r\n\x1b[90m[进程已退出（退出码 ${exitCode}）]\x1b[0m\r\n`)
    })

    // 用户键入 → pty
    const inputDisposable = term.onData((data) => {
      if (sessionIdRef.current !== null) {
        window.api.writeTerminal(sessionIdRef.current, data)
      }
    })

    // 容器尺寸变化（拖拽面板高度/窗口缩放）→ 重新适配并同步 pty
    const resizeObserver = new ResizeObserver(scheduleFit)
    resizeObserver.observe(container)

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
          if (text && sessionIdRef.current !== null) {
            window.api.writeTerminal(sessionIdRef.current, text)
          }
        })
        return false
      }
      return true
    })

    window.api
      .createTerminal(cwdRef.current, term.cols, term.rows)
      .then((id) => {
        sessionIdRef.current = id
        const pending = pendingOutputRef.current.join('')
        pendingOutputRef.current = []
        if (pending) {
          term.write(pending)
        }
      })
      .catch((reason: unknown) => {
        term.write(`\x1b[31m终端启动失败：${extractErrorMessage(reason)}\x1b[0m\r\n`)
      })

    teardownRef.current = () => {
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = null
      }
      resizeObserver.disconnect()
      inputDisposable.dispose()
      unsubscribeData()
      unsubscribeExit()
      if (sessionIdRef.current !== null) {
        void window.api.disposeTerminal(sessionIdRef.current)
        sessionIdRef.current = null
      }
      term.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [scheduleFit])

  // 展开时：首次展开初始化会话，之后只需按当前尺寸重新适配并聚焦
  useEffect(() => {
    if (!visible) {
      return
    }
    if (!terminalRef.current) {
      initializeTerminal()
    } else {
      fitAndResize()
    }
    terminalRef.current?.focus()
  }, [visible, initializeTerminal, fitAndResize])

  // 主题切换：同步终端配色
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = buildTerminalTheme()
    }
  }, [themeId])

  // 组件卸载：释放 xterm、订阅与 pty 会话
  useEffect(() => {
    return () => {
      teardownRef.current?.()
      teardownRef.current = null
    }
  }, [])

  return (
    <section
      className="terminal-panel"
      style={{ height, display: visible ? undefined : 'none' }}
      aria-hidden={!visible}
    >
      <header className="terminal-panel__header">
        <span className="terminal-panel__title">终端</span>
        <button
          type="button"
          className="terminal-panel__hide"
          onClick={onRequestHide}
          title="收起命令行面板（Ctrl+`）"
          aria-label="收起命令行面板"
        >
          ×
        </button>
      </header>
      <div ref={containerRef} className="terminal-panel__body" />
    </section>
  )
}
