import { useCallback, useEffect, useRef, useState } from 'react'
import { mergeFileChange } from '@shared/ai/changes'
import type {
  AiAttachment,
  AiContextUsage,
  AiEvent,
  AiMessageView,
  ToolFileChange
} from '@shared/ai/types'
import { toAttachmentView } from '../lib/aiAttachment'

/** 实时条目的 id 计数器：与历史条目的 seq 前缀区分，重开会话后整表重建不影响 */
let liveId = 0

/** 进行中的改动清单条目 id：turn-end 时替换成正式条目并移到末尾 */
const PENDING_CHANGES_ID = 'live-changes-pending'

/** 生成一个渲染期唯一的条目 id */
function nextLiveId(prefix: string): string {
  liveId += 1
  return `live-${prefix}-${liveId}`
}

/**
 * 追加一段流式文本。
 * 规则：始终接在列表最后一条助手消息后面，除非最后一条不是助手消息
 * （工具卡片之后的新文本、以及每一步的新文本都自然另起一段）。
 */
function appendText(previous: AiMessageView[], text: string): AiMessageView[] {
  const last = previous[previous.length - 1]
  if (last?.kind === 'assistant') {
    return [...previous.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...previous, { kind: 'assistant', id: nextLiveId('assistant'), time: Date.now(), text }]
}

/**
 * 给被打断的那段回复打上「已停止」标记。
 * 只有列表末尾正好是一段助手文本时才标记：中止如果发生在工具执行中，
 * 末尾是工具卡片，此时没有“半截回答”需要说明。
 */
function markLastAssistantInterrupted(previous: AiMessageView[]): AiMessageView[] {
  const last = previous[previous.length - 1]
  if (last?.kind !== 'assistant') {
    return previous
  }
  return [...previous.slice(0, -1), { ...last, interrupted: true }]
}

/** 更新/插入"进行中"的改动清单：位置保持在它第一次出现的地方 */
function upsertPendingChanges(previous: AiMessageView[], files: ToolFileChange[]): AiMessageView[] {
  const entry: AiMessageView = {
    kind: 'changes',
    id: PENDING_CHANGES_ID,
    time: Date.now(),
    files
  }
  const index = previous.findIndex(
    (view) => view.kind === 'changes' && view.id === PENDING_CHANGES_ID
  )
  if (index === -1) {
    return [...previous, entry]
  }
  const next = [...previous]
  next[index] = entry
  return next
}

/**
 * 清掉不该留在列表里的临时行：
 * - 进行中的改动清单（结束时会换成正式条目，异常中断时直接丢弃）；
 * - 停在「准备中」的工具行——中止发生在派发之前，这条调用没有落盘，
 *   界面也不该留下一个永远不会前进的行。
 * 没有可清理项时返回原数组，避免无意义的重渲染。
 */
function dropTransientRows(previous: AiMessageView[]): AiMessageView[] {
  const stale = (view: AiMessageView): boolean =>
    (view.kind === 'changes' && view.id === PENDING_CHANGES_ID) ||
    (view.kind === 'tool' && view.status === 'preparing')
  return previous.some(stale) ? previous.filter((view) => !stale(view)) : previous
}

/** 把工具调用参数转回原文：事件里已是对象，卡片展示需要字符串 */
function stringifyArguments(args: unknown): string {
  try {
    return JSON.stringify(args)
  } catch {
    return ''
  }
}

export interface AiChatApi {
  /** 当前会话的消息条目（历史 + 本轮实时） */
  messages: AiMessageView[]
  /** 当前会话是否有一轮正在执行 */
  running: boolean
  /** 最近一次错误，展示在消息列表底部 */
  error: string | null
  /** 当前上下文用量；载入前为 null */
  usage: AiContextUsage | null
  /** 发送一条消息（可附带本轮要发送给 AI 的上下文附件）；未打开项目时只在本地报错 */
  send: (text: string, modelConfigId: number, attachments?: readonly AiAttachment[]) => void
  /** 中止当前会话正在执行的一轮对话 */
  abort: () => void
}

/**
 * 单个会话的对话状态：挂载时从磁盘重放历史，之后叠加实时事件。
 *
 * 约定：调用方用 `key={sessionId}` 挂载本 hook 所在组件，
 * 切换会话时组件重建、状态自然清零，避免在 effect 里同步重置状态。
 * @param sessionId 当前激活的会话 id；null 表示没有可用会话
 * @param cwd 当前打开的项目根目录，作为工具边界传给主进程
 */
export function useAiChat(sessionId: string | null, cwd: string | null): AiChatApi {
  const [messages, setMessages] = useState<AiMessageView[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 上下文用量由主进程统计；载入历史时带回一次，之后由 context-usage 事件更新
  const [usage, setUsage] = useState<AiContextUsage | null>(null)
  // 本轮改动清单：用 ref 累积（不额外触发渲染），turn-end 时作为末尾条目落进消息列表
  const turnChangesRef = useRef<Map<string, ToolFileChange>>(new Map())

  // 载入磁盘历史：结果同时带回该会话是否仍在执行
  useEffect(() => {
    if (sessionId === null || cwd === null) {
      return
    }
    let cancelled = false
    window.api.ai
      .loadMessages(cwd, sessionId)
      .then((loaded) => {
        if (cancelled) {
          return
        }
        setMessages(loaded.messages)
        setRunning(loaded.running)
        setUsage(loaded.usage)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(`读取会话历史失败：${describeError(loadError)}`)
        }
      })
    return () => {
      cancelled = true
    }
  }, [cwd, sessionId])

  // 事件订阅：同一进程可能有多个会话在跑，按会话 id 过滤
  useEffect(() => {
    if (sessionId === null) {
      return
    }
    return window.api.ai.onEvent(({ sessionId: sourceId, event }) => {
      if (sourceId !== sessionId) {
        return
      }
      applyEvent(event, setMessages, setRunning, setError, setUsage, turnChangesRef.current)
    })
  }, [sessionId])

  const send = useCallback(
    (text: string, modelConfigId: number, attachments?: readonly AiAttachment[]): void => {
      if (sessionId === null) {
        setError('请先新建一个会话')
        return
      }
      if (cwd === null) {
        setError('请先打开一个项目目录，再发送消息')
        return
      }
      setError(null)
      setRunning(true)
      const views = attachments?.map((attachment) => toAttachmentView(attachment, cwd)) ?? []
      // 用户消息本地先上屏，不等主进程回包：发送失败时再补一条错误提示
      setMessages((previous) => [
        ...previous,
        {
          kind: 'user',
          id: nextLiveId('user'),
          time: Date.now(),
          text,
          ...(views.length > 0 ? { attachments: views } : {})
        }
      ])
      window.api.ai
        .send({
          sessionId,
          modelConfigId,
          cwd,
          prompt: text,
          ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {})
        })
        .catch((sendError: unknown) => {
          setRunning(false)
          setError(`发送失败：${describeError(sendError)}`)
        })
    },
    [cwd, sessionId]
  )

  const abort = useCallback((): void => {
    if (sessionId !== null) {
      window.api.ai.abort(sessionId)
    }
  }, [sessionId])

  return { messages, running, error, usage, send, abort }
}

