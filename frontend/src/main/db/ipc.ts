import { BrowserWindow, dialog, ipcMain, type MessageBoxOptions } from 'electron'
import { promises as fs } from 'fs'
import { AI_RUNTIME_CHANNELS, type AiRuntimeSettings } from '../../shared/ai/settings'
import { MODEL_CONFIG_CHANNELS } from '../../shared/model-config/events'
import type { ModelConfig, ModelConfigInput } from '../../shared/model-config/types'
import { WORKSPACE_CHANNELS } from '../../shared/workspace/events'
import type { EditorTabsSnapshot, RecentProject } from '../../shared/workspace/types'
import { getAiRuntimeSettings, saveAiRuntimeSettings } from './app-settings'
import {
  clearRestoreProject,
  getLastProjectPath,
  getOpenTabs,
  listRecentProjects,
  recordProjectOpened,
  saveOpenTabs
} from './workspace-projects'
import {
  createModelConfig,
  deleteModelConfig,
  findModelConfigById,
  listModelConfigs,
  updateModelConfig
} from './model-configs'

/**
 * 向渲染进程提供模型配置与应用设置的读写（白名单 IPC）。
 * 这一层只做三件事：接收参数、处理需要窗口的交互（确认框）、转发给仓储；
 * 数据规则与 SQL 都在各自的仓储文件里，便于脱离 Electron 单测。
 */
export function registerDatabaseHandlers(): void {
  ipcMain.handle(MODEL_CONFIG_CHANNELS.list, (): ModelConfig[] => listModelConfigs())

  ipcMain.handle(MODEL_CONFIG_CHANNELS.create, (_event, input: ModelConfigInput): ModelConfig =>
    createModelConfig(input)
  )

  ipcMain.handle(
    MODEL_CONFIG_CHANNELS.update,
    (_event, id: number, input: ModelConfigInput): ModelConfig => updateModelConfig(id, input)
  )

  ipcMain.handle(MODEL_CONFIG_CHANNELS.delete, async (event, id: number): Promise<boolean> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return confirmAndDelete(window, id)
  })

  // AI 运行参数：设置页读写，主进程在每轮对话开始时重新读取
  ipcMain.handle(AI_RUNTIME_CHANNELS.get, (): AiRuntimeSettings => getAiRuntimeSettings())
  ipcMain.handle(AI_RUNTIME_CHANNELS.save, (_event, input: AiRuntimeSettings): AiRuntimeSettings =>
    saveAiRuntimeSettings(input)
  )

  registerWorkspaceHandlers()
}

/**
 * 工作区最近项目 / 启动恢复通道。
 * getLastProject 会校验目录仍然存在：项目被删除或移动时返回 null，
 * 避免启动去打开一个不存在的目录。
 */
function registerWorkspaceHandlers(): void {
  ipcMain.handle(WORKSPACE_CHANNELS.listRecent, (): RecentProject[] => listRecentProjects())

  ipcMain.handle(WORKSPACE_CHANNELS.recordOpened, (_event, path: string): void => {
    recordProjectOpened(path)
  })

  ipcMain.handle(WORKSPACE_CHANNELS.clearRestore, (_event, path: string): void => {
    clearRestoreProject(path)
  })

  ipcMain.handle(
    WORKSPACE_CHANNELS.saveOpenTabs,
    (_event, path: string, snapshot: EditorTabsSnapshot): void => {
      saveOpenTabs(path, snapshot)
    }
  )

  ipcMain.handle(
    WORKSPACE_CHANNELS.getOpenTabs,
    (_event, path: string): EditorTabsSnapshot | null => getOpenTabs(path)
  )

  ipcMain.handle(WORKSPACE_CHANNELS.getLastProject, async (): Promise<string | null> => {
    const path = getLastProjectPath()
    if (!path) {
      return null
    }
    try {
      // 目录必须存在且仍可读，否则放弃本次自动恢复
      const stat = await fs.stat(path)
      return stat.isDirectory() ? path : null
    } catch {
      return null
    }
  })
}

/** 删除前弹系统对话框确认，用户取消时返回 false */
async function confirmAndDelete(window: BrowserWindow | null, id: number): Promise<boolean> {
  // 先读一次：记录不存在时直接抛错，避免弹出无意义的确认框
  const config = findModelConfigById(id)
  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: ['取消', '删除'],
    defaultId: 0,
    cancelId: 0,
    title: '删除确认',
    message: `确定要删除模型「${config.displayName}」吗？`,
    detail: '删除后无法恢复，与之相关的本地数据不会一并删除。'
  }
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  if (result.response !== 1) {
    return false
  }
  deleteModelConfig(id)
  return true
}
