import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { AI_CHANNELS } from '../shared/ai/events'
import { AI_RUNTIME_CHANNELS, type AiRuntimeSettings } from '../shared/ai/settings'
import type { AiAPI, AiEventEnvelope, AiFileReview, AiSendRequest } from '../shared/ai/types'
import type { ScoderAPI } from '../shared/api'
import { APP_CHANNELS } from '../shared/app/events'
import { FILES_CHANNELS } from '../shared/files/events'
import { GIT_CHANNELS } from '../shared/git/events'
import { GIT_SETTINGS_CHANNELS } from '../shared/git/settings'
import type { GitSettings } from '../shared/git/settings'
import type { GitStatusSnapshot } from '../shared/git/types'
import type {
  DirectoriesChangedEvent,
  FilesChangedEvent,
  ContentSearchMatch,
  SearchOptions
} from '../shared/files/types'
import type { TextEncodingId } from '../shared/files/encoding'
import { FILE_SETTINGS_CHANNELS } from '../shared/files/settings'
import type { FileSettings } from '../shared/files/settings'
import { MODEL_CONFIG_CHANNELS } from '../shared/model-config/events'
import type { ModelConfigInput, RemoteModelListRequest } from '../shared/model-config/types'
import { MCP_CHANNELS } from '../shared/mcp/events'
import type { McpServerInput, McpServerView } from '../shared/mcp/types'
import { TERMINAL_CHANNELS } from '../shared/terminal/events'
import { TERMINAL_SETTINGS_CHANNELS, type TerminalSettings } from '../shared/terminal/settings'
import type { TerminalDataEvent, TerminalExitEvent } from '../shared/terminal/types'
import { THEME_CHANNELS } from '../shared/theme/events'
import type { ThemeImportResult } from '../shared/theme/types'
import { WINDOW_CHANNELS } from '../shared/window/events'
import { WORKSPACE_CHANNELS } from '../shared/workspace/events'
import type { EditorTabsSnapshot } from '../shared/workspace/types'

// AI 通道：只做转发，不在渲染进程做任何权限判断（审批与工作区边界都在主进程）
const ai: AiAPI = {
  send: (request: AiSendRequest) => ipcRenderer.invoke(AI_CHANNELS.send, request),
  abort: (sessionId: string) => ipcRenderer.send(AI_CHANNELS.abort, sessionId),
  respondApproval: (requestId: string, approved: boolean) =>
    ipcRenderer.send(AI_CHANNELS.approval, requestId, approved),
  onEvent: (listener: (payload: AiEventEnvelope) => void) => {
    const handler = (_event: IpcRendererEvent, payload: AiEventEnvelope): void => listener(payload)
    ipcRenderer.on(AI_CHANNELS.event, handler)
    return () => ipcRenderer.removeListener(AI_CHANNELS.event, handler)
  },
  // 会话元数据：文件在主进程的 userData/sessions 下，渲染进程只拿摘要与写标题
  listSessions: (cwd: string) => ipcRenderer.invoke(AI_CHANNELS.listSessions, cwd),
  loadMessages: (cwd: string, sessionId: string) =>
    ipcRenderer.invoke(AI_CHANNELS.loadMessages, cwd, sessionId),
  readChangeBaseline: (cwd: string, sessionId: string, turn: number, path: string) =>
    ipcRenderer.invoke(AI_CHANNELS.readChangeBaseline, cwd, sessionId, turn, path),
  saveChangeBaseline: (
    cwd: string,
    sessionId: string,
    turn: number,
    path: string,
    before: string
  ) => ipcRenderer.invoke(AI_CHANNELS.saveChangeBaseline, cwd, sessionId, turn, path, before),
  readReviews: (cwd: string, sessionId: string) =>
    ipcRenderer.invoke(AI_CHANNELS.readReviews, cwd, sessionId),
  saveReview: (cwd: string, sessionId: string, review: AiFileReview) =>
    ipcRenderer.invoke(AI_CHANNELS.saveReview, cwd, sessionId, review),
  deleteSession: (cwd: string, id: string) =>
    ipcRenderer.invoke(AI_CHANNELS.deleteSession, cwd, id),
  updateSessionTitle: (cwd: string, id: string, title: string, autoTitle: boolean) =>
    ipcRenderer.invoke(AI_CHANNELS.updateSessionTitle, cwd, id, title, autoTitle),
  exportSession: (cwd: string, id: string) =>
    ipcRenderer.invoke(AI_CHANNELS.exportSession, cwd, id),
  exportSessions: (cwd: string, ids: string[]) =>
    ipcRenderer.invoke(AI_CHANNELS.exportSessions, cwd, ids)
}

