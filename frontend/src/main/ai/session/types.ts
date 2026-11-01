/**
 * 会话日志的数据模型：一行一个 JSON 记录，首行是会话头，其余是事件。
 *
 * 结构参考 deepseek-harness 的 session-format，但只保留本项目真正需要的一小部分：
 * 没有格式代际迁移、没有 surface 替换操作、没有流式 chunk 时间线。
 * 日志是唯一真相，发给模型的 ChatMessage 由重放得到（见 store.ts）。
 */
import type { AiTurnEndReason, ToolCardView } from '../../../shared/ai/types'

/**
 * 当前日志格式版本。
 * 只在“旧文件无法按新代码读取”时递增，并在 jsonl.ts 的读取分支里保留兼容；
 * 新增可选字段不算破坏性变更，不必升版本。
 */
export const SESSION_LOG_VERSION = 1

/** 会话头：文件首行，写出后不再修改（标题等可变信息走事件） */
export interface SessionLogHeader {
  type: 'session'
  version: number
  id: string
  /** 创建时间（Unix 毫秒） */
  createdAt: number
}

/**
 * 消息内容块。
 * P0 只有文本与工具调用；后续加推理过程或图片时在这里扩一个分支即可，
 * 不用改日志外层结构。
 */
export type SessionBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }

/** 落盘的轮次结束原因：比 UI 的 turn-end 多一个「进程崩溃后补记」 */
export type StoredTurnEndReason = AiTurnEndReason | 'interrupted'

/** 事件载荷：键是事件类型，值是该类型的 data 结构 */
export interface SessionEventMap {
  /** 会话标题变更；取最后一条作为当前标题，auto 表示仍是首条消息摘要 */
  'session/title': { title: string; auto: boolean }
  /** 一轮对话开始：cwd 与模型记在这里，同一会话换过项目也能追溯 */
  'turn/start': { turn: number; cwd: string; modelConfigId: number }
  /** 用户输入（含将来可能的图片等块） */
  'user/message': { content: SessionBlock[] }
  /** 一次模型调用开始 */
  'step/start': { turn: number; step: number }
  /** 模型这一步的输出：文本片段与它请求的工具调用 */
  'assistant/message': { turn: number; step: number; content: SessionBlock[] }
  /** 一次工具执行的结果，callId 与 assistant 消息里的 tool-call 块对应 */
  'tool/result': {
    turn: number
    step: number
    callId: string
    name: string
    ok: boolean
    text: string
    /**
     * 执行后推导的展示卡片（工具私有载荷，核心不解释它）。
     * 存进日志才能保证历史重放与实时看到的卡片一致。
     */
    card?: ToolCardView
  }
  /** 一次模型调用结束（含其请求的工具执行） */
  'step/end': { turn: number; step: number }
  /** 一轮对话结束：正常完成、用户中止、出错或上次崩溃补记 */
  'turn/end': { turn: number; reason: StoredTurnEndReason }
}

/** 事件类型名 */
export type SessionEventType = keyof SessionEventMap

/**
 * 一条持久化事件。
 * seq 在会话内从 0 起严格连续，读取时校验；发现断号说明文件被外部改动。
 * 用映射类型而不是泛型接口：这样 type 与 data 是真正的判别联合，
 * 读取后 switch(event.type) 能直接窄化 event.data，不需要断言。
 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    seq: number
    /** 写入时间（Unix 毫秒） */
    time: number
    data: SessionEventMap[K]
  }
}[T]

/** 待写入的事件：seq 与 time 由仓库分配 */
export type SessionEventInput = {
  [K in SessionEventType]: { type: K; data: SessionEventMap[K] }
}[SessionEventType]

/** 一次读取的结果 */
export interface SessionLogContent {
  header: SessionLogHeader
  events: SessionEvent[]
  /** 尾部被丢弃的损坏行数：崩溃时可能只写入半行，属正常情况 */
  discarded: number
}
