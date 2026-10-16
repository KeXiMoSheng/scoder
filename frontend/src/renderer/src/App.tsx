import { useCallback, useEffect, useRef, useState } from 'react'
import AiSidebar from './components/AiSidebar'
import CodeEditor from './components/CodeEditor'
import type { CodeEditorHandle } from './components/CodeEditor/types'
import EditorTabs from './components/EditorTabs'
import FileTree from './components/FileTree'
import type { FileNode } from './components/FileTree/types'
import ResizeHandle from './components/ResizeHandle'
import TerminalPanel from './components/TerminalPanel'
import TitleBar from './components/TitleBar'
import { useOpenedFiles } from './hooks/useOpenedFiles'
import { useTheme } from './hooks/useTheme'
import { isAtOrUnder } from './lib/filePath'
import { APP_THEMES } from './lib/theme'

// 后端 API 地址，与 backend/.env 的 PORT 保持一致
const API_BASE = 'http://127.0.0.1:39200'

/** 左侧文件树面板宽度（px） */
const SIDEBAR_DEFAULT_WIDTH = 280
const SIDEBAR_MIN_WIDTH = 160
/** 右侧 AI 边栏宽度（px） */
const AI_PANEL_DEFAULT_WIDTH = 320
const AI_PANEL_MIN_WIDTH = 200
/** 编辑器最小保留宽度：拖拽任一侧面板都不会把编辑器挤到更窄 */
const EDITOR_MIN_WIDTH = 240
/** 拖拽分隔条宽度（px），与 .resize-handle 的 CSS 宽度保持一致 */
const RESIZE_HANDLE_WIDTH = 4
/** 命令行面板默认/最小高度：编辑器区高度的 1/4（首次展开与拖拽下限都用它） */
const TERMINAL_HEIGHT_RATIO = 1 / 4
/** 命令行面板收起阈值：拖拽到小于编辑器区高度的 1/8 时收起 */
const TERMINAL_HIDE_RATIO = 1 / 8
/** 编辑器区最小保留高度（px）：把命令行面板拖大时不会把编辑器挤没 */
const EDITOR_MIN_HEIGHT = 120

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 工具栏图标：外框 + 右侧分栏，突出显示时右侧区域着色加深 */
function SidebarRightIcon({ active }: { active: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" />
      <rect
        x="10.5"
        y="2.5"
        width="4"
        height="11"
        fill="currentColor"
        opacity={active ? 0.45 : 0.12}
      />
      <line x1="10.5" y1="2.5" x2="10.5" y2="13.5" stroke="currentColor" />
    </svg>
  )
}

