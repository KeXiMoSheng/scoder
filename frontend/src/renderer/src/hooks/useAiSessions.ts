import { useCallback, useEffect, useState } from 'react'
import type { AiSessionSummary } from '../../../shared/ai/types'

/** 默认会话标题 */
const DEFAULT_TITLE = '新会话'
/** 自动标题的最大字符数（超出部分省略） */
const TITLE_MAX_LENGTH = 20

/** 一个 AI 会话：与主进程返回的摘要同构，标题与时间用于标签栏和历史列表 */
export type AiSession = AiSessionSummary

/** 会话状态：所属项目 + 标签顺序 + 当前激活项 */
interface AiSessionsState {
  /** 该状态属于哪个项目：与当前 projectPath 不一致时视为“尚未加载” */
  projectPath: string | null
  sessions: AiSession[]
  activeId: string | null
}

/** 没有项目或正在切换项目时的空状态（复用同一对象，避免无谓重渲染） */
const EMPTY_STATE: AiSessionsState = { projectPath: null, sessions: [], activeId: null }

export interface AiSessionsApi {
  /** 当前项目的全部会话（按创建顺序，即标签栏顺序） */
  sessions: AiSession[]
  /** 当前激活会话 id；无会话时为 null */
  activeId: string | null
  /** 当前激活的会话；无会话时为 null */
  activeSession: AiSession | null
  /** 新建会话并激活（追加到标签栏末尾）；未打开项目时忽略 */
  create: () => void
  /** 没有会话时新建一个并激活；已有会话则激活第一个（打开 AI 面板时调用） */
  ensureSession: () => void
  /** 激活指定会话（仅当其存在） */
  activate: (id: string) => void
  /** 重命名会话（空白名称忽略） */
  rename: (id: string, title: string) => void
  /** 关闭单个会话标签（不删除磁盘日志） */
  close: (id: string) => void
  /** 关闭除指定会话外的全部标签（不删除磁盘日志） */
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
  return { projectPath: state.projectPath, sessions, activeId }
}

/**
 * AI 会话状态管理（新建/激活/重命名/关闭/活动时间）。
 *
 * 会话与项目绑定：只加载 projectPath 对应目录下的会话，
 * 关闭项目（projectPath 变为 null）后列表立即清空，
 * 重新打开同一项目时再从磁盘恢复。
 * @param projectPath 当前打开的项目根目录；null 表示没有打开项目
 */
export function useAiSessions(projectPath: string | null): AiSessionsApi {
  const [state, setState] = useState<AiSessionsState>({
    projectPath,
    sessions: [],
    activeId: null
  })

  // 项目切换后旧列表立即失效：磁盘结果到达前不展示上一个项目的会话
  const current = state.projectPath === projectPath ? state : EMPTY_STATE

  // 载入当前项目的会话列表
  useEffect(() => {
    if (projectPath === null) {
      return
    }
    let cancelled = false
    void window.api.ai
      .listSessions(projectPath)
      .then((sessions) => {
        if (cancelled) {
          return
        }
        setState({ projectPath, sessions, activeId: null })
      })
      .catch((error: unknown) => console.warn('读取会话列表失败', error))
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const create = useCallback((): void => {
    if (projectPath === null) {
      return
    }
    const session = buildSession(current.sessions)
    setState({ projectPath, sessions: [...current.sessions, session], activeId: session.id })
    // 落盘失败只影响“重启后是否还在”，不应打断当前编辑
    void window.api.ai
      .createSession({
        cwd: projectPath,
        id: session.id,
        title: session.title,
        autoTitle: session.autoTitle
      })
      .catch((error: unknown) => console.warn('新建会话文件失败', error))
  }, [current.sessions, projectPath])

  const ensureSession = useCallback((): void => {
    if (projectPath === null) {
      return
    }
    if (current.sessions.length === 0) {
      create()
      return
    }
    // 恢复出来的会话没有激活项：打开面板时补上，避免界面停在“无会话”状态
    if (current.activeId === null) {
      setState({ projectPath, sessions: current.sessions, activeId: current.sessions[0].id })
    }
  }, [create, current.activeId, current.sessions, projectPath])

  const activate = useCallback(
    (id: string): void => {
      setState((previous) => {
        if (
          previous.projectPath !== projectPath ||
          previous.activeId === id ||
          !previous.sessions.some((session) => session.id === id)
        ) {
          return previous
        }
        return { ...previous, activeId: id }
      })
    },
    [projectPath]
  )

  const rename = useCallback(
    (id: string, title: string): void => {
      const trimmed = title.trim()
      const target = current.sessions.find((session) => session.id === id)
      // 空白名称与无变化的名称都不落盘
      if (!trimmed || !target || target.title === trimmed || projectPath === null) {
        return
      }
      setState({
        projectPath,
        sessions: current.sessions.map((session) =>
          session.id === id ? { ...session, title: trimmed, autoTitle: false } : session
        ),
        activeId: current.activeId
      })
      void window.api.ai
        .updateSessionTitle(projectPath, id, trimmed, false)
        .catch((error: unknown) => console.warn('保存会话标题失败', error))
    },
    [current.activeId, current.sessions, projectPath]
  )

  const close = useCallback(
    (id: string): void => {
      setState((previous) => {
        if (previous.projectPath !== projectPath) {
          return previous
        }
        return removeMatching(previous, (session) => session.id === id)
      })
    },
    [projectPath]
  )

  const closeOthers = useCallback(
    (id: string): void => {
      setState((previous) => {
        if (previous.projectPath !== projectPath) {
          return previous
        }
        const target = previous.sessions.find((session) => session.id === id)
        if (!target || previous.sessions.length === 1) {
          return previous
        }
        return { ...previous, sessions: [target], activeId: id }
      })
    },
    [projectPath]
  )

  const touch = useCallback(
    (id: string, prompt: string): void => {
      const now = Date.now()
      const target = current.sessions.find((session) => session.id === id)
      if (!target || projectPath === null) {
        return
      }
      const title = target.autoTitle ? summarizePrompt(prompt) : target.title
      setState({
        projectPath,
        sessions: current.sessions.map((session) =>
          session.id === id ? { ...session, title, autoTitle: false, updatedAt: now } : session
        ),
        activeId: current.activeId
      })
      // 标题真的变了才追写一条事件，避免每次发送都往日志里塞重复标题
      if (title !== target.title) {
        void window.api.ai
          .updateSessionTitle(projectPath, id, title, false)
          .catch((error: unknown) => console.warn('保存会话标题失败', error))
      }
    },
    [current.activeId, current.sessions, projectPath]
  )

  return {
    sessions: current.sessions,
    activeId: current.activeId,
    activeSession: current.sessions.find((session) => session.id === current.activeId) ?? null,
    create,
    ensureSession,
    activate,
    rename,
    close,
    closeOthers,
    touch
  }
}
