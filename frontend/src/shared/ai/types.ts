/** AI 助手与渲染进程之间的公共契约：请求、事件、工具卡片 */

/** JSON 值：工具元数据必须可序列化，才能随 IPC 传递并写入会话日志 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** 工具参数 schema 的标量属性（P0 只使用模型真正需要的子集） */
export interface JsonSchemaScalarProperty {
  type: 'string' | 'number' | 'integer' | 'boolean'
  description: string
  enum?: string[]
}

/** 工具参数 schema 的数组属性：元素固定为对象（todo 清单这类结构化列表） */
export interface JsonSchemaArrayProperty {
  type: 'array'
  description: string
  items: JsonSchemaObject
}

/** 工具参数 schema 的单个属性 */
export type JsonSchemaProperty = JsonSchemaScalarProperty | JsonSchemaArrayProperty

/** 工具参数 schema：与 OpenAI function.parameters 兼容的对象形态 */
export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, JsonSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
}

/**
 * diff 卡片里的一行。
 * context 是未改动的上下文行，del 是被删掉的旧行，add 是新增行。
 * 由主进程算好行类型，渲染进程直接上色，不再自己算 diff。
 */
export type ToolHunkLine = {
  kind: 'context' | 'del' | 'add'
  text: string
}

/** diff 卡片的一个变更块（含上下文行） */
export type ToolHunk = {
  lines: ToolHunkLine[]
}

/**
 * 一次文件改动的统计，用于本轮改动清单。
 * status 对齐 git 的记号：A 本轮新建，M 本轮修改。
 */
export type ToolFileChange = {
  /** 相对工作区根的路径 */
  path: string
  /** 新增行数 */
  added: number
  /** 减少行数 */
  removed: number
  status: 'A' | 'M'
}

/** 任务清单条目的三态生命周期 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/**
 * 任务清单的一条：一句简短的祈使句加三态状态。
 * 清单每次整体替换，条目不需要稳定 id，因此刻意保持最小形状。
 */
export type TodoItem = {
  /** 任务内容，展示在卡片里的一行 */
  content: string
  status: TodoStatus
}

/**
 * 工具卡片：主进程根据调用参数或结果推导出的展示意图。
 * 渲染进程只负责画卡片，不参与工具执行，也不解析文件内容。
 */
export interface ToolCardView {
  kind: 'generic' | 'read' | 'diff' | 'todo'
  title: string
  /** 卡片正文（read 为带行号的窗口；diff 卡片改用 hunks 渲染） */
  body?: string
  /** 涉及的文件（相对工作区根，供 UI 点击跳转） */
  path?: string
  /** 跳转行号（1 起） */
  line?: number
  /** kind 为 diff 时的逐块变更（由主进程算好并随日志保存，重放一致） */
  hunks?: ToolHunk[]
  /** kind 为 todo 时的清单快照：整表替换后模型认为的最新计划 */
  todos?: TodoItem[]
  /** 本次调用对这个文件的影响（增删行数与 A/M），供改动清单汇总 */
  change?: ToolFileChange
}

/**
 * 服务商返回的一次模型调用用量。
 * 字段名做了驼峰化，数值保持服务商原始计数，不再做任何估算。
 */
export interface AiTokenUsage {
  /** 本次请求的输入 token（包含系统提示、历史、工具声明与工具结果） */
  promptTokens: number
  /** 本次生成的输出 token */
  completionTokens: number
  /** 输入 + 输出 */
  totalTokens: number
}

/**
 * 上下文用量：直接取服务商返回的真实 usage，
 * 已用 = 输入 + 输出（输出会进入下一次请求，同样占用窗口）。
 */
export interface AiContextUsage {
  /** 已占用 token */
  usedTokens: number
  /** 上下文窗口上限 */
  limitTokens: number
}

/**
 * 用户附加给 AI 的上下文类型：
 * file/directory 只提供路径与类型，selection 额外携带选中的行内容。
 */
export type AiAttachmentKind = 'file' | 'directory' | 'selection'

/** 渲染进程传给主进程的附件：路径为绝对路径，必须位于工作区内 */
export interface AiAttachment extends AiAttachmentView {
  /** kind 为 selection 时的选中文本（整行内容）；其他类型缺省 */
  text?: string
}

/** 展示用附件：会话重放与本地回显共用，不包含可能很大的选中文本 */
export interface AiAttachmentView {
  /** 文件/目录路径：发给模型的展示路径（相对工作区根）；本地回显时也转成相对路径 */
  path: string
  kind: AiAttachmentKind
  /** kind 为 selection 时的起始行（1 起） */
  startLine?: number
  /** kind 为 selection 时的结束行（1 起，含） */
  endLine?: number
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
  /**
   * 用户附加的上下文：file/directory 只带路径与类型，
   * selection 额外带选中行内容。
   */
  attachments?: AiAttachment[]
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
  /** 写工具落盘后的通知：渲染进程据此刷新文件树与已打开的编辑器 */
  | { type: 'file-changed'; paths: string[] }
  /** 自动标题润色完成：标签栏与历史列表据此更新标题 */
  | { type: 'session-title'; title: string }
  /** 上下文用量变化：服务商返回真实 usage 后推送 */
  | { type: 'context-usage'; usage: AiContextUsage }
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
  | {
      kind: 'user'
      id: string
      time: number
      text: string
      /** 本轮附加的上下文（文件/目录/选中行）；没有附件时缺省 */
      attachments?: AiAttachmentView[]
    }
  | {
      kind: 'assistant'
      id: string
      time: number
      text: string
      /**
       * 这段回复是被用户中止打断的：文本只保留中断前已流出的前缀。
       * 来自日志里的 interrupted 标记（历史）或 turn-end 的 aborted（实时）。
       */
      interrupted?: boolean
    }
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
  /** 本轮改动清单：一轮对话结束时附着在消息末尾 */
  | { kind: 'changes'; id: string; time: number; files: ToolFileChange[] }

/** 打开会话时载入的内容：磁盘历史 + 执行状态 + 按日志重放出的上下文用量 */
export interface AiLoadedSession {
  messages: AiMessageView[]
  running: boolean
  /** 打开会话时的上下文用量；从未调用过模型时为 0 */
  usage: AiContextUsage
}

/**
 * 会话摘要：主进程扫描会话目录后汇总，供渲染进程恢复标签栏与历史列表。
 * 与磁盘日志的对应关系：title 取最后一条 session/title 事件，
 * updatedAt 取最后一条事件的时间。
 */
export interface AiSessionSummary {
  id: string
  title: string
  /**
   * 标题是否仍由自动生成（默认名或模型润色）。
   * 用户手工重命名后置 false：此后自动标题不再覆盖它。
   */
  autoTitle: boolean
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 最后活动时间（毫秒时间戳） */
  updatedAt: number
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
  /** 删除一个会话日志；返回 false 表示用户取消了确认 */
  deleteSession: (cwd: string, id: string) => Promise<boolean>
  /** 保存会话标题；autoTitle 为 true 表示仍是自动生成的标题 */
  updateSessionTitle: (cwd: string, id: string, title: string, autoTitle: boolean) => Promise<void>
}
