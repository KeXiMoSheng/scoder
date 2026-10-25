/** 终端域：主进程推送给渲染进程的 PTY 事件 */

/** 终端会话输出事件：pty 产生增量文本时由主进程推送给渲染进程 */
export interface TerminalDataEvent {
  /** 会话 id（createTerminal 的返回值） */
  id: number
  /** 增量输出（可能包含 ANSI 转义序列） */
  data: string
}

/** 终端会话退出事件：shell 进程结束时推送 */
export interface TerminalExitEvent {
  /** 会话 id */
  id: number
  /** 进程退出码 */
  exitCode: number
}
