import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { AI_CHANNELS } from '../shared/ai/events'
import type { AiAPI, AiEvent, AiSendRequest } from '../shared/ai/types'
import type { ScoderAPI } from '../shared/api'
import { FILES_CHANNELS } from '../shared/files/events'
import { MODEL_CONFIG_CHANNELS } from '../shared/model-config/events'
import type { ModelConfigInput } from '../shared/model-config/types'
import { TERMINAL_CHANNELS } from '../shared/terminal/events'
import type { TerminalDataEvent, TerminalExitEvent } from '../shared/terminal/types'
import { WINDOW_CHANNELS } from '../shared/window/events'

// AI 通道：只做转发，不在渲染进程做任何权限判断（审批与工作区边界都在主进程）
const ai: AiAPI = {
  send: (request: AiSendRequest) => ipcRenderer.invoke(AI_CHANNELS.send, request),
  abort: (sessionId: string) => ipcRenderer.send(AI_CHANNELS.abort, sessionId),
  respondApproval: (requestId: string, approved: boolean) =>
    ipcRenderer.send(AI_CHANNELS.approval, requestId, approved),
  onEvent: (listener: (event: AiEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: AiEvent): void => listener(payload)
    ipcRenderer.on(AI_CHANNELS.event, handler)
    return () => ipcRenderer.removeListener(AI_CHANNELS.event, handler)
  }
}

// Custom APIs for renderer
// 仅暴露白名单方法：渲染进程通过 invoke 调用主进程注册的 IPC handler
const api: ScoderAPI = {
  openProjectDirectory: () => ipcRenderer.invoke(FILES_CHANNELS.openProjectDirectory),
  readDirectory: (dirPath: string) => ipcRenderer.invoke(FILES_CHANNELS.readDirectory, dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke(FILES_CHANNELS.readFile, filePath),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke(FILES_CHANNELS.writeFile, filePath, content),
  createEntry: (dirPath: string, name: string, isDirectory: boolean) =>
    ipcRenderer.invoke(FILES_CHANNELS.createEntry, dirPath, name, isDirectory),
  moveEntry: (sourcePath: string, targetPath: string) =>
    ipcRenderer.invoke(FILES_CHANNELS.moveEntry, sourcePath, targetPath),
  deleteEntry: (targetPath: string) => ipcRenderer.invoke(FILES_CHANNELS.deleteEntry, targetPath),
  searchFiles: (rootPath: string, query: string, limit?: number) =>
    ipcRenderer.invoke(FILES_CHANNELS.searchFiles, rootPath, query, limit),
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
