import { useCallback, useEffect, useState } from 'react'
import type { AiSessionSummary } from '../../../shared/ai/types'

/** 默认会话标题 */
const DEFAULT_TITLE = '新会话'

/** 一个 AI 会话：与主进程返回的摘要同构，标题与时间用于标签栏和历史列表 */
export type AiSession = AiSessionSummary

/** 会话状态：所属项目 + 标签栏顺序 + 磁盘历史 + 当前激活项 */
interface AiSessionsState {
  /** 该状态属于哪个项目：与当前 projectPath 不一致时视为“尚未加载” */
  projectPath: string | null
  /** 已打开的会话标签（只有用户显式打开/新建的才会进来） */
  sessions: AiSession[]
  /** 磁盘上的全部会话：历史面板的数据源，不自动展开成标签 */
  history: AiSession[]
  activeId: string | null
}

/** 没有项目或正在切换项目时的空状态（复用同一对象，避免无谓重渲染） */
const EMPTY_STATE: AiSessionsState = {
  projectPath: null,
  sessions: [],
  history: [],
  activeId: null
}

export interface AiSessionsApi {
  /** 当前打开的会话标签（按创建顺序，即标签栏顺序） */
  sessions: AiSession[]
  /** 磁盘上的全部会话：历史面板用，不自动展开成标签 */
  history: AiSession[]
  /** 当前激活会话 id；无会话时为 null */
  activeId: string | null
  /** 当前激活的会话；无会话时为 null */
  activeSession: AiSession | null
  /** 新建会话并激活（追加到标签栏末尾）；未打开项目时忽略 */
  create: () => void
  /** 没有会话时新建一个并激活；已有会话则激活第一个（打开 AI 面板时调用） */
  ensureSession: () => void
  /** 激活指定会话（仅当其已在标签栏中） */
  activate: (id: string) => void
  /** 从历史打开会话：未在标签栏中则先加入再激活（关闭过的标签可重新打开） */
  open: (id: string) => void
  /** 重新读取磁盘上的会话列表（打开历史面板时调用） */
  refreshHistory: () => void
  /** 重命名会话（空白名称忽略） */
  rename: (id: string, title: string) => void
  /** 主进程润色完自动标题后同步到标签与历史 */
  applyServerTitle: (id: string, title: string) => void
  /** 删除会话（磁盘日志一并删除；用户取消时无变化） */
  remove: (id: string) => void
  /** 关闭单个会话标签（不删除磁盘日志） */
  close: (id: string) => void
  /** 关闭除指定会话外的全部标签（不删除磁盘日志） */
  closeOthers: (id: string) => void
  /** 发送一条消息后只更新活动时间；标题不再取消息内容，由模型润色或用户改名决定 */
  touch: (id: string) => void
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

/**
 * 把会话并入历史列表：同 id 覆盖，否则追加。
 * 新建/改名/活动时间变化都要同步 history，历史面板才不会显示旧数据。
 */
function appendToHistory(history: AiSession[], session: AiSession): AiSession[] {
  const index = history.findIndex((item) => item.id === session.id)
  if (index === -1) {
    return [...history, session]
  }
  const next = [...history]
  next[index] = session
  return next
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
  return { projectPath: state.projectPath, sessions, history: state.history, activeId }
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
    history: [],
    activeId: null
  })

  // 项目切换后旧列表立即失效：磁盘结果到达前不展示上一个项目的会话
  const current = state.projectPath === projectPath ? state : EMPTY_STATE

  /** 重新读取磁盘上的会话列表；只更新 history，不影响已打开的标签 */
  const refreshHistory = useCallback((): void => {
    if (projectPath === null) {
      return
    }
    void window.api.ai
      .listSessions(projectPath)
      .then((history) => {
        setState((previous) =>
          previous.projectPath === projectPath ? { ...previous, history } : previous
        )
      })
      .catch((error: unknown) => console.warn('读取会话列表失败', error))
  }, [projectPath])

  // 打开项目：标签栏保持为空（不自动展开历史会话），只把磁盘会话读进历史列表
  useEffect(() => {
    if (projectPath === null) {
      return
    }
    let cancelled = false
    void window.api.ai
      .listSessions(projectPath)
      .then((history) => {
        if (cancelled) {
          return
        }
        setState((previous) =>
          previous.projectPath === projectPath ? { ...previous, history } : previous
        )
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
    // 只在内存里建会话：首次发送时由主进程建日志，避免产生空会话文件
    setState({
      projectPath,
      sessions: [...current.sessions, session],
      history: appendToHistory(current.history, session),
      activeId: session.id
    })
  }, [current.history, current.sessions, projectPath])

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
      setState({ ...current, activeId: current.sessions[0].id })
    }
  }, [create, current, projectPath])

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

  /**
   * 从历史打开会话：已在标签栏里就只是激活，否则先加入标签再激活。
   * 这是“关闭所有标签后还能从历史回来”的关键一步。
   */
  const open = useCallback(
    (id: string): void => {
      setState((previous) => {
        if (previous.projectPath !== projectPath) {
          return previous
        }
        if (previous.sessions.some((session) => session.id === id)) {
          return previous.activeId === id ? previous : { ...previous, activeId: id }
        }
        const target = previous.history.find((session) => session.id === id)
        if (!target) {
          return previous
        }
        return { ...previous, sessions: [...previous.sessions, target], activeId: id }
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
        history: appendToHistory(current.history, {
          ...target,
          title: trimmed,
          autoTitle: false
        }),
        activeId: current.activeId
      })
      void window.api.ai
        .updateSessionTitle(projectPath, id, trimmed, false)
        .catch((error: unknown) => console.warn('保存会话标题失败', error))
    },
    [current.activeId, current.history, current.sessions, projectPath]
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

  /**
   * 主进程润色完标题后同步到标签与历史。
   * 服务端只在 autoTitle 仍为 true 时提交，这里只负责展示。
   */
  const applyServerTitle = useCallback(
    (id: string, title: string): void => {
      if (projectPath === null) {
        return
      }
      setState((previous) => {
        if (previous.projectPath !== projectPath) {
          return previous
        }
        const apply = (session: AiSession): AiSession =>
          session.id === id ? { ...session, title, autoTitle: true } : session
        return {
          ...previous,
          sessions: previous.sessions.map(apply),
          history: previous.history.map(apply)
        }
      })
    },
    [projectPath]
  )

  /**
   * 删除会话：主进程先弹确认框，用户取消时 deleted 为 false。
   * 成功后同时从标签与历史里移除，并处理激活项回退。
   */
  const remove = useCallback(
    (id: string): void => {
      if (projectPath === null) {
        return
      }
      void window.api.ai
        .deleteSession(projectPath, id)
        .then((deleted) => {
          if (!deleted) {
            return
          }
          setState((previous) => {
            if (previous.projectPath !== projectPath) {
              return previous
            }
            return removeMatching(
              { ...previous, history: previous.history.filter((session) => session.id !== id) },
              (session) => session.id === id
            )
          })
        })
        .catch((error: unknown) => console.warn('删除会话失败', error))
    },
    [projectPath]
  )

  /**
   * 发送消息后只更新活动时间。
   * 标题不再用消息内容截取：仍保持「新会话」默认名，直到首轮模型润色或用户手动改名。
   */
  const touch = useCallback(
    (id: string): void => {
      const now = Date.now()
      const target = current.sessions.find((session) => session.id === id)
      if (!target || projectPath === null) {
        return
      }
      const updated = { ...target, updatedAt: now }
      setState({
        projectPath,
        sessions: current.sessions.map((session) => (session.id === id ? updated : session)),
        history: appendToHistory(current.history, updated),
        activeId: current.activeId
      })
    },
    [current.activeId, current.history, current.sessions, projectPath]
  )

  return {
    sessions: current.sessions,
    history: current.history,
    activeId: current.activeId,
    activeSession: current.sessions.find((session) => session.id === current.activeId) ?? null,
    create,
    ensureSession,
    activate,
    open,
    refreshHistory,
    rename,
    applyServerTitle,
    remove,
    close,
    closeOthers,
    touch
  }
}
