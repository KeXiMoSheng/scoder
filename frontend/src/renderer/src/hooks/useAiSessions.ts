import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiSessionSummary } from '../../../shared/ai/types'

/** 默认会话标题 */
const DEFAULT_TITLE = '新会话'
/** 自动标题的最大字符数（超出部分省略） */
const TITLE_MAX_LENGTH = 20

/** 一个 AI 会话：与主进程返回的摘要同构，标题与时间用于标签栏和历史列表 */
export type AiSession = AiSessionSummary

/** 会话状态：标签顺序 + 当前激活项 */
interface AiSessionsState {
  sessions: AiSession[]
  activeId: string | null
}

export interface AiSessionsApi {
  /** 全部会话（按创建顺序，即标签栏顺序） */
  sessions: AiSession[]
  /** 当前激活会话 id；无会话时为 null */
  activeId: string | null
  /** 当前激活的会话；无会话时为 null */
  activeSession: AiSession | null
  /** 新建会话并激活（追加到标签栏末尾） */
  create: () => void
  /** 没有会话时新建一个并激活；已有会话则保持原状（打开 AI 面板时调用） */
  ensureSession: () => void
  /** 激活指定会话（仅当其存在） */
  activate: (id: string) => void
  /** 重命名会话（空白名称忽略） */
  rename: (id: string, title: string) => void
  /** 关闭单个会话 */
  close: (id: string) => void
  /** 关闭除指定会话外的全部会话 */
  closeOthers: (id: string) => void
  /** 发送一条消息后更新活动时间；自动标题的会话用首条消息替换标题 */
  touch: (id: string, prompt: string) => void
}

/** 生成会话 id：优先用 crypto.randomUUID，不可用时退化为时间戳 + 自增序号 */
let sessionSeq = 0
function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  sessionSeq += 1
  return `session-${Date.now()}-${sessionSeq}`
}

/** 为新会话挑选不重复的默认标题：新会话 / 新会话 2 / 新会话 3 … */
function nextDefaultTitle(sessions: AiSession[]): string {
  const used = new Set(sessions.map((session) => session.title))
  if (!used.has(DEFAULT_TITLE)) {
    return DEFAULT_TITLE
  }
  let index = 2
  while (used.has(`${DEFAULT_TITLE} ${index}`)) {
    index += 1
  }
  return `${DEFAULT_TITLE} ${index}`
}

/** 基于当前会话列表构造一个新会话（默认标题不重复） */
function buildSession(sessions: AiSession[]): AiSession {
  const now = Date.now()
  return {
    id: createSessionId(),
    title: nextDefaultTitle(sessions),
    createdAt: now,
    updatedAt: now,
    autoTitle: true
  }
}

/** 用首条消息生成会话标题：取首个非空行，超长截断 */
function summarizePrompt(prompt: string): string {
  const line = prompt
    .split(/\r?\n/)
    .find((item) => item.trim().length > 0)
    ?.trim()
  if (!line) {
    return DEFAULT_TITLE
  }
  const chars = [...line]
  return chars.length > TITLE_MAX_LENGTH ? `${chars.slice(0, TITLE_MAX_LENGTH).join('')}…` : line
}

/**
 * 从列表中移除命中谓词的会话并维护激活项：
 * 激活项被移除时优先激活其右侧的幸存会话，否则向左回退，最后为 null。
 * 与 useOpenedFiles 的标签关闭策略保持一致。
 */
function removeMatching(
  state: AiSessionsState,
  shouldRemove: (session: AiSession, index: number) => boolean
): AiSessionsState {
  const sessions = state.sessions.filter((session, index) => !shouldRemove(session, index))
  if (sessions.length === state.sessions.length) {
    return state
  }
  let activeId = state.activeId
  const activeIndex = state.sessions.findIndex((session) => session.id === state.activeId)
  if (activeIndex !== -1 && shouldRemove(state.sessions[activeIndex], activeIndex)) {
    activeId = null
    for (let index = activeIndex + 1; index < state.sessions.length; index++) {
      if (!shouldRemove(state.sessions[index], index)) {
        activeId = state.sessions[index].id
        break
      }
    }
    if (activeId === null) {
      for (let index = activeIndex - 1; index >= 0; index--) {
        if (!shouldRemove(state.sessions[index], index)) {
          activeId = state.sessions[index].id
          break
        }
      }
    }
  }
  return { sessions, activeId }
}

