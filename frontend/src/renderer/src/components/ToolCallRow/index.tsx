import { useState, type KeyboardEvent } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  FilePenLine,
  ListChecks,
  Search,
  Terminal,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { AiMessageView, TodoItem, ToolHunk, ToolRowState } from '@shared/ai/types'
import { toolRowModel, type ToolRowVariant } from '../../lib/toolRow'
import { cn } from '../../lib/utils'
import type { ToolCallRowProps } from './types'

/** 工具族的行首图标（14px，落在 16px 的图标位里） */
const VARIANT_ICONS: Record<ToolRowVariant, LucideIcon> = {
  read: Eye,
  search: Search,
  bash: Terminal,
  write: FilePenLine,
  edit: FilePenLine,
  todo: ListChecks,
  others: Wrench
}

/** 非成功状态的尾部文案；成功行保持安静，不额外占位 */
const STATUS_LABELS: Record<ToolRowState, string | undefined> = {
  preparing: '准备中',
  running: '运行中',
  ok: undefined,
  error: '失败',
  stopped: '已停止'
}

type ToolMessage = Extract<AiMessageView, { kind: 'tool' }>

/**
 * 一次工具调用的行式展示（对齐 deepseek-harness 的 ToolRow）：
 *
 * 收起时是一行 24px 的安静摘要——[图标] [标题] · [单行摘要] [+n -n] [状态]，
 * 参数仍在流式生成时先以「准备中」出现；点击整行展开：
 * diff / 任务清单 / 带行号窗口 / 输入输出卡。
 * 文件类工具的摘要本身就是可点击的路径，点它直接打开文件，不会展开整行。
 */
