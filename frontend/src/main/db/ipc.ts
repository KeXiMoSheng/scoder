import { BrowserWindow, dialog, ipcMain, type MessageBoxOptions } from 'electron'
import { MODEL_CONFIG_CHANNELS } from '../../shared/model-config/events'
import type { ModelConfig, ModelConfigInput } from '../../shared/model-config/types'
import {
  createModelConfig,
  deleteModelConfig,
  findModelConfigById,
  listModelConfigs,
  updateModelConfig
} from './model-configs'

/**
 * 向渲染进程提供模型配置的读取与增删改（白名单 IPC）。
 * 这一层只做三件事：接收参数、处理需要窗口的交互（确认框）、转发给仓储；
 * 数据规则与 SQL 都在 model-configs.ts，便于脱离 Electron 单测。
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
