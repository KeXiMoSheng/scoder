/** AI 助手与渲染进程之间的公共契约：请求、事件、工具卡片 */

/** JSON 值：工具元数据必须可序列化，才能随 IPC 传递并写入会话日志 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** 工具参数 schema 的单个属性（P0 只使用模型真正需要的子集） */
export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean'
  description: string
  enum?: string[]
}

/** 工具参数 schema：与 OpenAI function.parameters 兼容的对象形态 */
export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, JsonSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
}

/**
 * 工具卡片：主进程根据调用参数或结果推导出的展示意图。
 * 渲染进程只负责画卡片，不参与工具执行，也不解析文件内容。
 */
export interface ToolCardView {
  kind: 'generic' | 'read' | 'diff'
  title: string
  /** 卡片正文（read 为带行号的窗口，diff 为补丁文本；P0 只产出 read） */
  body?: string
  /** 涉及的文件（相对工作区根，供 UI 点击跳转） */
  path?: string
  /** 跳转行号（1 起） */
  line?: number
}

/** 发起一轮对话的请求：工作区由渲染进程按当前打开的项目传入 */
export interface AiSendRequest {
  /** 会话 id：同一 id 复用磁盘上的历史消息（一个会话一个 jsonl 文件） */
  sessionId: string
  /** 模型配置主键：API Key 不经过渲染进程，由主进程读库 */
  modelConfigId: number
  /** 工作区根目录的绝对路径，同时作为 AI 工具的边界 */
  cwd: string
  /** 用户本轮输入 */
  prompt: string
}

/**
 * 主进程推送给渲染进程的事件。
 * 约定：tool-call 在工具开始执行前发出，tool-result 在其结束后发出，
 * 两者用 callId 关联，UI 据此把挂起卡片替换为完成卡片。
 */
export type AiEvent =
  | { type: 'turn-start'; sessionId: string }
  | { type: 'step-start'; step: number }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; callId: string; name: string; args: unknown; card?: ToolCardView }
  | { type: 'tool-result'; callId: string; ok: boolean; text: string; card?: ToolCardView }
  | { type: 'approval-request'; requestId: string; toolName: string; reason: string }
  | { type: 'error'; message: string }
  | { type: 'turn-end'; reason: 'done' | 'aborted' | 'error' }

/** 一轮对话的终止原因（turn-end 事件的载荷） */
export type AiTurnEndReason = Extract<AiEvent, { type: 'turn-end' }>['reason']

/**
 * 主进程推送的单条事件：带会话 id。
 * 同一进程可能同时跑多个会话，渲染进程据此只更新当前打开的那个。
 */
export interface AiEventEnvelope {
  sessionId: string
  event: AiEvent
}

/**
 * 会话中的一条展示条目：由磁盘事件整理而来，渲染进程直接可用。
 * 助手文本与工具卡片是分开的条目，按发生顺序排列：
 * 流式追加时只需在尾部新建或更新最后一个，不必回改前面的结构。
 */
export type AiMessageView =
  | { kind: 'user'; id: string; time: number; text: string }
  | { kind: 'assistant'; id: string; time: number; text: string }
  | {
      kind: 'tool'
      id: string
      time: number
      callId: string
      name: string
      /** 模型给出的原始参数 JSON 字符串 */
      arguments: string
      status: 'pending' | 'done'
      /** 执行是否成功（status 为 done 时才有意义） */
      ok?: boolean
      /** 工具结果文本（展示用，可能较长） */
      resultText?: string
      /** 卡片展示意图：主进程按工具定义推导并随日志保存，历史与实时一致 */
      card?: ToolCardView
    }

/** 打开会话时载入的内容：磁盘历史 + 该会话是否正在执行 */
export interface AiLoadedSession {
  messages: AiMessageView[]
  running: boolean
}

/**
 * 会话摘要：主进程扫描会话目录后汇总，供渲染进程恢复标签栏与历史列表。
 * 与磁盘日志的对应关系：title 取最后一条 session/title 事件，
 * updatedAt 取最后一条事件的时间。
 */
export interface AiSessionSummary {
  id: string
  title: string
  /** 标题仍为自动生成：首条消息发送后由渲染进程用消息摘要替换 */
  autoTitle: boolean
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 最后活动时间（毫秒时间戳） */
  updatedAt: number
}

/** 新建会话的输入：id 由渲染进程生成，主进程负责落到该项目目录下 */
export interface AiSessionCreateInput {
  /** 会话所属项目根目录（绝对路径）：会话按项目隔离存储 */
  cwd: string
  id: string
  title: string
  autoTitle: boolean
}

/** 经 preload 暴露给渲染进程的 AI 能力（白名单方法） */
export interface AiAPI {
  /** 启动一轮对话；立即返回，后续进展通过 onEvent 推送 */
  send: (request: AiSendRequest) => Promise<void>
  /** 中止指定会话正在执行的一轮对话 */
  abort: (sessionId: string) => void
  /** 回应一次审批请求（P1 的写操作会用到） */
  respondApproval: (requestId: string, approved: boolean) => void
  /** 订阅主进程事件；返回取消订阅函数。回调带会话 id，供多会话并发时过滤 */
  onEvent: (listener: (payload: AiEventEnvelope) => void) => () => void
  /** 读取一个会话的历史消息（从 jsonl 日志重放）与执行状态 */
  loadMessages: (cwd: string, sessionId: string) => Promise<AiLoadedSession>
  /** 列出某个项目下的全部会话（按最后活动时间倒序） */
  listSessions: (cwd: string) => Promise<AiSessionSummary[]>
  /** 新建会话日志文件（幂等：同 id 重复调用不会清空已有内容） */
  createSession: (input: AiSessionCreateInput) => Promise<void>
  /** 保存会话标题；autoTitle 为 true 表示仍是首条消息的摘要 */
  updateSessionTitle: (cwd: string, id: string, title: string, autoTitle: boolean) => Promise<void>
}
