import { ipcMain } from 'electron'
import { MODEL_CONFIG_CHANNELS } from '../../shared/model-config/events'
import type {
  ModelConfigInput,
  ModelImportResult,
  RemoteModelListRequest
} from '../../shared/model-config/types'
import { createModelConfigs } from '../db'
import { fetchRemoteModels } from './remote'

/**
 * 注册「一键导入模型」相关通道。
 * 拉取列表在主进程完成（渲染进程会被 CORS 拦住），
 * 导入落库复用 db 仓储的批量写入，重复的「地址 + 模型名称」自动跳过。
 */
export function registerModelImportHandlers(): void {
  ipcMain.handle(
    MODEL_CONFIG_CHANNELS.fetchRemote,
    (_event, request: RemoteModelListRequest): Promise<ModelConfigInput[]> =>
      fetchRemoteModels(request)
  )

  ipcMain.handle(
    MODEL_CONFIG_CHANNELS.importMany,
    (_event, inputs: ModelConfigInput[]): ModelImportResult => {
      const created = createModelConfigs(inputs)
      return { created, skipped: inputs.length - created.length }
    }
  )
}
