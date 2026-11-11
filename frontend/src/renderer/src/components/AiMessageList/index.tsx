import { useEffect, useRef } from 'react'
import { FileDiff, Folder, Loader2 } from 'lucide-react'
import { attachmentKey } from '@shared/ai/attachments'
import type { AiAttachmentView, ToolFileChange } from '@shared/ai/types'
import FileRow from '../FileRow'
import MarkdownPreview from '../MarkdownPreview'
import ToolCallRow from '../ToolCallRow'
import { attachmentLineLabel } from '../../lib/aiAttachment'
import { basename } from '../../lib/filePath'
import { cn } from '../../lib/utils'
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
              />
            )
          case 'tool':
            return (
              <ToolCallRow key={message.id} message={message} cwd={cwd} onOpenFile={onOpenFile} />
            )
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
              return (
                <li
                  key={attachmentKey(attachment)}
                  className="inline-flex h-5 max-w-[220px] items-center rounded-[3px] border border-line bg-base px-1 text-[11px] leading-5 text-dim"
                >
                  {attachment.kind === 'directory' ? (
                    content
                  ) : (
                    <button
                      type="button"
                      className="inline-flex min-w-0 cursor-pointer items-center border-none bg-transparent p-0 text-inherit transition-colors hover:text-fg"
                      aria-label={`打开 ${basename(attachment.path)}`}
                      title={`打开 ${attachment.path}`}
                      onClick={() => onOpenFile(attachment.path)}
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
  interrupted
}: {
  text: string
  interrupted?: boolean
}): React.JSX.Element {
  return (
    <div className="mb-3">
      <MarkdownPreview content={text} variant="message" />
      {interrupted ? (
        <p className="mt-1 mb-0 text-[11px] leading-[1.5] text-dim">
          已停止生成，以上是中断前的内容
        </p>
      ) : null}
    </div>
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
