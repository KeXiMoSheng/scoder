import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Wrench } from 'lucide-react'
import type { AiMessageView } from '@shared/ai/types'
import MarkdownPreview from '../MarkdownPreview'
import { cn } from '../../lib/utils'
import type { AiMessageListProps } from './types'

/** 距底部多少像素内视为“停在底部”：新内容到来时继续自动滚动 */
const PIN_THRESHOLD = 48

/**
 * 对话消息列表：用户消息右对齐气泡，助手回复走 MarkdownPreview，
 * 工具调用显示为卡片（标题 + 可选正文），结果按 callId 回填。
 */
export default function AiMessageList({
  messages,
  running,
  error,
  emptyHint
}: AiMessageListProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // 用户向上翻看历史时不要被新内容拽回底部
  const pinnedRef = useRef(true)

  useEffect(() => {
    const container = scrollRef.current
    if (container && pinnedRef.current) {
      container.scrollTop = container.scrollHeight
    }
  }, [messages, running, error])

  const handleScroll = (): void => {
    const container = scrollRef.current
    if (!container) {
      return
    }
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight
    pinnedRef.current = distance < PIN_THRESHOLD
  }

  if (messages.length === 0 && !running && error === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <p className="m-0 max-w-[220px] text-center leading-[1.6] text-dim">{emptyHint}</p>
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
      role="log"
      aria-live="polite"
    >
      {messages.map((message) => {
        switch (message.kind) {
          case 'user':
            return <UserBubble key={message.id} text={message.text} />
          case 'assistant':
            return <AssistantMessage key={message.id} text={message.text} />
          case 'tool':
            return <ToolCard key={message.id} message={message} />
        }
      })}
      {running ? (
        <p className="m-0 flex items-center gap-1.5 px-1 py-1 text-[12px] text-dim">
          <Loader2 className="size-3 shrink-0 animate-spin" />
          正在生成…
        </p>
      ) : null}
      {error ? (
        <div className="mt-1 mb-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-[12px] leading-[1.5] break-all text-danger">
          {error}
        </div>
      ) : null}
    </div>
  )
}

/** 用户消息：右对齐气泡，保留原始换行 */
function UserBubble({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="mb-3 flex justify-end">
      <div className="max-w-[85%] rounded-md border border-line bg-elevated px-2.5 py-1.5">
        <p className="m-0 text-[13px] leading-[1.6] break-words whitespace-pre-wrap text-fg">
          {text}
        </p>
      </div>
    </div>
  )
}

/** 助手回复：直接复用文件预览的 Markdown 渲染（message 变体，紧凑排版） */
function AssistantMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="mb-3">
      <MarkdownPreview content={text} variant="message" />
    </div>
  )
}

/**
 * 工具卡片：默认收起，只显示工具名与状态。
 * 点击标题行（左侧工具图标或右侧箭头都可以）展开正文：
 * 带行号窗口、补丁或失败原因。
 */
function ToolCard({
  message
}: {
  message: Extract<AiMessageView, { kind: 'tool' }>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const title = message.card?.title ?? message.name
  // 失败时没有卡片正文，退回到结果文本，方便直接看到错误原因
  const body = message.card?.body ?? (message.ok === false ? message.resultText : undefined)
  const hasBody = typeof body === 'string' && body.length > 0
  const statusLabel =
    message.status === 'pending' ? '执行中' : message.ok === false ? '失败' : '完成'
  const Chevron = expanded ? ChevronDown : ChevronRight

  return (
    <div className="mb-3 overflow-hidden rounded-md border border-line bg-elevated">
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1.5 px-2 py-1.5 text-left',
          hasBody ? 'cursor-pointer hover:bg-hover' : 'cursor-default',
          expanded && 'border-b border-line'
        )}
        title={hasBody ? (expanded ? '收起工具输出' : '展开工具输出') : title}
        aria-expanded={hasBody ? expanded : undefined}
        onClick={() => {
          if (hasBody) {
            setExpanded((previous) => !previous)
          }
        }}
      >
        <Wrench className="size-3.5 shrink-0 text-dim" />
        <span
          className="min-w-0 flex-1 truncate text-[12px] text-fg"
          title={message.card?.path ?? title}
        >
          {title}
        </span>
        <span
          className={cn(
            'shrink-0 text-[11px]',
            message.status === 'pending' && 'text-dim',
            message.status === 'done' && message.ok !== false && 'text-dim',
            message.status === 'done' && message.ok === false && 'text-danger'
          )}
        >
          {statusLabel}
        </span>
        {hasBody ? <Chevron className="size-3.5 shrink-0 text-dim" /> : null}
      </button>
      {expanded && hasBody ? (
        <pre className="m-0 max-h-64 overflow-auto px-2 py-1.5 text-[11px] leading-[1.5] break-all whitespace-pre-wrap text-dim">
          {body}
        </pre>
      ) : null}
    </div>
  )
}