// Custom APIs for renderer
// 仅暴露白名单方法：渲染进程通过 invoke 调用主进程注册的 IPC handler
const api: ScoderAPI = {
  openProjectDirectory: () => ipcRenderer.invoke(FILES_CHANNELS.openProjectDirectory),
  readDirectory: (dirPath: string) => ipcRenderer.invoke(FILES_CHANNELS.readDirectory, dirPath),
  readFile: (filePath: string, encoding?: TextEncodingId) =>
    ipcRenderer.invoke(FILES_CHANNELS.readFile, filePath, encoding),
  readFileBytes: (filePath: string) => ipcRenderer.invoke(FILES_CHANNELS.readFileBytes, filePath),
  // 文本流：主进程负责句柄、编码探测与跨块解码，渲染进程逐块灌入 model
  openTextStream: (filePath: string, encoding?: TextEncodingId) =>
    ipcRenderer.invoke(FILES_CHANNELS.openTextStream, filePath, encoding),
  readTextStreamChunk: (streamId: string) =>
    ipcRenderer.invoke(FILES_CHANNELS.readTextStreamChunk, streamId),
  closeTextStream: (streamId: string) =>
    ipcRenderer.invoke(FILES_CHANNELS.closeTextStream, streamId),
  // 写入流：大文件分块保存，主进程按当前编码写入临时文件并原子替换
  openWriteStream: (filePath: string, encoding?: TextEncodingId) =>
    ipcRenderer.invoke(FILES_CHANNELS.openWriteStream, filePath, encoding),
  appendWriteChunk: (writeId: string, text: string) =>
    ipcRenderer.invoke(FILES_CHANNELS.appendWriteChunk, writeId, text),
  finishWriteStream: (writeId: string) =>
    ipcRenderer.invoke(FILES_CHANNELS.finishWriteStream, writeId),
  abortWriteStream: (writeId: string) =>
    ipcRenderer.invoke(FILES_CHANNELS.abortWriteStream, writeId),
  // 文件观测：大小与二进制判定，供编辑器给出超限提示
  statFile: (filePath: string) => ipcRenderer.invoke(FILES_CHANNELS.statFile, filePath),
  // 文件限制：与 AI 运行参数一样落在主进程的 app_settings 表
  getFileSettings: () => ipcRenderer.invoke(FILE_SETTINGS_CHANNELS.get),
  saveFileSettings: (input: FileSettings) => ipcRenderer.invoke(FILE_SETTINGS_CHANNELS.save, input),
  createEntry: (dirPath: string, name: string, isDirectory: boolean) =>
    ipcRenderer.invoke(FILES_CHANNELS.createEntry, dirPath, name, isDirectory),
  moveEntry: (sourcePath: string, targetPath: string) =>
    ipcRenderer.invoke(FILES_CHANNELS.moveEntry, sourcePath, targetPath),
  deleteEntry: (targetPath: string) => ipcRenderer.invoke(FILES_CHANNELS.deleteEntry, targetPath),
  revealEntry: (targetPath: string) => ipcRenderer.invoke(FILES_CHANNELS.revealEntry, targetPath),
  searchFiles: (rootPath: string, query: string, limit?: number, options?: SearchOptions) =>
    ipcRenderer.invoke(FILES_CHANNELS.searchFiles, rootPath, query, limit, options),
  searchFileContents: (rootPath: string, query: string, options: SearchOptions) =>
    ipcRenderer.invoke(FILES_CHANNELS.searchFileContents, rootPath, query, options),
  replaceFileContents: (
    rootPath: string,
    query: string,
    replacement: string,
    options: SearchOptions,
    matches: ContentSearchMatch[]
  ) =>
    ipcRenderer.invoke(
      FILES_CHANNELS.replaceFileContents,
      rootPath,
      query,
      replacement,
      options,
      matches
    ),
  // 目录监听：同步已加载目录（全量替换），条目变化由主进程推送
  setWatchedDirectories: (dirs: string[]) =>
    ipcRenderer.invoke(FILES_CHANNELS.setWatchedDirectories, dirs),
  clearWatchedDirectories: () => ipcRenderer.invoke(FILES_CHANNELS.clearWatchedDirectories),
  onDirectoriesChanged: (callback: (event: DirectoriesChangedEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: DirectoriesChangedEvent): void =>
      callback(payload)
    ipcRenderer.on(FILES_CHANNELS.directoriesChanged, listener)
    return () => ipcRenderer.removeListener(FILES_CHANNELS.directoriesChanged, listener)
  },
  // 文件监听：同步编辑器已打开（已缓存）的文件，内容变化由主进程推送
  setWatchedFiles: (paths: string[]) => ipcRenderer.invoke(FILES_CHANNELS.setWatchedFiles, paths),
  onFilesChanged: (callback: (event: FilesChangedEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: FilesChangedEvent): void =>
      callback(payload)
    ipcRenderer.on(FILES_CHANNELS.filesChanged, listener)
    return () => ipcRenderer.removeListener(FILES_CHANNELS.filesChanged, listener)
  },
  createTerminal: (cwd: string | null, cols: number, rows: number) =>
    ipcRenderer.invoke(TERMINAL_CHANNELS.create, cwd, cols, rows),
  // 键入与尺寸调整走单向 send：高频且无需等待主进程回执
  writeTerminal: (id: number, data: string) => ipcRenderer.send(TERMINAL_CHANNELS.write, id, data),
  resizeTerminal: (id: number, cols: number, rows: number) =>
    ipcRenderer.send(TERMINAL_CHANNELS.resize, id, cols, rows),
  disposeTerminal: (id: number) => ipcRenderer.invoke(TERMINAL_CHANNELS.dispose, id),
  onTerminalData: (callback: (event: TerminalDataEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: TerminalDataEvent): void =>
      callback(payload)
    ipcRenderer.on(TERMINAL_CHANNELS.data, listener)
    return () => ipcRenderer.removeListener(TERMINAL_CHANNELS.data, listener)
  },
  onTerminalExit: (callback: (event: TerminalExitEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: TerminalExitEvent): void =>
      callback(payload)
    ipcRenderer.on(TERMINAL_CHANNELS.exit, listener)
    return () => ipcRenderer.removeListener(TERMINAL_CHANNELS.exit, listener)
  },
  // 终端设置：设置页自动探测 PowerShell 7 并预填路径，选择/测试都由主进程完成
  getTerminalSettings: () => ipcRenderer.invoke(TERMINAL_SETTINGS_CHANNELS.get),
  saveTerminalSettings: (input: TerminalSettings) =>
    ipcRenderer.invoke(TERMINAL_SETTINGS_CHANNELS.save, input),
  detectPowerShellPath: () => ipcRenderer.invoke(TERMINAL_SETTINGS_CHANNELS.detect),
  testPowerShellPath: (filePath: string) =>
    ipcRenderer.invoke(TERMINAL_SETTINGS_CHANNELS.test, filePath),
  openPowerShellDownload: () => ipcRenderer.invoke(TERMINAL_SETTINGS_CHANNELS.openDownload),
  // Git 设置：默认自动探测 PATH 上的 git，用户可指定可执行文件并测试版本
  getGitSettings: () => ipcRenderer.invoke(GIT_SETTINGS_CHANNELS.get),
  saveGitSettings: (input: GitSettings) => ipcRenderer.invoke(GIT_SETTINGS_CHANNELS.save, input),
  detectGitPath: () => ipcRenderer.invoke(GIT_SETTINGS_CHANNELS.detect),
  testGitPath: (filePath: string) => ipcRenderer.invoke(GIT_SETTINGS_CHANNELS.test, filePath),
  // Git 状态：主进程按固定间隔自动检测，只在变化时推送
  watchGitStatus: (root: string) => ipcRenderer.invoke(GIT_CHANNELS.watchStatus, root),
  refreshGitStatus: () => ipcRenderer.invoke(GIT_CHANNELS.refreshStatus),
  unwatchGitStatus: () => ipcRenderer.invoke(GIT_CHANNELS.unwatchStatus),
  onGitStatusChanged: (callback: (event: GitStatusSnapshot) => void) => {
    const listener = (_event: IpcRendererEvent, payload: GitStatusSnapshot): void =>
      callback(payload)
    ipcRenderer.on(GIT_CHANNELS.statusChanged, listener)
    return () => ipcRenderer.removeListener(GIT_CHANNELS.statusChanged, listener)
  },
  // 窗口控制：动作类走单向 send；最大化状态需回查与订阅，供无边框标题栏切换图标
  windowMinimize: () => ipcRenderer.send(WINDOW_CHANNELS.minimize),
  windowToggleMaximize: () => ipcRenderer.send(WINDOW_CHANNELS.toggleMaximize),
  windowClose: () => ipcRenderer.send(WINDOW_CHANNELS.close),
  isWindowMaximized: () => ipcRenderer.invoke(WINDOW_CHANNELS.isMaximized),
  onWindowMaximizeChange: (callback: (maximized: boolean) => void) => {
    const listener = (_event: IpcRendererEvent, maximized: boolean): void => callback(maximized)
    ipcRenderer.on(WINDOW_CHANNELS.maximizeChange, listener)
    return () => ipcRenderer.removeListener(WINDOW_CHANNELS.maximizeChange, listener)
  },
  // 模型配置：持久化在本地 SQLite（设置页与后续 AI 请求共用）
  listModelConfigs: () => ipcRenderer.invoke(MODEL_CONFIG_CHANNELS.list),
  createModelConfig: (input: ModelConfigInput) =>
    ipcRenderer.invoke(MODEL_CONFIG_CHANNELS.create, input),
  updateModelConfig: (id: number, input: ModelConfigInput) =>
    ipcRenderer.invoke(MODEL_CONFIG_CHANNELS.update, id, input),
  deleteModelConfig: (id: number) => ipcRenderer.invoke(MODEL_CONFIG_CHANNELS.delete, id),
  deleteAllModelConfigs: () => ipcRenderer.invoke(MODEL_CONFIG_CHANNELS.deleteAll),
  // 一键导入：拉取远程模型列表、批量落库都由主进程完成
  fetchRemoteModels: (request: RemoteModelListRequest) =>
    ipcRenderer.invoke(MODEL_CONFIG_CHANNELS.fetchRemote, request),
  importModelConfigs: (inputs: ModelConfigInput[]) =>
    ipcRenderer.invoke(MODEL_CONFIG_CHANNELS.importMany, inputs),
  // 记住上次成功导入的连接信息，下次打开导入页时回填
  getModelImportForm: () => ipcRenderer.invoke(MODEL_CONFIG_CHANNELS.getImportForm),
  saveModelImportForm: (form: RemoteModelListRequest) =>
    ipcRenderer.invoke(MODEL_CONFIG_CHANNELS.saveImportForm, form),
  // 对话框选中的模型：与最近项目一样落库，下次打开时恢复
  getSelectedModelConfigId: () => ipcRenderer.invoke(MODEL_CONFIG_CHANNELS.getSelected),
  saveSelectedModelConfigId: (id: number) =>
    ipcRenderer.invoke(MODEL_CONFIG_CHANNELS.saveSelected, id),
  // AI 运行参数：设置页读写，主进程在每轮对话开始时重新读取
  getAiRuntimeSettings: () => ipcRenderer.invoke(AI_RUNTIME_CHANNELS.get),
  saveAiRuntimeSettings: (input: AiRuntimeSettings) =>
    ipcRenderer.invoke(AI_RUNTIME_CHANNELS.save, input),
  // MCP 服务端：配置落在主进程 SQLite，连接与工具由主进程持有
  listMcpServers: () => ipcRenderer.invoke(MCP_CHANNELS.list),
  createMcpServer: (input: McpServerInput) => ipcRenderer.invoke(MCP_CHANNELS.create, input),
  updateMcpServer: (id: number, input: McpServerInput) =>
    ipcRenderer.invoke(MCP_CHANNELS.update, id, input),
  deleteMcpServer: (id: number) => ipcRenderer.invoke(MCP_CHANNELS.delete, id),
  setMcpServerEnabled: (id: number, enabled: boolean) =>
    ipcRenderer.invoke(MCP_CHANNELS.setEnabled, id, enabled),
  probeMcpServer: (id: number) => ipcRenderer.invoke(MCP_CHANNELS.probe, id),
  restartMcpServer: (id: number) => ipcRenderer.invoke(MCP_CHANNELS.restart, id),
  // 状态推送：连接中/已连接/重试中/失败，单条服务端粒度
  onMcpServerStatus: (callback: (view: McpServerView) => void) => {
    const listener = (_event: IpcRendererEvent, view: McpServerView): void => callback(view)
    ipcRenderer.on(MCP_CHANNELS.status, listener)
    return () => ipcRenderer.removeListener(MCP_CHANNELS.status, listener)
  },
  // 应用信息与官方仓库跳转：关于页展示版本号，点击地址交给系统浏览器
  getAppInfo: () => ipcRenderer.invoke(APP_CHANNELS.getInfo),
  openRepository: () => ipcRenderer.invoke(APP_CHANNELS.openRepository),
  // 导入主题：解析与文件落盘在主进程，渲染进程只拿转换后的 Monaco 主题数据
  listImportedThemes: () => ipcRenderer.invoke(THEME_CHANNELS.listImported),
  importThemes: (): Promise<ThemeImportResult> => ipcRenderer.invoke(THEME_CHANNELS.importThemes),
  deleteImportedTheme: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(THEME_CHANNELS.deleteImported, id),
  // 工作区最近项目 / 启动恢复：均走 invoke 拿主进程落库结果
  listRecentProjects: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.listRecent),
  recordProjectOpened: (path: string) => ipcRenderer.invoke(WORKSPACE_CHANNELS.recordOpened, path),
  clearRestoreProject: (path: string) => ipcRenderer.invoke(WORKSPACE_CHANNELS.clearRestore, path),
  getLastProject: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.getLastProject),
  saveOpenTabs: (path: string, snapshot: EditorTabsSnapshot) =>
    ipcRenderer.invoke(WORKSPACE_CHANNELS.saveOpenTabs, path, snapshot),
  getOpenTabs: (path: string) => ipcRenderer.invoke(WORKSPACE_CHANNELS.getOpenTabs, path),
  ai
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
