import { useEffect, useRef, useState } from 'react'
import { Check, Copy, FileDiff, Folder, Loader2 } from 'lucide-react'
import { attachmentKey } from '@shared/ai/attachments'
import type { AiAttachmentView, ToolFileChange } from '@shared/ai/types'
import AiQuestionCard from '../AiQuestionCard'
import FileRow from '../FileRow'
import GitStatusBadge from '../GitStatusBadge'
import MarkdownPreview from '../MarkdownPreview'
import TodoPlan from '../TodoPlan'
import ToolCallRow from '../ToolCallRow'
import { attachmentLineLabel } from '../../lib/aiAttachment'
import { basename } from '../../lib/filePath'
import { GIT_STATUS_TEXT_CLASS, statusFromChangeCode } from '../../lib/gitStatus'
import type { AiMessageListProps } from './types'

/** 距底部多少像素内视为“停在底部”：新内容到来时继续自动滚动 */
const PIN_THRESHOLD = 48

/**
 * 对话消息列表：用户消息右对齐气泡，助手回复走 MarkdownPreview，
 * 工具调用显示为一行式调用行（状态 + 单行摘要，点击展开），结果按 callId 回填。
 */
export default function AiMessageList({
  messages,
  running,
  error,
  emptyHint,
  cwd,
  onAnswerQuestion,
  onOpenFile
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

  // 最后一张任务清单快照默认展开；更早的快照只留一行进度，避免同一份清单反复铺满对话
  const latestPlanId = messages.findLast(
    (message) =>
      message.kind === 'tool' &&
      message.card?.kind === 'todo' &&
      (message.card.todos?.length ?? 0) > 0
  )?.id

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
            return (
              <UserBubble
                key={message.id}
                text={message.text}
                attachments={message.attachments}
                onOpenFile={onOpenFile}
              />
            )
          case 'assistant':
            return (
              <AssistantMessage
                key={message.id}
                text={message.text}
                interrupted={message.interrupted}
                cwd={cwd}
                onOpenFile={onOpenFile}
              />
            )
          case 'tool':
            // 询问用户：卡片本身就是交互界面，由 AiQuestionCard 接管；回答后同一张卡回放答案
            if (message.card?.kind === 'question' && (message.card.questions?.length ?? 0) > 0) {
              return (
                <AiQuestionCard
                  key={message.id}
                  message={message}
                  active={running}
                  onAnswer={(answers) => onAnswerQuestion(message.callId, answers)}
                />
              )
            }
            // 任务清单换成 Trace 展示；没有清单快照（参数非法 / 失败）时仍走通用工具行
            return message.card?.kind === 'todo' && (message.card.todos?.length ?? 0) > 0 ? (
              <TodoPlan
                // key 带上「是否最新」：新的快照出现时，上一份会重挂载为收起状态
                key={`${message.id}:${message.id === latestPlanId ? 'latest' : 'history'}`}
                message={message}
                defaultExpanded={message.id === latestPlanId}
              />
            ) : (
              <ToolCallRow key={message.id} message={message} cwd={cwd} onOpenFile={onOpenFile} />
            )
          case 'changes':
            return <ChangesSummary key={message.id} files={message.files} onOpenFile={onOpenFile} />
          case 'turn-footer':
            return <TurnFooter key={message.id} time={message.time} text={message.text} />
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

/**
 * 用户消息：右对齐气泡，保留原始换行；附加的上下文以小标签排在正文下方，
 * 复用文件树的 FileRow，目录与选中行用图标/行号区分。
 */
function UserBubble({
  text,
  attachments,
  onOpenFile
}: {
  text: string
  attachments?: readonly AiAttachmentView[]
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  return (
    <div className="mb-3 flex justify-end">
      <div className="max-w-[85%] rounded-md border border-line bg-elevated px-2.5 py-1.5">
        {text.length > 0 ? (
          <p className="m-0 text-[13px] leading-[1.6] break-words whitespace-pre-wrap text-fg">
            {text}
          </p>
        ) : null}
        {attachments && attachments.length > 0 ? (
          <ul className="mt-1.5 flex list-none flex-wrap gap-1 p-0">
            {attachments.map((attachment) => {
              const lineLabel = attachmentLineLabel(attachment)
              const content = (
                <>
                  <FileRow
                    name={basename(attachment.path)}
                    icon={
                      attachment.kind === 'directory' ? (
                        <Folder className="size-3.5 fill-current text-[#dcb67a]" />
                      ) : undefined
                    }
                    className="gap-1"
                  />
                  {lineLabel ? (
                    <span className="ml-0.5 shrink-0 text-[10px]">{lineLabel}</span>
                  ) : null}
                </>
              )
              // 粘贴的图片在这里没有工作区路径：点开的是主进程存下来的图片文件
              const openTarget =
                attachment.kind === 'image' ? attachment.image?.previewPath : attachment.path
              return (
                <li
                  key={attachmentKey(attachment)}
                  className="inline-flex h-5 max-w-[220px] items-center rounded-[3px] border border-line bg-base px-1 text-[11px] leading-5 text-dim"
                >
                  {attachment.kind === 'directory' || openTarget === undefined ? (
                    <span className="min-w-0 truncate" title={attachment.path}>
                      {content}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex min-w-0 cursor-pointer items-center border-none bg-transparent p-0 text-inherit transition-colors hover:text-fg"
                      aria-label={`打开 ${basename(attachment.path)}`}
                      title={`打开 ${openTarget}`}
                      onClick={() => onOpenFile(openTarget)}
                    >
                      {content}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 助手回复：直接复用文件预览的 Markdown 渲染（message 变体，紧凑排版）。
 * 被用户中止打断的那段在末尾补一行说明，避免读者把半截回答当成结论。
 */
function AssistantMessage({
  text,
  interrupted,
  cwd,
  onOpenFile
}: {
  text: string
  interrupted?: boolean
  /** 当前工作区根：正文里的相对文件路径按它解析 */
  cwd: string | null
  /** 点击正文中的文件路径：在编辑器中打开并定位到行（endLine 存在时选中行范围） */
  onOpenFile: (path: string, line?: number, endLine?: number) => void
}): React.JSX.Element {
  return (
    <div className="mb-3">
      <MarkdownPreview
        content={text}
        variant="message"
        workspaceRoot={cwd}
        onOpenFile={onOpenFile}
      />
      {interrupted ? (
        <p className="mt-1 mb-0 text-[11px] leading-[1.5] text-dim">
          已停止生成，以上是中断前的内容
        </p>
      ) : null}
    </div>
  )
}

/** 本地时间：YYYY-MM-DD HH:mm:ss */
function formatTime(time: number): string {
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 本轮改动清单：每轮结束后的文件列表，显示新增/删除行数与 A/M 状态。
 * 点击某一行只打开对应文件；diff 审查只由底部的会话变更文件面板触发。
 */
function ChangesSummary({
  files,
  onOpenFile
}: {
  files: readonly ToolFileChange[]
  onOpenFile: (path: string) => void
}): React.JSX.Element {
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
        {files.map((file) => {
          const gitStatus = statusFromChangeCode(file.status)
          return (
            <li key={file.path}>
              <button
                type="button"
                className="flex w-full cursor-pointer items-center border-none bg-transparent px-2 py-1 text-left text-[12px] transition-colors hover:bg-hover/60"
                title={`打开 ${file.path}`}
                onClick={() => onOpenFile(file.path)}
              >
                <FileRow
                  name={basename(file.path)}
                  className="min-w-0 flex-1"
                  nameClassName={GIT_STATUS_TEXT_CLASS[gitStatus]}
                  trailing={
                    <span className="flex items-center gap-1.5 text-[11px]">
                      <span className="text-link">+{file.added}</span>
                      <span className="text-danger">-{file.removed}</span>
                      <GitStatusBadge status={gitStatus} className="ml-0 w-auto" />
                    </span>
                  }
                />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * 每轮对话底部的结束页脚：复制本轮 AI 文本（Markdown）+ 本轮结束时间。
 * 复制按钮只在有 AI 文本时出现；复制反馈短暂显示“已复制”。
 */
function TurnFooter({ time, text }: { time: number; text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
      }
    }
  }, [])

  const handleCopy = (): void => {
    if (text.length === 0) {
      return
    }
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current)
        }
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          setCopied(false)
        }, 1500)
      },
      () => undefined
    )
  }

  return (
    <div className="mb-3 flex items-center gap-2 px-1 text-[11px] text-dim">
      {text.length > 0 ? (
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1 rounded-[3px] border-none bg-transparent px-1 py-0.5 text-[11px] text-dim transition-colors hover:bg-hover/60 hover:text-fg"
          title="复制本轮 AI 回复为 Markdown"
          aria-label="复制本轮 AI 回复为 Markdown"
          onClick={handleCopy}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? '已复制' : '复制 Markdown'}
        </button>
      ) : null}
      <span className="ml-auto font-mono text-[10px] text-dim/80">{formatTime(time)}</span>
    </div>
  )
}
