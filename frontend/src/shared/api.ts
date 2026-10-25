/**
 * preload 暴露给渲染进程的 API 契约（window.api）。
 * 这里只声明“渲染进程能调用什么”，形状必须与 preload/index.ts 里的实现对象一致；
 * 各域的数据结构放在同级目录的 xxx/types.ts，通道名放在各自的 events.ts。
 */
import type { AiAPI } from './ai/types'
import type { FileEntry, SearchResult } from './files/types'
import type { ModelConfig, ModelConfigInput } from './model-config/types'
import type { TerminalDataEvent, TerminalExitEvent } from './terminal/types'

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
  /** AI 助手通道：会话、流式事件与中止 */
  ai: AiAPI
}
