import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { MessageBoxOptions } from 'electron'
import { isAbsolute, join } from 'path'
import { AI_CHANNELS } from '../../shared/ai/events'
import type {
  AiEvent,
  AiLoadedSession,
  AiSendRequest,
  AiSessionSummary,
  ToolCardView
} from '../../shared/ai/types'
import { findModelConfigById } from '../db'
import { ObservationStore } from './fs/observation'
import { LocalFileSystem } from './fs/service'
import { runTurn } from './loop/agentLoop'
import { SESSIONS_DIR_NAME } from './session/jsonl'
import { SessionStore } from './session/store'
import { toMessageViews } from './session/view'
import { createToolRegistry } from './tools'
import { errorMessage } from './tools/registry'

/**
 * 会话日志根目录：Electron 的 userData/sessions。
 * 首次使用时才求值，避免模块加载阶段就依赖 app 是否已就绪。
 */
function sessionsRoot(): string {
  return join(app.getPath('userData'), SESSIONS_DIR_NAME)
}

/** 会话历史：每个会话一个追加式 JSONL 文件（重启后仍在） */
const sessions = new SessionStore(sessionsRoot)

/** 工具注册表：工具本身无状态，整个进程共享一份 */
const registry = createToolRegistry()

/** 会话级“已读”观测：先读后改策略的状态，按 sessionId 隔离 */
const observations = new ObservationStore()

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
        // 带上会话 id：渲染进程可能同时开着多个会话，只应更新当前那个
        event.sender.send(AI_CHANNELS.event, { sessionId: request.sessionId, event: payload })
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

  // 会话元数据：文件归主进程管，渲染进程只拿摘要、只写标题
  ipcMain.handle(
    AI_CHANNELS.listSessions,
    async (_event, cwd: string): Promise<AiSessionSummary[]> => {
      return sessions.list(requireProjectPath(cwd))
    }
  )

  // 删除会话日志：磁盘文件不可恢复，先在主进程弹确认框
  ipcMain.handle(
    AI_CHANNELS.deleteSession,
    async (event, cwd: string, id: string): Promise<boolean> => {
      const project = requireProjectPath(cwd)
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('sessionId 无效')
      }
      // 正在执行的会话还在往这个文件里写，删了会被重新创建
      if (running.has(id)) {
        throw new Error('该会话正在执行，无法删除')
      }
      const summary = (await sessions.list(project)).find((item) => item.id === id)
      const options: MessageBoxOptions = {
        type: 'warning',
        buttons: ['取消', '删除'],
        defaultId: 0,
        cancelId: 0,
        title: '删除会话',
        message: `确定要删除会话「${summary?.title ?? id}」吗？`,
        detail: '该会话的全部消息将被永久删除，且无法恢复。'
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      const result = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options)
      if (result.response !== 1) {
        return false
      }
      await sessions.remove(project, id)
      return true
    }
  )

  ipcMain.handle(
    AI_CHANNELS.updateSessionTitle,
    async (_event, cwd: string, id: string, title: string, autoTitle: boolean): Promise<void> => {
      const project = requireProjectPath(cwd)
      if (typeof id !== 'string' || typeof title !== 'string' || typeof autoTitle !== 'boolean') {
        throw new Error('会话标题参数无效')
      }
      await sessions.updateTitle(project, id, title, autoTitle)
    }
  )

  // 历史消息：从日志重放成展示条目；卡片由工具定义现推，不执行任何工具
  ipcMain.handle(
    AI_CHANNELS.loadMessages,
    async (_event, cwd: string, id: string): Promise<AiLoadedSession> => {
      const project = requireProjectPath(cwd)
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('sessionId 无效')
      }
      return {
        messages: toMessageViews(await sessions.events(project, id), describeToolCall),
        // 切回一个仍在执行的会话时，界面要能重新显示“正在生成”
        running: running.has(id)
      }
    }
  )

  // 写操作审批通道保留但当前不接线：写工具的安全性由“先读后改”保证
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
    await runTurn({
      request,
      model,
      fs,
      observation: observations,
      registry,
      sessions,
      emit,
      signal
    })
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

/**
 * 校验渲染进程传来的项目路径。
 * 会话按项目隔离，cwd 既决定存储目录，也是 AI 工具的工作区边界。
 */
function requireProjectPath(cwd: unknown): string {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new Error('cwd 必须是绝对路径')
  }
  return cwd
}

/**
 * 历史日志里的工具卡片：按工具定义从参数推导，不执行工具。
 * 参数不合法或工具已下线时不给卡片，界面上只显示工具名与结果文本。
 */
function describeToolCall(name: string, rawArguments: string): ToolCardView | undefined {
  const tool = registry.get(name)
  if (!tool?.presentCall) {
    return undefined
  }
  try {
    const parsed: unknown = rawArguments.trim().length === 0 ? {} : JSON.parse(rawArguments)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined
    }
    return tool.presentCall(parsed as Record<string, unknown>)
  } catch {
    return undefined
  }
}

/** 应用退出前中止所有执行中的对话（工具都是短任务，这里只做信号收尾） */
export function abortAllAiRuns(): void {
  for (const controller of running.values()) {
    controller.abort()
  }
  running.clear()
}
