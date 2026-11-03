import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  FileDiff,
  ListChecks,
  Loader2,
  Wrench
} from 'lucide-react'
import type { AiMessageView, TodoItem, ToolFileChange, ToolHunk } from '@shared/ai/types'
import FileRow from '../FileRow'
import MarkdownPreview from '../MarkdownPreview'
import { basename } from '../../lib/filePath'
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
          case 'changes':
            return <ChangesSummary key={message.id} files={message.files} />
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
 * read 看带行号窗口，write/edit 看 diff，失败时看原因。
 */
function ToolCard({
  message
}: {
  message: Extract<AiMessageView, { kind: 'tool' }>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const title = message.card?.title ?? message.name
  // 任务清单卡片用结构化行渲染；diff 卡片用结构化行渲染；其他工具才走 pre
  const todos = message.card?.kind === 'todo' ? (message.card.todos ?? []) : []
  const hunks = message.card?.kind === 'diff' ? (message.card.hunks ?? []) : []
  // 卡片优先；卡片没有正文（失败、旧日志或 diff 为空）时退回结果文本，保证总能展开
  const body = message.card?.body ?? message.resultText
  const hasTodos = todos.length > 0
  const hasHunks = hunks.length > 0
  const hasBody = hasTodos || hasHunks || (typeof body === 'string' && body.length > 0)
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
        {hasTodos ? (
          <ListChecks className="size-3.5 shrink-0 text-dim" />
        ) : (
          <Wrench className="size-3.5 shrink-0 text-dim" />
        )}
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
        hasTodos ? (
          <TodoBody todos={todos} />
        ) : hasHunks ? (
          <DiffBody hunks={hunks} />
        ) : (
          <pre className="m-0 max-h-64 overflow-auto px-2 py-1.5 text-[11px] leading-[1.5] break-all whitespace-pre-wrap text-dim">
            {body}
          </pre>
        )
      ) : null}
    </div>
  )
}

/**
 * 任务清单正文：三态图标 + 一行任务。
 * 进行中加重、已完成置灰划线，收起状态下由卡片标题里的进度补足信息。
 */
function TodoBody({ todos }: { todos: readonly TodoItem[] }): React.JSX.Element {
  return (
    <ul className="m-0 list-none px-2 py-1.5">
      {todos.map((todo) => (
        <li
          key={todo.content}
          className="flex items-start gap-1.5 py-0.5 text-[12px] leading-[1.5]"
        >
          {todo.status === 'completed' ? (
            <CheckCircle2 className="mt-[2px] size-3.5 shrink-0 text-link" />
          ) : todo.status === 'in_progress' ? (
            <CircleDot className="mt-[2px] size-3.5 shrink-0 text-fg" />
          ) : (
            <Circle className="mt-[2px] size-3.5 shrink-0 text-dim" />
          )}
          <span
            className={cn(
              'min-w-0 flex-1 break-words',
              todo.status === 'completed' && 'text-dim line-through',
              todo.status === 'in_progress' && 'text-fg',
              todo.status === 'pending' && 'text-dim'
            )}
          >
            {todo.content}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * 本轮改动清单：一轮对话结束后附着在消息末尾。
 * 复用文件树的 FileRow（图标 + 文件名 + 行尾插槽），保证与左侧列表同一套视觉。
 */
function ChangesSummary({ files }: { files: readonly ToolFileChange[] }): React.JSX.Element {
  const added = files.reduce((total, file) => total + file.added, 0)
  const removed = files.reduce((total, file) => total + file.removed, 0)
  return (
    <div className="mb-3 overflow-hidden rounded-md border border-line bg-elevated">
      <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5 text-[12px] text-dim">
        <FileDiff className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">本轮改动 {files.length} 个文件</span>
        <span className="shrink-0 text-link">+{added}</span>
        <span className="shrink-0 text-danger">-{removed}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {files.map((file) => (
          <li key={file.path} className="px-2 py-1 text-[12px]" title={file.path}>
            <FileRow
              name={basename(file.path)}
              trailing={
                <span className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-link">+{file.added}</span>
                  <span className="text-danger">-{file.removed}</span>
                  {/* git 风格的标记：A 本轮新建，M 本轮修改 */}
                  <span
                    className={cn('font-medium', file.status === 'A' ? 'text-link' : 'text-dim')}
                  >
                    {file.status}
                  </span>
                </span>
              }
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** diff 正文：删除行红底、新增行蓝底，上下文行保持低调 */
function DiffBody({ hunks }: { hunks: readonly ToolHunk[] }): React.JSX.Element {
  return (
    <div className="max-h-64 overflow-auto px-2 py-1.5 text-[11px] leading-[1.5]">
      {hunks.map((hunk, hunkIndex) => (
        <div
          key={hunkIndex}
          className={hunkIndex > 0 ? 'mt-1.5 border-t border-line pt-1.5' : undefined}
        >
          {hunk.lines.map((line, lineIndex) => (
            <pre
              key={lineIndex}
              className={cn(
                'm-0 whitespace-pre-wrap break-all',
                line.kind === 'del' && 'bg-danger/10 text-danger',
                line.kind === 'add' && 'bg-link/10 text-link',
                line.kind === 'context' && 'text-dim'
              )}
            >
              {`${line.kind === 'del' ? '-' : line.kind === 'add' ? '+' : ' '} ${line.text}`}
            </pre>
          ))}
        </div>
      ))}
    </div>
  )
}
