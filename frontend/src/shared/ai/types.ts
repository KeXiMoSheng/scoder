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
  /** 会话 id：同一 id 复用历史消息（P0 仅存于主进程内存） */
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

/** 经 preload 暴露给渲染进程的 AI 能力（白名单方法） */
export interface AiAPI {
  /** 启动一轮对话；立即返回，后续进展通过 onEvent 推送 */
  send: (request: AiSendRequest) => Promise<void>
  /** 中止指定会话正在执行的一轮对话 */
  abort: (sessionId: string) => void
  /** 回应一次审批请求（P1 的写操作会用到） */
  respondApproval: (requestId: string, approved: boolean) => void
  /** 订阅主进程事件；返回取消订阅函数 */
  onEvent: (listener: (event: AiEvent) => void) => () => void
}