/** 把一条主进程事件并入消息列表 */
function applyEvent(
  event: AiEvent,
  setMessages: React.Dispatch<React.SetStateAction<AiMessageView[]>>,
  setRunning: React.Dispatch<React.SetStateAction<boolean>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
  setUsage: React.Dispatch<React.SetStateAction<AiContextUsage | null>>,
  turnChanges: Map<string, ToolFileChange>
): void {
  switch (event.type) {
    case 'turn-start': {
      setRunning(true)
      setError(null)
      // 新一轮开始：上一轮的改动清单已经落成条目，这里清空累积器
      turnChanges.clear()
      // 上一轮若异常中断，可能残留进行中的清单条目与没派发出去的调用行
      setMessages(dropTransientRows)
      break
    }
    case 'text-delta': {
      setMessages((previous) => appendText(previous, event.text))
      break
    }
    case 'tool-preparing': {
      // 参数还在流式生成：先摆一行「准备中」，让用户提前看到即将执行哪个工具
      setMessages((previous) =>
        previous.some((view) => view.kind === 'tool' && view.callId === event.callId)
          ? previous
          : [
              ...previous,
              {
                kind: 'tool',
                id: nextLiveId('tool'),
                time: Date.now(),
                callId: event.callId,
                name: event.name,
                arguments: '',
                status: 'preparing'
              }
            ]
      )
      break
    }
    case 'tool-call': {
      const message: AiMessageView = {
        kind: 'tool',
        id: nextLiveId('tool'),
        time: Date.now(),
        callId: event.callId,
        name: event.name,
        arguments: stringifyArguments(event.args),
        status: 'running',
        ...(event.card ? { card: event.card } : {})
      }
      setMessages((previous) => {
        // 同一调用可能已经有一张「准备中」的行：就地升级，不新增一条
        const index = previous.findIndex(
          (view) => view.kind === 'tool' && view.callId === event.callId
        )
        if (index === -1) {
          return [...previous, message]
        }
        const next = [...previous]
        const current = next[index]
        next[index] = current.kind === 'tool' ? { ...message, id: current.id } : message
        return next
      })
      break
    }
    case 'tool-result': {
      setMessages((previous) =>
        previous.map((message) =>
          message.kind === 'tool' && message.callId === event.callId
            ? {
                ...message,
                status: event.stopped ? 'stopped' : event.ok ? 'ok' : 'error',
                resultText: event.text,
                ...(event.card ? { card: event.card } : {})
              }
            : message
        )
      )
      // 累积本轮改动；一旦有文件被改就立刻显示，不依赖 turn-end（结束事件缺失时也能看到）
      const change = event.card?.change
      if (change) {
        turnChanges.set(change.path, mergeFileChange(turnChanges.get(change.path), change))
        const files = [...turnChanges.values()]
        setMessages((previous) => upsertPendingChanges(previous, files))
      }
      break
    }
    case 'error': {
      setError(event.message)
      break
    }
    case 'context-usage': {
      setUsage(event.usage)
      break
    }
    case 'turn-end': {
      setRunning(false)
      // 本轮改动清单收尾：移除进行中的条目，把最终结果放到消息末尾
      const files = [...turnChanges.values()]
      turnChanges.clear()
      setMessages((previous) => {
        // 中止时停在「准备中」的行尚未派发、日志里不存在，随本轮一起清掉
        const rest = dropTransientRows(previous)
        const settled: AiMessageView[] =
          files.length === 0
            ? rest
            : [...rest, { kind: 'changes', id: nextLiveId('changes'), time: Date.now(), files }]
        // 用户中止：给被打断的那段回复打上标记，与磁盘上的 interrupted 语义一致
        return event.reason === 'aborted' ? markLastAssistantInterrupted(settled) : settled
      })
      break
    }
    default: {
      // step-start / file-changed / session-title / approval-request 不影响消息列表
      break
    }
  }
}

/** 从 IPC 抛出的异常里取出可读文本 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