/** 工具栏图标：终端提示符「>_」 */
function TerminalIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M2.5 4 6 7.5 2.5 11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="7.5"
        y1="11"
        x2="13.5"
        y2="11"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function App(): React.JSX.Element {
  const [status, setStatus] = useState('正在连接后端…')
  const [projectPath, setProjectPath] = useState<string | null>(null)
  // 多标签文件状态（打开/激活/关闭/路径同步）
  const {
    files,
    activePath,
    activeFile,
    open,
    activate,
    close,
    closeOthers,
    closeToRight,
    closeAll,
    remap,
    closeUnder
  } = useOpenedFiles()
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set())
  const [aiPanelVisible, setAiPanelVisible] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const [aiPanelWidth, setAiPanelWidth] = useState(AI_PANEL_DEFAULT_WIDTH)
  // 命令行面板：可见时的高度（px）；null 表示尚未展开过，首次展开按 1/4 初始化
  const [terminalVisible, setTerminalVisible] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState<number | null>(null)
  // 应用级主题（UI 配色 + 编辑器主题同步切换）
  const { themeId, setThemeId } = useTheme()

  const workspaceRef = useRef<HTMLDivElement | null>(null)
  // 编辑器区（含标签栏、编辑器与命令行面板）：面板高度比例都以它为准
  const editorAreaRef = useRef<HTMLElement | null>(null)
  // 编辑器命令式接口（保存脏缓冲区、丢弃路径变更后的模型缓存）
  const editorRef = useRef<CodeEditorHandle | null>(null)
  // 拖拽开始时的面板尺寸（宽度或高度，任一时刻只会有一个分隔条处于拖拽中）
  const dragStartSizeRef = useRef(0)

  useEffect(() => {
    fetch(`${API_BASE}/api/v1/health`)
      .then((res) => res.json())
      .then((data: { service: string }) => setStatus(`后端已连接：${data.service}`))
      .catch(() => setStatus('后端未启动'))
  }, [])

  /** 工作区可用宽度（拖拽与窗口变化时用于约束面板上限） */
  const getWorkspaceWidth = useCallback((): number => {
    return workspaceRef.current?.clientWidth ?? window.innerWidth
  }, [])

  /** 左侧面板允许的最大宽度：为右侧边栏与编辑器保留最小空间 */
  const sidebarMaxWidth = useCallback((): number => {
    const reserved = RESIZE_HANDLE_WIDTH + (aiPanelVisible ? aiPanelWidth + RESIZE_HANDLE_WIDTH : 0)
    return Math.max(SIDEBAR_MIN_WIDTH, getWorkspaceWidth() - reserved - EDITOR_MIN_WIDTH)
  }, [aiPanelVisible, aiPanelWidth, getWorkspaceWidth])

  /** 右侧面板允许的最大宽度：为左侧面板与编辑器保留最小空间 */
  const aiPanelMaxWidth = useCallback((): number => {
    const reserved = sidebarWidth + 2 * RESIZE_HANDLE_WIDTH
    return Math.max(AI_PANEL_MIN_WIDTH, getWorkspaceWidth() - reserved - EDITOR_MIN_WIDTH)
  }, [sidebarWidth, getWorkspaceWidth])

  /** 编辑器区实时高度（命令行面板占比与上下限都以它为基准） */
  const getEditorAreaHeight = useCallback((): number => {
    return editorAreaRef.current?.clientHeight ?? window.innerHeight
  }, [])

  /** 命令行面板的默认高度 = 最小高度：编辑器区的 1/4 */
  const terminalMinHeight = useCallback((): number => {
    return Math.round(getEditorAreaHeight() * TERMINAL_HEIGHT_RATIO)
  }, [getEditorAreaHeight])

  /** 命令行面板的最大高度：为编辑器保留最小高度 */
  const terminalMaxHeight = useCallback((): number => {
    const areaHeight = getEditorAreaHeight()
    return Math.max(areaHeight * TERMINAL_HEIGHT_RATIO, areaHeight - EDITOR_MIN_HEIGHT)
  }, [getEditorAreaHeight])

  // 窗口缩小后收紧两个面板与命令行高度，避免把编辑器挤出可视区域
  useEffect(() => {
    const handleWindowResize = (): void => {
      setSidebarWidth((prev) => clamp(prev, SIDEBAR_MIN_WIDTH, sidebarMaxWidth()))
      setAiPanelWidth((prev) => clamp(prev, AI_PANEL_MIN_WIDTH, aiPanelMaxWidth()))
      setTerminalHeight((prev) =>
        prev === null ? prev : clamp(prev, terminalMinHeight(), terminalMaxHeight())
      )
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [sidebarMaxWidth, aiPanelMaxWidth, terminalMinHeight, terminalMaxHeight])

  const handleOpenProject = useCallback(async (): Promise<void> => {
    const dirPath = await window.api.openProjectDirectory()
    if (!dirPath) {
      return
    }
    setProjectPath(dirPath)
    closeAll()
  }, [closeAll])

  const handleSelectFile = useCallback(
    (file: FileNode): void => {
      open({ path: file.path, name: file.name })
    },
    [open]
  )

  /** 编辑器脏状态变化：维护全应用共享的未保存文件集合（文件树圆点等依赖它） */
  const handleDirtyChange = useCallback((path: string, dirty: boolean): void => {
    setDirtyPaths((prev) => {
      if (prev.has(path) === dirty) {
        return prev
      }
      const next = new Set(prev)
      if (dirty) {
        next.add(path)
      } else {
        next.delete(path)
      }
      return next
    })
  }, [])

  /** 条目重命名/移动前：先保存受影响的脏缓冲区，失败时中止本次操作 */
  const handleBeforeEntryMove = useCallback(async (path: string): Promise<void> => {
    await editorRef.current?.saveDirtyUnder(path)
  }, [])

  /** 条目重命名/移动后：丢弃旧路径的模型缓存，并同步所有受影响标签的路径 */
  const handleEntryMoved = useCallback(
    (oldPath: string, newPath: string): void => {
      editorRef.current?.dropCachedUnder(oldPath)
      remap(oldPath, newPath)
    },
    [remap]
  )

  /** 条目删除后：丢弃编辑器模型缓存，关闭其子树下所有标签，清除其子树下的脏标记 */
  const handleEntryDeleted = useCallback(
    (path: string): void => {
      editorRef.current?.dropCachedUnder(path)
      closeUnder(path)
      setDirtyPaths((prev) => {
        let removed = false
        const next = new Set<string>()
        for (const dirtyPath of prev) {
          if (isAtOrUnder(dirtyPath, path)) {
            removed = true
          } else {
            next.add(dirtyPath)
          }
        }
        return removed ? next : prev
      })
    },
    [closeUnder]
  )

  const handleSidebarResizeStart = useCallback((): void => {
    dragStartSizeRef.current = sidebarWidth
  }, [sidebarWidth])

  const handleSidebarResize = useCallback(
    (offsetX: number): void => {
      setSidebarWidth(
        clamp(dragStartSizeRef.current + offsetX, SIDEBAR_MIN_WIDTH, sidebarMaxWidth())
      )
    },
    [sidebarMaxWidth]
  )

  const handleAiPanelResizeStart = useCallback((): void => {
    dragStartSizeRef.current = aiPanelWidth
  }, [aiPanelWidth])

  const handleAiPanelResize = useCallback(
    (offsetX: number): void => {
      // 分隔条向右拖动（offsetX > 0）时右侧边栏变窄
      setAiPanelWidth(
        clamp(dragStartSizeRef.current - offsetX, AI_PANEL_MIN_WIDTH, aiPanelMaxWidth())
      )
    },
    [aiPanelMaxWidth]
  )

  /** 展开命令行面板：首次展开按编辑器区 1/4 初始化高度，之后沿用上次的高度 */
  const openTerminal = useCallback((): void => {
    setTerminalHeight((prev) => prev ?? terminalMinHeight())
    setTerminalVisible(true)
  }, [terminalMinHeight])

  const closeTerminal = useCallback((): void => {
    setTerminalVisible(false)
  }, [])

  const toggleTerminal = useCallback((): void => {
    if (terminalVisible) {
      closeTerminal()
    } else {
      openTerminal()
    }
  }, [terminalVisible, closeTerminal, openTerminal])

  const handleTerminalResizeStart = useCallback((): void => {
    // 收起状态下从底部拖出时，以 0 为起点向上生长
    dragStartSizeRef.current = terminalVisible ? (terminalHeight ?? 0) : 0
  }, [terminalVisible, terminalHeight])

  const handleTerminalResize = useCallback(
    (offsetY: number): void => {
      const areaHeight = getEditorAreaHeight()
      // 分隔条向上拖动（offsetY < 0）面板变高：目标高度 = 按下时高度 - 纵向偏移
      const target = dragStartSizeRef.current - offsetY
      if (target < areaHeight * TERMINAL_HIDE_RATIO) {
        // 拖到 1/8 以下：立即收起（继续上拖可再拽出来）
        setTerminalVisible(false)
        return
      }
      setTerminalVisible(true)
      setTerminalHeight(clamp(target, areaHeight * TERMINAL_HEIGHT_RATIO, terminalMaxHeight()))
    },
    [getEditorAreaHeight, terminalMaxHeight]
  )

  // Ctrl+`（或 Ctrl+J）切换命令行面板：捕获阶段拦截，避免被 Monaco / xterm 先行消费
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) {
        return
      }
      if ((!event.ctrlKey && !event.metaKey) || event.altKey) {
        return
      }
      if (event.code !== 'Backquote' && event.code !== 'KeyJ') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      toggleTerminal()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [toggleTerminal])

  return (
    <div className="app">
      <TitleBar />
      <header className="toolbar">
        <button type="button" className="toolbar__button" onClick={handleOpenProject}>
          打开项目
        </button>
        <span className="toolbar__path" title={projectPath ?? undefined}>
          {projectPath ?? '未打开项目'}
        </span>
        <span className="toolbar__status">{status}</span>
        <select
          className="toolbar__theme"
          value={themeId}
          onChange={(event) => setThemeId(event.target.value)}
          title="切换主题"
          aria-label="切换主题"
        >
          {APP_THEMES.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={
            aiPanelVisible
              ? 'toolbar__icon-button toolbar__icon-button--active'
              : 'toolbar__icon-button'
          }
          onClick={() => setAiPanelVisible((prev) => !prev)}
          title={aiPanelVisible ? '收起 AI 助手' : '展开 AI 助手'}
          aria-label="切换 AI 助手侧边栏"
          aria-pressed={aiPanelVisible}
        >
          <SidebarRightIcon active={aiPanelVisible} />
        </button>
        <button
          type="button"
          className={
            terminalVisible
              ? 'toolbar__icon-button toolbar__icon-button--active'
              : 'toolbar__icon-button'
          }
          onClick={toggleTerminal}
          title={terminalVisible ? '收起命令行面板（Ctrl+`）' : '展开命令行面板（Ctrl+`）'}
          aria-label="切换命令行面板"
          aria-pressed={terminalVisible}
        >
          <TerminalIcon />
        </button>
      </header>
      <div ref={workspaceRef} className="workspace">
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          {projectPath ? (
            <FileTree
              key={projectPath}
              rootPath={projectPath}
              selectedPath={activePath}
              dirtyPaths={dirtyPaths}
              onSelectFile={handleSelectFile}
              onBeforeEntryMove={handleBeforeEntryMove}
              onEntryMoved={handleEntryMoved}
              onEntryDeleted={handleEntryDeleted}
            />
          ) : (
            <p className="sidebar__hint">点击左上角「打开项目」选择代码目录</p>
          )}
        </aside>
        <ResizeHandle
          label="调整文件树宽度"
          onResizeStart={handleSidebarResizeStart}
          onResize={handleSidebarResize}
        />
        <main ref={editorAreaRef} className="editor-area">
          <div className="editor-pane">
            {files.length > 0 ? (
              <EditorTabs
                files={files}
                activePath={activePath}
                dirtyPaths={dirtyPaths}
                onActivate={activate}
                onClose={close}
                onCloseOthers={closeOthers}
                onCloseToRight={closeToRight}
                onCloseAll={closeAll}
              />
            ) : null}
            <CodeEditor ref={editorRef} file={activeFile} onDirtyChange={handleDirtyChange} />
          </div>
          <ResizeHandle
            label={terminalVisible ? '调整命令行面板高度' : '向上拖拽展开命令行面板'}
            orientation="horizontal"
            collapsed={!terminalVisible}
            onResizeStart={handleTerminalResizeStart}
            onResize={handleTerminalResize}
          />
          <TerminalPanel
            visible={terminalVisible}
            height={terminalHeight ?? 0}
            cwd={projectPath}
            themeId={themeId}
            onRequestHide={closeTerminal}
          />
        </main>
        {aiPanelVisible ? (
          <>
            <ResizeHandle
              label="调整 AI 助手宽度"
              onResizeStart={handleAiPanelResizeStart}
              onResize={handleAiPanelResize}
            />
            <AiSidebar width={aiPanelWidth} />
          </>
        ) : null}
      </div>
    </div>
  )
}

export default App
