import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, FileDiff } from 'lucide-react'
import type { AiFileReview, AiMessageView, ToolFileChange } from '@shared/ai/types'
import { basename } from '../../lib/filePath'
import { cn } from '../../lib/utils'
import FileIcon from '../FileIcon'
import type { SessionChangesPanelProps } from './types'

/** 一个文件在本会话内的累计改动；turn 取最早出现的那一轮，作为 diff 基线 */
interface SessionChangedFile extends ToolFileChange {
  turn: number
}

/** 文件/会话的审查状态 */
type ReviewState = 'accepted' | 'partial' | 'rejected' | 'pending'

const REVIEW_LABEL: Record<ReviewState, string> = {
  accepted: '已接受',
  partial: '部分接受',
  rejected: '已拒绝',
  pending: '待确认'
}

const REVIEW_CLASS: Record<ReviewState, string> = {
  accepted: 'text-link',
  partial: 'text-fg',
  rejected: 'text-danger',
  pending: 'text-dim'
}

/**
 * 由审查进度推导状态：
 * - 采纳过且没有剩余/拒绝 → 已接受
 * - 采纳过但仍有剩余或有拒绝 → 部分接受
 * - 一个都没采纳、拒绝过 → 已拒绝
 * - 还没有任何操作 → 待确认
 */
function fileReviewState(review: AiFileReview | undefined): ReviewState {
  if (review === undefined) {
    return 'pending'
  }
  if (review.accepted > 0 && review.remaining === 0 && review.rejected === 0) {
    return 'accepted'
  }
  if (review.accepted > 0) {
    return 'partial'
  }
  if (review.rejected > 0) {
    return 'rejected'
  }
  return 'pending'
}

/** 会话级状态：全部接受才叫已接受；有任一接受/部分接受即部分接受；否则按拒绝/待确认 */
function aggregateReviewState(
  files: readonly SessionChangedFile[],
  reviews: ReadonlyMap<string, AiFileReview>
): ReviewState {
  const states = files.map((file) => fileReviewState(reviews.get(file.path)))
  if (states.every((state) => state === 'accepted')) {
    return 'accepted'
  }
  if (states.some((state) => state === 'accepted' || state === 'partial')) {
    return 'partial'
  }
  if (states.some((state) => state === 'rejected')) {
    return 'rejected'
  }
  return 'pending'
}

/**
 * 把各轮 changes 消息聚合成整场会话的文件清单。
 * 同一文件在多轮被改时：行数累计，turn 取最早一轮（该轮的基线就是本会话第一次改动前的内容），
 * 状态 A 优先（本会话创建过）。
 */
function collectSessionChanges(messages: readonly AiMessageView[]): SessionChangedFile[] {
  // 先按 turn + path 去重：同一轮的进行中清单与最终清单不应重复累计
  const perTurn = new Map<string, SessionChangedFile>()
  for (const message of messages) {
    if (message.kind !== 'changes' || message.turn === undefined) {
      continue
    }
    for (const file of message.files) {
      const key = `${message.turn}:${file.path}`
      if (!perTurn.has(key)) {
        perTurn.set(key, { ...file, turn: message.turn })
      }
    }
  }
  const byPath = new Map<string, SessionChangedFile>()
  for (const file of perTurn.values()) {
    const existing = byPath.get(file.path)
    if (existing === undefined) {
      byPath.set(file.path, { ...file })
      continue
    }
    existing.added += file.added
    existing.removed += file.removed
    existing.turn = Math.min(existing.turn, file.turn)
    if (file.status === 'A') {
      existing.status = 'A'
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * 对话底部固定的变更文件面板。
 *
 * 记录的是**整个会话**的变更文件（跨轮聚合），只有点击这里的文件行才会打开
 * 前面的 Monaco diff 审查；消息流里的工具行与每轮清单不再触发审查。
 * 右侧状态来自用户对 hunk 的采纳/拒绝进度，随审查操作实时刷新。
 */
export default function SessionChangesPanel({
  messages,
  cwd,
  sessionId,
  reviewsVersion,
  onOpenChange
}: SessionChangesPanelProps): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  const [reviews, setReviews] = useState<ReadonlyMap<string, AiFileReview>>(new Map())
  const files = useMemo(() => collectSessionChanges(messages), [messages])

  // 审查进度保存在主进程的会话目录里；版本变化（采纳/拒绝）后重新读取
  useEffect(() => {
    if (cwd === null || sessionId === null) {
      return
    }
    let cancelled = false
    void window.api.ai
      .readReviews(cwd, sessionId)
      .then((list) => {
        if (!cancelled) {
          setReviews(new Map(list.map((review) => [review.path, review])))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReviews(new Map())
        }
      })
    return () => {
      cancelled = true
    }
  }, [cwd, reviewsVersion, sessionId])

  const added = files.reduce((total, file) => total + file.added, 0)
  const removed = files.reduce((total, file) => total + file.removed, 0)
  const sessionState = aggregateReviewState(files, reviews)

  if (files.length === 0) {
    return null
  }

  return (
    <section className="shrink-0 border-t border-line bg-elevated" aria-label="本会话变更文件">
      <button
        type="button"
        className="flex h-8 w-full cursor-pointer items-center gap-1.5 border-none bg-transparent px-2 text-left transition-colors hover:bg-hover/50"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <FileDiff className="size-3.5 shrink-0 text-dim" />
        <span className="shrink-0 text-[12px] text-fg">变更文件</span>
        <span className="shrink-0 text-[11px] text-dim">{files.length}</span>
        <span className="shrink-0 font-mono text-[11px] text-link">+{added}</span>
        <span className="shrink-0 font-mono text-[11px] text-danger">-{removed}</span>
        <span
          className={cn('ml-auto shrink-0 text-[11px] font-medium', REVIEW_CLASS[sessionState])}
        >
          {REVIEW_LABEL[sessionState]}
        </span>
        <ChevronDown
          className={cn(
            'ml-1 size-3.5 shrink-0 text-dim transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>
      {open ? (
        <ul className="m-0 max-h-44 list-none overflow-y-auto border-t border-line/60 p-0">
          {files.map((file) => {
            const state = fileReviewState(reviews.get(file.path))
            return (
              <li key={file.path}>
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-1.5 border-none bg-transparent px-2 py-1 text-left text-[12px] transition-colors hover:bg-hover/60"
                  title={`查看 ${file.path} 在本会话的改动 · ${REVIEW_LABEL[state]}`}
                  onClick={() => onOpenChange(file.path, file.turn)}
                >
                  <span className="inline-flex shrink-0 items-center justify-center">
                    <FileIcon name={basename(file.path)} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fg">{file.path}</span>
                  <span className="shrink-0 font-mono text-[11px]">
                    <span className="text-link">+{file.added}</span>{' '}
                    <span className="text-danger">-{file.removed}</span>
                  </span>
                  <span
                    className={cn(
                      'w-3 shrink-0 text-[10px] font-medium',
                      file.status === 'A' ? 'text-link' : 'text-dim'
                    )}
                  >
                    {file.status}
                  </span>
                  <span className={cn('w-12 shrink-0 text-right text-[10px]', REVIEW_CLASS[state])}>
                    {REVIEW_LABEL[state]}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