export default function ToolCallRow({
  message,
  cwd,
  onOpenFile
}: ToolCallRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const model = toolRowModel(message, cwd)
  const Icon = VARIANT_ICONS[model.variant]
  const expandable = model.state !== 'preparing' && model.bodyKind !== 'none'
  const open = expanded && expandable
  const running = model.state === 'preparing' || model.state === 'running'
  const failed = model.state === 'error'
  const statusLabel = STATUS_LABELS[model.state]
  // 失败与被中止的调用不再提供文件跳转：那时路径指向的内容未必可信
  const openableFile =
    model.filePath !== undefined && model.state !== 'error' && model.state !== 'stopped'
      ? model.filePath
      : undefined
  const summaryClassName = cn(
    'min-w-0 truncate text-[12px] leading-6',
    failed ? 'text-danger' : 'text-dim',
    running && 'tool-row-running-text'
  )

  const toggle = (): void => {
    if (expandable) {
      setExpanded((previous) => !previous)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) {
      return
    }
    event.preventDefault()
    toggle()
  }

  return (
    <div className="group mb-0.5" data-tool-state={model.state}>
      <div
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          'flex h-6 w-full items-center gap-1.5 rounded px-1 text-left outline-none',
          expandable && 'cursor-pointer hover:bg-hover/60',
          'focus-visible:ring-1 focus-visible:ring-line'
        )}
        title={model.summary.length > 0 ? `${model.title} ${model.summary}` : model.title}
        onClick={toggle}
        onKeyDown={handleKeyDown}
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center text-dim">
          {open ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <>
              <Icon className={cn('size-3.5', expandable && 'group-hover:opacity-0')} />
              {expandable ? (
                <ChevronRight className="absolute size-3.5 opacity-0 group-hover:opacity-100" />
              ) : null}
            </>
          )}
        </span>
        <span
          className={cn(
            'shrink-0 text-[13px] leading-6 text-dim',
            failed && 'text-danger',
            running && 'tool-row-running-text'
          )}
        >
          {model.title}
        </span>
        {model.summary.length > 0 ? (
          <>
            <span className="mx-0.5 size-[2px] shrink-0 rounded-full bg-dim/60" aria-hidden />
            {openableFile !== undefined ? (
              <button
                type="button"
                className={cn(
                  'min-w-0 cursor-pointer truncate rounded-sm border-none bg-transparent p-0 text-left',
                  'text-[12px] leading-6 text-dim underline decoration-dotted decoration-dim/60',
                  'underline-offset-[3px] transition-colors hover:text-fg',
                  running && 'tool-row-running-text'
                )}
                title={`打开 ${openableFile}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenFile(openableFile)
                }}
              >
                {model.summary}
              </button>
            ) : (
              <span className={cn(summaryClassName, 'flex-1')}>{model.summary}</span>
            )}
          </>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {model.diffStat !== undefined && !failed && model.state !== 'stopped' ? (
          <span className="ml-1.5 shrink-0 font-mono text-[11px]">
            <span className="text-link">+{model.diffStat.added}</span>{' '}
            <span className="text-danger">-{model.diffStat.removed}</span>
          </span>
        ) : null}
        {statusLabel !== undefined ? (
          <span className={cn('ml-1.5 shrink-0 text-[11px]', failed ? 'text-danger' : 'text-dim')}>
            {statusLabel}
          </span>
        ) : null}
      </div>
      {open ? <RowBody message={message} model={model} /> : null}
    </div>
  )
}

/**
 * 展开体：优先结构化卡片（diff / 任务清单 / 文本窗口），
 * 否则退回「输入 / 输出」卡；失败的结构化行把错误文本附在正文下方。
 */
function RowBody({
  message,
  model
}: {
  message: ToolMessage
  model: ReturnType<typeof toolRowModel>
}): React.JSX.Element {
  const card = message.card
  const hunks: readonly ToolHunk[] = card?.kind === 'diff' ? (card.hunks ?? []) : []
  const todos: readonly TodoItem[] = card?.kind === 'todo' ? (card.todos ?? []) : []

  return (
    <div className="mt-0.5 mb-1 pr-1 pl-6">
      {model.bodyKind === 'diff' ? (
        <>
          <DiffBody hunks={hunks} />
          {model.output !== undefined ? (
            <div className="mt-1">
              <OutputBody text={model.output} error={model.state === 'error'} />
            </div>
          ) : null}
        </>
      ) : model.bodyKind === 'todo' ? (
        <TodoBody todos={todos} />
      ) : model.bodyKind === 'text' ? (
        <TextBody text={model.textBody ?? ''} />
      ) : model.bodyKind === 'io' ? (
        <IOBody input={model.input} output={model.output} error={model.state === 'error'} />
      ) : null}
    </div>
  )
}

/** 输入 / 输出卡：输入是参数 JSON，输出是工具结果原文 */
function IOBody({
  input,
  output,
  error
}: {
  input?: string
  output?: string
  error: boolean
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-base/50">
      {input !== undefined ? (
        <section className="flex max-h-40 items-start gap-3 overflow-auto px-2.5 py-1.5">
          <span className="mt-px shrink-0 text-[10px] leading-[1.7] text-dim/70">输入</span>
          <pre className="m-0 min-w-0 flex-1 font-mono text-[11px] leading-[1.7] break-all whitespace-pre-wrap text-dim">
            {input}
          </pre>
        </section>
      ) : null}
      {input !== undefined && output !== undefined ? <div className="h-px bg-line" /> : null}
      {output !== undefined ? <OutputSection text={output} error={error} /> : null}
    </div>
  )
}

/** 失败的结构化行：在 diff 等正文下方单独附一块输出 */
function OutputBody({ text, error }: { text: string; error: boolean }): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-base/50">
      <OutputSection text={text} error={error} />
    </div>
  )
}

/** 输出区本体（不自带边框，由外层卡片决定表面） */
function OutputSection({ text, error }: { text: string; error: boolean }): React.JSX.Element {
  return (
    <section className="flex max-h-56 items-start gap-3 overflow-auto px-2.5 py-1.5">
      <span className="mt-px shrink-0 text-[10px] leading-[1.7] text-dim/70">输出</span>
      <pre
        className={cn(
          'm-0 min-w-0 flex-1 font-mono text-[11px] leading-[1.7] break-all whitespace-pre-wrap',
          error ? 'text-danger' : 'text-dim'
        )}
      >
        {text}
      </pre>
    </section>
  )
}

/** 文本窗口：read 的带行号内容、list 的条目、grep/glob 的匹配行 */
function TextBody({ text }: { text: string }): React.JSX.Element {
  return (
    <pre className="m-0 max-h-64 overflow-auto rounded-md border border-line bg-base/50 px-2 py-1.5 text-[11px] leading-[1.5] break-all whitespace-pre-wrap text-dim">
      {text}
    </pre>
  )
}

/** 任务清单正文：三态图标 + 一行任务 */
function TodoBody({ todos }: { todos: readonly TodoItem[] }): React.JSX.Element {
  return (
    <ul className="m-0 list-none rounded-md border border-line bg-base/50 px-2 py-1">
      {todos.map((todo) => (
        <li
          key={todo.content}
          className="flex items-start gap-1.5 py-0.5 text-[12px] leading-[1.5]"
        >
          <span
            className={cn(
              'mt-[3px] size-2 shrink-0 rounded-full',
              todo.status === 'completed' && 'bg-link',
              todo.status === 'in_progress' && 'bg-fg',
              todo.status === 'pending' && 'bg-dim/50'
            )}
          />
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

/** diff 正文：删除行红底、新增行蓝底，上下文行保持低调 */
function DiffBody({ hunks }: { hunks: readonly ToolHunk[] }): React.JSX.Element {
  return (
    <div className="max-h-64 overflow-auto rounded-md border border-line bg-base/50 px-2 py-1.5 text-[11px] leading-[1.5]">
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
