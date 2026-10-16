import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ScoderAPI } from '../shared/types'

// Custom APIs for renderer
// 仅暴露白名单方法：渲染进程通过 invoke 调用主进程注册的 IPC handler
const api: ScoderAPI = {
  openProjectDirectory: () => ipcRenderer.invoke('dialog:openProjectDirectory'),
  readDirectory: (dirPath: string) => ipcRenderer.invoke('fs:readDirectory', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('fs:writeFile', filePath, content),
  moveEntry: (sourcePath: string, targetPath: string) =>
    ipcRenderer.invoke('fs:moveEntry', sourcePath, targetPath),
  deleteEntry: (targetPath: string) => ipcRenderer.invoke('fs:deleteEntry', targetPath),
  searchFiles: (rootPath: string, query: string, limit?: number) =>
    ipcRenderer.invoke('fs:searchFiles', rootPath, query, limit)
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