/**
 * AI 会话状态管理（新建/激活/重命名/关闭/活动时间）。
 * 会话正文由主进程按 jsonl 追加落盘，这里只维护标签栏需要的元数据；
 * 启动时从主进程恢复，所以关掉应用再打开仍能看到历史会话。
 */
export function useAiSessions(): AiSessionsApi {
  const [state, setState] = useState<AiSessionsState>({ sessions: [], activeId: null })
  // 与 state 同步的镜像：新建/重命名要先拿到当前列表，再决定写什么
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // 启动时恢复磁盘上的会话；恢复失败只影响历史列表，不影响新建
  useEffect(() => {
    let cancelled = false
    void window.api.ai
      .listSessions()
      .then((sessions) => {
        if (cancelled) {
          return
        }
        // 恢复是异步的：期间用户已经新建过会话时以内存状态为准
        setState((prev) => (prev.sessions.length > 0 ? prev : { sessions, activeId: null }))
      })
      .catch((error: unknown) => console.warn('读取会话列表失败', error))
    return () => {
      cancelled = true
    }
  }, [])

  const create = useCallback((): void => {
    const session = buildSession(stateRef.current.sessions)
    setState({ sessions: [...stateRef.current.sessions, session], activeId: session.id })
    // 落盘失败只影响“重启后是否还在”，不应打断当前编辑
    void window.api.ai
      .createSession({ id: session.id, title: session.title, autoTitle: session.autoTitle })
      .catch((error: unknown) => console.warn('新建会话文件失败', error))
  }, [])

  const ensureSession = useCallback((): void => {
    const current = stateRef.current
    if (current.sessions.length === 0) {
      create()
      return
    }
    // 恢复出来的会话没有激活项：打开面板时补上，避免界面停在“无会话”状态
    if (current.activeId === null) {
      setState({ sessions: current.sessions, activeId: current.sessions[0].id })
    }
  }, [create])

  const activate = useCallback((id: string): void => {
    setState((prev) => {
      if (prev.activeId === id || !prev.sessions.some((session) => session.id === id)) {
        return prev
      }
      return { sessions: prev.sessions, activeId: id }
    })
  }, [])

  const rename = useCallback((id: string, title: string): void => {
    const trimmed = title.trim()
    const target = stateRef.current.sessions.find((session) => session.id === id)
    // 空白名称与无变化的名称都不落盘
    if (!trimmed || !target || target.title === trimmed) {
      return
    }
    setState({
      sessions: stateRef.current.sessions.map((session) =>
        session.id === id ? { ...session, title: trimmed, autoTitle: false } : session
      ),
      activeId: stateRef.current.activeId
    })
    void window.api.ai
      .updateSessionTitle(id, trimmed, false)
      .catch((error: unknown) => console.warn('保存会话标题失败', error))
  }, [])

  const close = useCallback((id: string): void => {
    setState((prev) => removeMatching(prev, (session) => session.id === id))
  }, [])

  const closeOthers = useCallback((id: string): void => {
    setState((prev) => {
      const target = prev.sessions.find((session) => session.id === id)
      if (!target || prev.sessions.length === 1) {
        return prev
      }
      return { sessions: [target], activeId: id }
    })
  }, [])

  const touch = useCallback((id: string, prompt: string): void => {
    const now = Date.now()
    const target = stateRef.current.sessions.find((session) => session.id === id)
    if (!target) {
      return
    }
    const title = target.autoTitle ? summarizePrompt(prompt) : target.title
    setState({
      sessions: stateRef.current.sessions.map((session) =>
        session.id === id ? { ...session, title, autoTitle: false, updatedAt: now } : session
      ),
      activeId: stateRef.current.activeId
    })
    // 标题真的变了才追写一条事件，避免每次发送都往日志里塞重复标题
    if (title !== target.title) {
      void window.api.ai
        .updateSessionTitle(id, title, false)
        .catch((error: unknown) => console.warn('保存会话标题失败', error))
    }
  }, [])

  return {
    sessions: state.sessions,
    activeId: state.activeId,
    activeSession: state.sessions.find((session) => session.id === state.activeId) ?? null,
    create,
    ensureSession,
    activate,
    rename,
    close,
    closeOthers,
    touch
  }
}
