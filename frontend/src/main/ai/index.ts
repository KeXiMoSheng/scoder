import { ipcMain } from 'electron'
import { isAbsolute } from 'path'
import { AI_CHANNELS } from '../../shared/ai/events'
import type { AiEvent, AiSendRequest } from '../../shared/ai/types'
import { findModelConfigById } from '../db'
import { LocalFileSystem } from './fs/service'
import { runTurn } from './loop/agentLoop'
import { SessionStore } from './session/store'
import { createToolRegistry } from './tools'
import { errorMessage } from './tools/registry'

/** 会话历史（P0 仅进程内；重启即清空） */
const sessions = new SessionStore()

/** 工具注册表：工具本身无状态，整个进程共享一份 */
const registry = createToolRegistry()

/** 正在执行的会话 → 中止控制器 */
const running = new Map<string, AbortController>()

/**
 * 注册 AI 相关的 IPC 通道。
 * 需要在数据库初始化之后调用：模型配置（含 API Key）由主进程读库，
 * 渲染进程只传 modelConfigId，密钥不经过渲染进程。
 */
export function registerAiHandlers(): void {
  ipcMain.handle(AI_CHANNELS.send, (event, request: AiSendRequest): void => {
    // 渲染进程输入一律视为不可信，先校验再落任何状态
    validateRequest(request)
    if (running.has(request.sessionId)) {
      throw new Error('该会话已有一轮对话正在执行')
    }
    const model = findModelConfigById(request.modelConfigId)
    const controller = new AbortController()
    running.set(request.sessionId, controller)

    const emit = (payload: AiEvent): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(AI_CHANNELS.event, payload)
      }
    }
    // 立即返回：本轮进展通过事件推送，不让 invoke 挂到整轮结束
    void startTurn(
      request,
      { baseUrl: model.baseUrl, apiKey: model.apiKey, modelName: model.modelName },
      controller.signal,
      emit
    ).finally(() => {
      running.delete(request.sessionId)
    })
  })

  ipcMain.on(AI_CHANNELS.abort, (_event, sessionId: string): void => {
    if (typeof sessionId !== 'string') return
    running.get(sessionId)?.abort()
  })

  // P1：写操作审批走这里（渲染进程 → 主进程的一次性决策）
  ipcMain.on(AI_CHANNELS.approval, (): void => {})
}

/** 执行一轮对话；工作区文件系统在每轮开始时按 cwd 创建 */
async function startTurn(
  request: AiSendRequest,
  model: { baseUrl: string; apiKey: string; modelName: string },
  signal: AbortSignal,
  emit: (event: AiEvent) => void
): Promise<void> {
  try {
    const fs = await LocalFileSystem.create(request.cwd)
    await runTurn({ request, model, fs, registry, sessions, emit, signal })
  } catch (error) {
    emit({ type: 'error', message: errorMessage(error) })
    emit({ type: 'turn-end', reason: 'error' })
  }
}

/** 校验渲染进程传来的请求 */
function validateRequest(request: AiSendRequest): void {
  if (!request || typeof request !== 'object') {
    throw new Error('请求参数无效')
  }
  if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
    throw new Error('sessionId 无效')
  }
  if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) {
    throw new Error('cwd 必须是绝对路径')
  }
  if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
    throw new Error('prompt 不能为空')
  }
  if (typeof request.modelConfigId !== 'number' || !Number.isInteger(request.modelConfigId)) {
    throw new Error('modelConfigId 无效')
  }
}

/** 应用退出前中止所有执行中的对话（P0 的工具都是短任务，这里只做信号收尾） */
export function abortAllAiRuns(): void {
  for (const controller of running.values()) {
    controller.abort()
  }
  running.clear()
}
