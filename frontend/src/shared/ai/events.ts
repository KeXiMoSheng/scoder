/** AI 通道名：主进程与 preload 共用，避免字符串在两处漂移 */

export const AI_CHANNELS = {
  /** 渲染进程 → 主进程：启动一轮对话（invoke，立即返回） */
  send: 'ai:send',
  /** 渲染进程 → 主进程：中止一轮对话（单向 send） */
  abort: 'ai:abort',
  /** 渲染进程 → 主进程：回应审批请求（单向 send） */
  approval: 'ai:approval',
  /** 主进程 → 渲染进程：流式事件（单向 send） */
  event: 'ai:event',
  /** 渲染进程 → 主进程：列出磁盘上的会话摘要（invoke） */
  listSessions: 'ai:sessions:list',
  /** 渲染进程 → 主进程：删除一个会话日志（invoke） */
  deleteSession: 'ai:sessions:delete',
  /** 渲染进程 → 主进程：保存会话标题（invoke） */
  updateSessionTitle: 'ai:sessions:title',
  /** 渲染进程 → 主进程：读取会话历史消息（invoke） */
  loadMessages: 'ai:sessions:messages'
} as const
