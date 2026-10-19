import { useCallback, useEffect, useRef, useState } from 'react'
import AiSidebar from './components/AiSidebar'
import CodeEditor from './components/CodeEditor'
import type { CodeEditorHandle } from './components/CodeEditor/types'
import EditorTabs from './components/EditorTabs'
import FileTree from './components/FileTree'
import type { FileNode } from './components/FileTree/types'
import ResizeHandle from './components/ResizeHandle'
import TerminalPanel from './components/TerminalPanel'
import type { TerminalPanelHandle } from './components/TerminalPanel/types'
import TitleBar from './components/TitleBar'
import { useOpenedFiles } from './hooks/useOpenedFiles'
import { useTheme } from './hooks/useTheme'
import { isAtOrUnder } from './lib/filePath'

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

function App(): React.JSX.Element {
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
  // 命令行面板命令式接口（全局快捷键新建终端会话）
  const terminalPanelRef = useRef<TerminalPanelHandle | null>(null)
  // 拖拽开始时的面板尺寸（宽度或高度，任一时刻只会有一个分隔条处于拖拽中）
  const dragStartSizeRef = useRef(0)

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
    setDirtyPaths(new Set())
  }, [closeAll])

  /** 关闭当前文件夹：清空项目路径、标签页与脏标记，回到未打开状态 */
  const handleCloseProject = useCallback((): void => {
    setProjectPath(null)
    closeAll()
    setDirtyPaths(new Set())
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

  /** 切换 AI 侧边栏显隐（标题栏按钮与全局快捷键共用） */
  const toggleAiPanel = useCallback((): void => {
    setAiPanelVisible((prev) => !prev)
  }, [])

  const toggleTerminal = useCallback((): void => {
    if (terminalVisible) {
      closeTerminal()
    } else {
      openTerminal()
    }
  }, [terminalVisible, closeTerminal, openTerminal])

  /** 标题栏终端按钮：确保命令行面板展开，并新建一个终端会话 */
  const handleNewTerminal = useCallback((): void => {
    openTerminal()
    terminalPanelRef.current?.createSession()
  }, [openTerminal])

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

  // Ctrl+`（或 Ctrl+J）切换命令行面板、Ctrl+Shift+` 新建终端、Ctrl+Alt+B 切换 AI 侧边栏：
  // 捕获阶段拦截（capture），避免被 Monaco / xterm 先行消费
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) {
        return
      }
      if (!event.ctrlKey && !event.metaKey) {
        return
      }
      // Ctrl+Alt+B：切换 AI 侧边栏
      if (event.altKey && !event.shiftKey && event.code === 'KeyB') {
        event.preventDefault()
        event.stopPropagation()
        toggleAiPanel()
        return
      }
      if (event.altKey) {
        return
      }
      // Ctrl+Shift+`：确保面板展开，并追加一个新的终端会话
      if (event.code === 'Backquote' && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        handleNewTerminal()
        return
      }
      if (event.shiftKey) {
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
  }, [toggleTerminal, handleNewTerminal, toggleAiPanel])

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        projectPath={projectPath}
        themeId={themeId}
        terminalVisible={terminalVisible}
        aiPanelVisible={aiPanelVisible}
        onOpenFolder={handleOpenProject}
        onCloseFolder={handleCloseProject}
        onThemeChange={setThemeId}
        onNewTerminal={handleNewTerminal}
        onToggleAiPanel={toggleAiPanel}
      />
      <div ref={workspaceRef} className="flex min-h-0 flex-1">
        <aside
          className="flex shrink-0 flex-col border-r border-line bg-elevated"
          style={{ width: sidebarWidth }}
        >
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
            <p className="mx-3 my-4 leading-[1.6] text-dim">
              通过菜单栏「文件 → 打开文件夹」选择代码目录
            </p>
          )}
        </aside>
        <ResizeHandle
          label="调整文件树宽度"
          onResizeStart={handleSidebarResizeStart}
          onResize={handleSidebarResize}
        />
        <main ref={editorAreaRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
            ref={terminalPanelRef}
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
