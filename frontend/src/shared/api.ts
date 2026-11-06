/**
 * preload 暴露给渲染进程的 API 契约（window.api）。
 * 这里只声明“渲染进程能调用什么”，形状必须与 preload/index.ts 里的实现对象一致；
 * 各域的数据结构放在同级目录的 xxx/types.ts，通道名放在各自的 events.ts。
 */
import type { AiAPI } from './ai/types'
import type { AiRuntimeSettings } from './ai/settings'
import type { FileEntry, SearchResult } from './files/types'
import type {
  ModelConfig,
  ModelConfigInput,
  ModelImportResult,
  RemoteModelListRequest
} from './model-config/types'
import type { TerminalDataEvent, TerminalExitEvent } from './terminal/types'
import type { EditorTabsSnapshot, RecentProject } from './workspace/types'

/** 经 preload contextBridge 暴露给渲染进程的能力（白名单方法） */
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
  /** 在系统文件资源管理器中打开所在目录并选中该条目；路径不存在时报错 */
  revealEntry: (targetPath: string) => Promise<void>
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
  /** 读取全部模型配置（按创建时间倒序） */
  listModelConfigs: () => Promise<ModelConfig[]>
  /** 新建模型配置，返回落库后的完整记录 */
  createModelConfig: (input: ModelConfigInput) => Promise<ModelConfig>
  /** 更新指定模型配置，返回更新后的完整记录 */
  updateModelConfig: (id: number, input: ModelConfigInput) => Promise<ModelConfig>
  /** 删除模型配置（主进程弹出确认框）；用户取消时返回 false */
  deleteModelConfig: (id: number) => Promise<boolean>
  /**
   * 拉取远程模型列表并归一化为待导入的模型配置：
   * id → 模型名称，name → 模型显示名称，owned_by → 供应商，Bearer 之后的内容 → API Key。
   */
  fetchRemoteModels: (request: RemoteModelListRequest) => Promise<ModelConfigInput[]>
  /** 批量导入模型配置（单事务，跳过已存在的地址 + 模型名称） */
  importModelConfigs: (inputs: ModelConfigInput[]) => Promise<ModelImportResult>
  /** 读取 AI 运行参数（步数预算、续接段数、重复调用保护） */
  getAiRuntimeSettings: () => Promise<AiRuntimeSettings>
  /** 保存 AI 运行参数，返回校验并落库后的结果 */
  saveAiRuntimeSettings: (input: AiRuntimeSettings) => Promise<AiRuntimeSettings>
  /** 最近项目列表（MRU，最多 5 个），供「文件」菜单展示 */
  listRecentProjects: () => Promise<RecentProject[]>
  /** 记录一个刚打开的项目：更新 MRU 并作为下次启动的默认打开项 */
  recordProjectOpened: (path: string) => Promise<void>
  /** 手动关闭文件夹：清除该项目启动恢复项与页签快照（MRU 历史保留） */
  clearRestoreProject: (path: string) => Promise<void>
  /** 上次未手动关闭的项目路径（目录已不存在时返回 null），供启动自动打开 */
  getLastProject: () => Promise<string | null>
  /** 保存某项目当前未关闭的编辑器页签快照（供重启恢复） */
  saveOpenTabs: (path: string, snapshot: EditorTabsSnapshot) => Promise<void>
  /** 读取某项目上次未手动关闭的编辑器页签快照（无记录时返回 null） */
  getOpenTabs: (path: string) => Promise<EditorTabsSnapshot | null>
  /** AI 助手通道：会话、流式事件与中止 */
  ai: AiAPI
}
