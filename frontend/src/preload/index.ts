import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ModelConfigInput,
  ScoderAPI,
  TerminalDataEvent,
  TerminalExitEvent
} from '../shared/types'

// Custom APIs for renderer
// 仅暴露白名单方法：渲染进程通过 invoke 调用主进程注册的 IPC handler
const api: ScoderAPI = {
  openProjectDirectory: () => ipcRenderer.invoke('dialog:openProjectDirectory'),
  readDirectory: (dirPath: string) => ipcRenderer.invoke('fs:readDirectory', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('fs:writeFile', filePath, content),
  createEntry: (dirPath: string, name: string, isDirectory: boolean) =>
    ipcRenderer.invoke('fs:createEntry', dirPath, name, isDirectory),
  moveEntry: (sourcePath: string, targetPath: string) =>
    ipcRenderer.invoke('fs:moveEntry', sourcePath, targetPath),
  deleteEntry: (targetPath: string) => ipcRenderer.invoke('fs:deleteEntry', targetPath),
  searchFiles: (rootPath: string, query: string, limit?: number) =>
    ipcRenderer.invoke('fs:searchFiles', rootPath, query, limit),
  createTerminal: (cwd: string | null, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:create', cwd, cols, rows),
  // 键入与尺寸调整走单向 send：高频且无需等待主进程回执
  writeTerminal: (id: number, data: string) => ipcRenderer.send('terminal:write', id, data),
  resizeTerminal: (id: number, cols: number, rows: number) =>
    ipcRenderer.send('terminal:resize', id, cols, rows),
  disposeTerminal: (id: number) => ipcRenderer.invoke('terminal:dispose', id),
  onTerminalData: (callback: (event: TerminalDataEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: TerminalDataEvent): void =>
      callback(payload)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onTerminalExit: (callback: (event: TerminalExitEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: TerminalExitEvent): void =>
      callback(payload)
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  },
  // 窗口控制：动作类走单向 send；最大化状态需回查与订阅，供无边框标题栏切换图标
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximizeChange: (callback: (maximized: boolean) => void) => {
    const listener = (_event: IpcRendererEvent, maximized: boolean): void => callback(maximized)
    ipcRenderer.on('window:maximizeChange', listener)
    return () => ipcRenderer.removeListener('window:maximizeChange', listener)
  },
  // 模型配置：持久化在本地 SQLite（设置页与后续 AI 请求共用）
  listModelConfigs: () => ipcRenderer.invoke('modelConfig:list'),
  createModelConfig: (input: ModelConfigInput) => ipcRenderer.invoke('modelConfig:create', input),
  updateModelConfig: (id: number, input: ModelConfigInput) =>
    ipcRenderer.invoke('modelConfig:update', id, input),
  deleteModelConfig: (id: number) => ipcRenderer.invoke('modelConfig:delete', id)
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
