/** 主进程与渲染进程共享的类型定义 */

/** 目录单层条目（文件树懒加载的数据源） */
export interface FileEntry {
  /** 条目名称（不含路径） */
  name: string
  /** 绝对路径（同时作为文件树节点唯一标识） */
  path: string
  /** 是否为目录 */
  isDirectory: boolean
}

/** 文件搜索（按名称子串匹配）的结果 */
export interface SearchResult {
  /** 命中的条目（目录与文件） */
  entries: FileEntry[]
  /** 结果是否因达到上限被截断 */
  truncated: boolean
}

/** 终端会话输出事件：pty 产生增量文本时由主进程推送给渲染进程 */
export interface TerminalDataEvent {
  /** 会话 id（createTerminal 的返回值） */
  id: number
  /** 增量输出（可能包含 ANSI 转义序列） */
  data: string
}

/** 终端会话退出事件：shell 进程结束时推送 */
export interface TerminalExitEvent {
  /** 会话 id */
  id: number
  /** 进程退出码 */
  exitCode: number
}

/** 经 preload contextBridge 暴露给渲染进程的文件系统能力（白名单方法） */
export interface ScoderAPI {
  /** 弹出系统目录选择框；用户取消时返回 null */
  openProjectDirectory: () => Promise<string | null>
  /** 读取目录单层内容（目录在前、名称升序），供文件树懒加载 */
  readDirectory: (dirPath: string) => Promise<FileEntry[]>
  /** 读取文本文件内容；二进制或超大文件会抛错 */
  readFile: (filePath: string) => Promise<string>
  /** 将文本写入文件（utf-8 覆盖写入），供编辑器保存 */
  writeFile: (filePath: string, content: string) => Promise<void>
  /** 在 dirPath 下创建空文件（isDirectory 为 false）或空目录，返回新建条目；名称非法或已存在时报错 */
  createEntry: (dirPath: string, name: string, isDirectory: boolean) => Promise<FileEntry>
  /** 重命名/拖拽移动文件或目录到目标绝对路径；目标已存在时报错 */
  moveEntry: (sourcePath: string, targetPath: string) => Promise<void>
  /** 删除文件或目录（目录递归删除）；弹出确认框，用户取消时返回 false */
  deleteEntry: (targetPath: string) => Promise<boolean>
  /** 以 rootPath 为根递归搜索名称包含关键词的条目（跳过噪音目录），最多返回 limit 条 */
  searchFiles: (rootPath: string, query: string, limit?: number) => Promise<SearchResult>
  /** 创建终端会话（在 cwd 中启动系统 shell，cwd 为 null 时用用户主目录），返回会话 id */
  createTerminal: (cwd: string | null, cols: number, rows: number) => Promise<number>
  /** 向终端会话写入用户输入（fire-and-forget，不等待回执） */
  writeTerminal: (id: number, data: string) => void
  /** 调整终端会话的列数/行数（pty 会向 shell 发送窗口变化信号） */
  resizeTerminal: (id: number, cols: number, rows: number) => void
  /** 销毁终端会话（杀死 shell 进程） */
  disposeTerminal: (id: number) => Promise<void>
  /** 订阅终端输出事件；返回取消订阅函数 */
  onTerminalData: (callback: (event: TerminalDataEvent) => void) => () => void
  /** 订阅终端退出事件；返回取消订阅函数 */
  onTerminalExit: (callback: (event: TerminalExitEvent) => void) => () => void
  /** 最小化当前窗口 */
  windowMinimize: () => void
  /** 在当前窗口的最大化/还原状态间切换 */
  windowToggleMaximize: () => void
  /** 关闭当前窗口 */
  windowClose: () => void
  /** 查询当前窗口是否处于最大化状态，供标题栏按钮图标初始化 */
  isWindowMaximized: () => Promise<boolean>
  /** 订阅窗口最大化状态变化（最大化/还原时由主进程推送）；返回取消订阅函数 */
  onWindowMaximizeChange: (callback: (maximized: boolean) => void) => () => void
}
