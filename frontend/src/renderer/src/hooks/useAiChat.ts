import { useCallback, useEffect, useState } from 'react'
import type { AiEvent, AiMessageView } from '../../../shared/ai/types'

/** 实时条目的 id 计数器：与历史条目的 seq 前缀区分，重开会话后整表重建不影响 */
let liveId = 0

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
  /** 发送一条消息；未打开项目时只在本地报错 */
  send: (text: string, modelConfigId: number) => void
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
      applyEvent(event, setMessages, setRunning, setError)
    })
  }, [sessionId])

  const send = useCallback(
    (text: string, modelConfigId: number): void => {
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
      // 用户消息本地先上屏，不等主进程回包：发送失败时再补一条错误提示
      setMessages((previous) => [
        ...previous,
        { kind: 'user', id: nextLiveId('user'), time: Date.now(), text }
      ])
      window.api.ai
        .send({ sessionId, modelConfigId, cwd, prompt: text })
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

  return { messages, running, error, send, abort }
}

/** 把一条主进程事件并入消息列表 */
function applyEvent(
  event: AiEvent,
  setMessages: React.Dispatch<React.SetStateAction<AiMessageView[]>>,
  setRunning: React.Dispatch<React.SetStateAction<boolean>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>
): void {
  switch (event.type) {
    case 'turn-start': {
      setRunning(true)
      setError(null)
      break
    }
    case 'text-delta': {
      setMessages((previous) => appendText(previous, event.text))
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
        status: 'pending',
        ...(event.card ? { card: event.card } : {})
      }
      setMessages((previous) => [...previous, message])
      break
    }
    case 'tool-result': {
      setMessages((previous) =>
        previous.map((message) =>
          message.kind === 'tool' && message.callId === event.callId
            ? {
                ...message,
                status: 'done',
                ok: event.ok,
                resultText: event.text,
                ...(event.card ? { card: event.card } : {})
              }
            : message
        )
      )
      break
    }
    case 'error': {
      setError(event.message)
      break
    }
    case 'turn-end': {
      setRunning(false)
      break
    }
    default: {
      // step-start / approval-request 目前不影响消息列表
      break
    }
  }
}

/** 从 IPC 抛出的异常里取出可读文本 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
