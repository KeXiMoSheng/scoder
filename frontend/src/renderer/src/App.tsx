import { useCallback, useEffect, useRef, useState } from 'react'
import { attachmentKey } from '@shared/ai/attachments'
import type { AiAttachment } from '@shared/ai/types'
import type { RecentProject } from '@shared/workspace/types'
import AiSidebar from './components/AiSidebar'
import CodeEditor from './components/CodeEditor'
import type { CodeEditorHandle } from './components/CodeEditor/types'
import EditorTabs from './components/EditorTabs'
import FileTree from './components/FileTree'
import ResizeHandle from './components/ResizeHandle'
import SettingsPage from './components/SettingsPage'
import TerminalPanel from './components/TerminalPanel'
import type { TerminalPanelHandle } from './components/TerminalPanel/types'
import TitleBar from './components/TitleBar'
import { useAiSessions } from './hooks/useAiSessions'
import { useOpenedFiles } from './hooks/useOpenedFiles'
import { useTheme } from './hooks/useTheme'
import { basename, isAbsolutePath, isAtOrUnder, joinPath } from './lib/filePath'
import { cn } from './lib/utils'

/** 左侧文件树面板宽度（px） */
const SIDEBAR_DEFAULT_WIDTH = 280
const SIDEBAR_MIN_WIDTH = 160
/** 文件树收起阈值：拖到最小宽度的一半以下时自动隐藏（与命令行面板收起策略一致） */
const SIDEBAR_HIDE_WIDTH = SIDEBAR_MIN_WIDTH / 2
/** 右侧 AI 边栏宽度（px） */
const AI_PANEL_DEFAULT_WIDTH = 500
const AI_PANEL_MIN_WIDTH = 300
/** AI 边栏收起阈值：拖到最小宽度的一半以下时自动隐藏 */
const AI_PANEL_HIDE_WIDTH = AI_PANEL_MIN_WIDTH / 2
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
  // 最近打开的项目（MRU，最多 5 个），供「文件」菜单展示
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])
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
  // AI 会话状态（新建/切换/重命名/关闭）：放在 App 里，侧边栏隐藏再打开时不丢会话
  const aiSessions = useAiSessions(projectPath)
  // 单独取出稳定回调：避免快捷键监听依赖整个会话对象而反复重建
  const ensureAiSession = aiSessions.ensureSession
  const applyServerTitle = aiSessions.applyServerTitle
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set())
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [aiPanelVisible, setAiPanelVisible] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const [aiPanelWidth, setAiPanelWidth] = useState(AI_PANEL_DEFAULT_WIDTH)
  // 命令行面板：可见时的高度（px）；null 表示尚未展开过，首次展开按 1/4 初始化
  const [terminalVisible, setTerminalVisible] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState<number | null>(null)
  // 系统配置页：以覆盖层形式显示在工作区之上，工作区保持挂载（编辑/终端状态不丢失）
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 文件树刷新信号：AI 写工具落盘后递增，文件树据此重读已加载目录
  const [fsRefreshToken, setFsRefreshToken] = useState(0)
  // 编辑器标签请求在文件树中定位的目标（路径 + 递增信号）：递增 nonce 保证同一路径重复请求也能触发
  const [revealRequest, setRevealRequest] = useState<{ path: string; nonce: number } | null>(null)
  // 等待随下一条消息发送给 AI 的上下文（路径 + 类型，选中行含内容）：面板收起再打开时保持
  const [aiAttachments, setAiAttachments] = useState<AiAttachment[]>([])
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

  /** 左侧面板允许的最大宽度：为右侧边栏与编辑器保留最小空间（两条分隔条始终占位） */
  const sidebarMaxWidth = useCallback((): number => {
    const reserved = (aiPanelVisible ? aiPanelWidth : 0) + 2 * RESIZE_HANDLE_WIDTH
    return Math.max(SIDEBAR_MIN_WIDTH, getWorkspaceWidth() - reserved - EDITOR_MIN_WIDTH)
  }, [aiPanelVisible, aiPanelWidth, getWorkspaceWidth])

  /** 右侧面板允许的最大宽度：为左侧面板与编辑器保留最小空间（收起的面板不占宽度） */
  const aiPanelMaxWidth = useCallback((): number => {
    const reserved = (sidebarVisible ? sidebarWidth : 0) + 2 * RESIZE_HANDLE_WIDTH
    return Math.max(AI_PANEL_MIN_WIDTH, getWorkspaceWidth() - reserved - EDITOR_MIN_WIDTH)
  }, [sidebarVisible, sidebarWidth, getWorkspaceWidth])

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

  /** 重新拉取最近项目列表（打开/关闭后调用，让菜单与磁盘状态一致） */
  const refreshRecent = useCallback((): void => {
    void window.api.listRecentProjects().then(setRecentProjects)
  }, [])

  /** 打开一个具体目录：同步工作区状态、清空上一个项目的标签与脏标记，并写入最近项目 */
  const openProjectPath = useCallback(
    (dirPath: string): void => {
      setProjectPath(dirPath)
      closeAll()
      setDirtyPaths(new Set())
      // 附件属于上一个项目，切换项目后不再继续待发送
      setAiAttachments([])
      // 打开新目录时确保文件树可见（之前可能被拖拽收起）
      setSidebarVisible(true)
      void window.api.recordProjectOpened(dirPath).then(refreshRecent)
    },
    [closeAll, refreshRecent]
  )

  const handleOpenProject = useCallback(async (): Promise<void> => {
    const dirPath = await window.api.openProjectDirectory()
    if (dirPath) {
      openProjectPath(dirPath)
    }
  }, [openProjectPath])

  /** 关闭当前文件夹：清空项目路径、标签页与脏标记，回到未打开状态；同时取消下次启动的自动打开 */
  const handleCloseProject = useCallback((): void => {
    setProjectPath(null)
    closeAll()
    setDirtyPaths(new Set())
    setAiAttachments([])
    void window.api.clearRestoreProject()
  }, [closeAll])

  // 应用启动：读取上次未手动关闭的目录并自动打开，同时加载最近项目列表
  useEffect(() => {
    void window.api.getLastProject().then((last) => {
      if (last) {
        setProjectPath(last)
      }
    })
    refreshRecent()
  }, [refreshRecent])

  /**
   * 打开文件页签的统一入口：文件树与 AI 附件共用。
   * 附件历史里是相对工作区根的路径，这里统一补全为绝对路径；已打开时只激活。
   */
  const openFileByPath = useCallback(
    (path: string): void => {
      let absolute = path
      if (!isAbsolutePath(path)) {
        if (projectPath === null) {
          return
        }
        const separator = projectPath.includes('\\') ? '\\' : '/'
        absolute = joinPath(projectPath, path.split('/').join(separator))
      }
      open({ path: absolute, name: basename(absolute) })
    },
    [open, projectPath]
  )

  /** 把一个上下文加入待发送附件：去重，并确保右侧边栏与会话已就绪 */
  const attachToAi = useCallback(
    (attachment: AiAttachment): void => {
      const target = attachmentKey(attachment)
      setAiAttachments((prev) => {
        const index = prev.findIndex((item) => attachmentKey(item) === target)
        if (index === -1) {
          return [...prev, attachment]
        }
        // 同范围再次添加时用最新选中内容覆盖旧值（文件可能已被编辑）
        const next = [...prev]
        next[index] = attachment
        return next
      })
      setAiPanelVisible(true)
      ensureAiSession()
    },
    [ensureAiSession]
  )

  /** 文件树：文件/目录都只带路径与类型，目录不读取内容 */
  const handleAttachPathToAi = useCallback(
    (path: string, isDirectory: boolean): void => {
      attachToAi({ path, kind: isDirectory ? 'directory' : 'file' })
    },
    [attachToAi]
  )

  /** 编辑器标签：始终是文件 */
  const handleAttachTabToAi = useCallback(
    (path: string): void => {
      attachToAi({ path, kind: 'file' })
    },
    [attachToAi]
  )

  const handleRemoveAiAttachment = useCallback((attachment: AiAttachment): void => {
    const target = attachmentKey(attachment)
    setAiAttachments((prev) =>
      prev.some((item) => attachmentKey(item) === target)
        ? prev.filter((item) => attachmentKey(item) !== target)
        : prev
    )
  }, [])

  const clearAiAttachments = useCallback((): void => {
    setAiAttachments([])
  }, [])

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

  // AI 写工具改动磁盘后：重载已打开的缓冲区并刷新文件树；模型润色完标题后同步标签。
  // 工具给的是相对工作区根的路径，转回绝对路径后才能对上编辑器的 model。
  useEffect(() => {
    if (projectPath === null) {
      return
    }
    const separator = projectPath.includes('\\') ? '\\' : '/'
    return window.api.ai.onEvent(({ sessionId, event }) => {
      if (event.type === 'session-title') {
        applyServerTitle(sessionId, event.title)
        return
      }
      if (event.type !== 'file-changed') {
        return
      }
      for (const relative of event.paths) {
        editorRef.current?.reloadFromDisk(
          joinPath(projectPath, relative.split('/').join(separator))
        )
      }
      setFsRefreshToken((token) => token + 1)
    })
  }, [applyServerTitle, projectPath])

  /** 条目重命名/移动前：先保存受影响的脏缓冲区，失败时中止本次操作 */
  const handleBeforeEntryMove = useCallback(async (path: string): Promise<void> => {
    await editorRef.current?.saveDirtyUnder(path)
  }, [])

  /** 条目重命名/移动后：丢弃旧路径的模型缓存，同步受影响标签与待发送附件 */
  const handleEntryMoved = useCallback(
    (oldPath: string, newPath: string): void => {
      editorRef.current?.dropCachedUnder(oldPath)
      remap(oldPath, newPath)
      setAiAttachments((prev) => {
        let changed = false
        const next = prev.map((attachment) => {
          if (attachment.path === oldPath) {
            changed = true
            return { ...attachment, path: newPath }
          }
          if (isAtOrUnder(attachment.path, oldPath)) {
            changed = true
            return { ...attachment, path: newPath + attachment.path.slice(oldPath.length) }
          }
          return attachment
        })
        return changed ? next : prev
      })
    },
    [remap]
  )

  /** 条目删除后：丢弃编辑器模型缓存，关闭其子树下所有标签，清除其子树下的脏标记与待发送附件 */
  const handleEntryDeleted = useCallback(
    (path: string): void => {
      editorRef.current?.dropCachedUnder(path)
      closeUnder(path)
      setAiAttachments((prev) =>
        prev.some((attachment) => isAtOrUnder(attachment.path, path))
          ? prev.filter((attachment) => !isAtOrUnder(attachment.path, path))
          : prev
      )
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

  /** 编辑器标签：在资源管理器视图中显示 —— 确保文件树可见、激活对应标签并下发定位请求 */
  const handleRevealInTree = useCallback(
    (path: string): void => {
      setSidebarVisible(true)
      // 文件树的选中态受控于当前激活文件：先激活对应标签，展开定位时目标行才会高亮选中
      activate(path)
      setRevealRequest((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }))
    },
    [activate]
  )

  const handleSidebarResizeStart = useCallback((): void => {
    // 收起状态下从 0 开始计算，向右拖拽即重新展开
    dragStartSizeRef.current = sidebarVisible ? sidebarWidth : 0
  }, [sidebarVisible, sidebarWidth])

  const handleSidebarResize = useCallback(
    (offsetX: number): void => {
      const target = dragStartSizeRef.current + offsetX
      if (target < SIDEBAR_HIDE_WIDTH) {
        // 拖到最小宽度的一半以下：立即收起（继续右拖可再拽出来）
        setSidebarVisible(false)
        return
      }
      setSidebarVisible(true)
      setSidebarWidth(clamp(target, SIDEBAR_MIN_WIDTH, sidebarMaxWidth()))
    },
    [sidebarMaxWidth]
  )

  const handleAiPanelResizeStart = useCallback((): void => {
    // 收起状态下从 0 开始计算，向左拖拽即重新展开
    dragStartSizeRef.current = aiPanelVisible ? aiPanelWidth : 0
  }, [aiPanelVisible, aiPanelWidth])

  const handleAiPanelResize = useCallback(
    (offsetX: number): void => {
      // 分隔条向右拖动（offsetX > 0）时右侧边栏变窄
      const target = dragStartSizeRef.current - offsetX
      if (target < AI_PANEL_HIDE_WIDTH) {
        // 拖到最小宽度的一半以下：立即收起（继续左拖可再拽出来）
        setAiPanelVisible(false)
        return
      }
      if (!aiPanelVisible) {
        // 从收起状态拖出面板与标题栏打开等价：没有会话时自动建一个
        ensureAiSession()
      }
      setAiPanelVisible(true)
      setAiPanelWidth(clamp(target, AI_PANEL_MIN_WIDTH, aiPanelMaxWidth()))
    },
    [aiPanelVisible, aiPanelMaxWidth, ensureAiSession]
  )

  /** 展开命令行面板：首次展开按编辑器区 1/4 初始化高度，之后沿用上次的高度 */
  const openTerminal = useCallback((): void => {
    setTerminalHeight((prev) => prev ?? terminalMinHeight())
    setTerminalVisible(true)
  }, [terminalMinHeight])

  const closeTerminal = useCallback((): void => {
    setTerminalVisible(false)
  }, [])

  /** 切换 AI 侧边栏显隐（标题栏按钮与全局快捷键共用）；打开时若无会话则自动新建一个 */
  const toggleAiPanel = useCallback((): void => {
    const nextVisible = !aiPanelVisible
    setAiPanelVisible(nextVisible)
    if (nextVisible) {
      ensureAiSession()
    }
  }, [aiPanelVisible, ensureAiSession])

  const toggleTerminal = useCallback((): void => {
    if (terminalVisible) {
      closeTerminal()
    } else {
      openTerminal()
    }
  }, [terminalVisible, closeTerminal, openTerminal])

  /** 切换系统配置页（标题栏设置按钮与设置页返回按钮共用） */
  const toggleSettings = useCallback((): void => {
    setSettingsOpen((prev) => !prev)
  }, [])

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false)
  }, [])

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
  // 捕获阶段拦截（capture），避免被 Monaco / xterm 先行消费；
  // 系统配置页打开时让出键盘，避免误触工作区面板
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (settingsOpen) {
        return
      }
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
  }, [toggleTerminal, handleNewTerminal, toggleAiPanel, settingsOpen])

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        projectPath={projectPath}
        recentProjects={recentProjects}
        themeId={themeId}
        terminalVisible={terminalVisible}
        aiPanelVisible={aiPanelVisible}
        settingsOpen={settingsOpen}
        onOpenFolder={handleOpenProject}
        onCloseFolder={handleCloseProject}
        onOpenRecent={(path) => openProjectPath(path)}
        onThemeChange={setThemeId}
        onNewTerminal={handleNewTerminal}
        onToggleAiPanel={toggleAiPanel}
        onToggleSettings={toggleSettings}
      />
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={workspaceRef}
          className={cn('flex min-h-0 flex-1', settingsOpen && 'invisible')}
          aria-hidden={settingsOpen}
        >
          {/* 文件树保持挂载：拖拽收起后其展开状态与已加载节点不丢 */}
          <aside
            className={cn(
              'shrink-0 flex-col border-r border-line bg-elevated',
              sidebarVisible ? 'flex' : 'hidden'
            )}
            style={{ width: sidebarWidth }}
          >
            {projectPath ? (
              <FileTree
                key={projectPath}
                rootPath={projectPath}
                selectedPath={activePath}
                dirtyPaths={dirtyPaths}
                refreshToken={fsRefreshToken}
                revealRequest={revealRequest}
                onSelectFile={openFileByPath}
                onBeforeEntryMove={handleBeforeEntryMove}
                onEntryMoved={handleEntryMoved}
                onEntryDeleted={handleEntryDeleted}
                onSendToAi={handleAttachPathToAi}
              />
            ) : (
              <p className="mx-3 my-4 leading-[1.6] text-dim">
                通过菜单栏「文件 → 打开文件夹」选择代码目录
              </p>
            )}
          </aside>
          {/* 分隔条常驻：文件树收起后仍可向右拖出 */}
          <ResizeHandle
            label={sidebarVisible ? '调整文件树宽度' : '向右拖拽展开文件树'}
            collapsed={!sidebarVisible}
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
                  projectPath={projectPath}
                  onReveal={handleRevealInTree}
                  onSendToAi={handleAttachTabToAi}
                />
              ) : null}
              <CodeEditor
                ref={editorRef}
                file={activeFile}
                onDirtyChange={handleDirtyChange}
                onSendSelectionToAi={attachToAi}
              />
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
          {/* 分隔条常驻：AI 边栏收起后仍可向左拖出 */}
          <ResizeHandle
            label={aiPanelVisible ? '调整 AI 助手宽度' : '向左拖拽展开 AI 助手'}
            collapsed={!aiPanelVisible}
            onResizeStart={handleAiPanelResizeStart}
            onResize={handleAiPanelResize}
          />
          {aiPanelVisible ? (
            <AiSidebar
              width={aiPanelWidth}
              sessions={aiSessions}
              cwd={projectPath}
              attachments={aiAttachments}
              onRemoveAttachment={handleRemoveAiAttachment}
              onAttachmentsSent={clearAiAttachments}
              onOpenFile={openFileByPath}
            />
          ) : null}
        </div>
        {settingsOpen ? (
          <div className="absolute inset-0 z-20 flex bg-base">
            <SettingsPage onClose={closeSettings} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default App
