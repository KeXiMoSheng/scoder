import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCheck, FileDiff, Loader2, MoveDown, MoveUp, RefreshCw, Undo2, X } from 'lucide-react'
import { extractErrorMessage } from '../../lib/errorMessage'
import { basename } from '../../lib/filePath'
import { detectLanguage } from '../../lib/language'
import { monaco } from '../../lib/monaco'
import { getActiveThemeId } from '../../lib/theme'
import MessageDialog from '../MessageDialog'
import { Button } from '../ui/button'
import type { AiFileReview } from '@shared/ai/types'
import type { AiDiffViewProps } from './types'

/** 文件原始换行风格：diff 内部统一 LF，写回时还原 */
type Eol = '\n' | '\r\n'

/**
 * 一处连续的变更块（hunk）：由 original / modified 两份文本做行级 diff 得到。
 * 行号约定与 unified diff 一致：纯插入 oldLines=0、oldStart 是插入点；
 * 纯删除 newLines=0、newStart 是删除点。
 */
interface ReviewHunk {
  /** 在本文件变更列表中的序号（0 起） */
  index: number
  /** 原文件起始行（1 起）；纯插入时为插入点（前一行） */
  oldStart: number
  /** 原文件行数；纯插入为 0 */
  oldLines: number
  /** 修改后文件起始行（1 起）；纯删除时为删除点（前一行） */
  newStart: number
  /** 修改后文件行数；纯删除为 0 */
  newLines: number
  /** 本块新增行数 */
  added: number
  /** 本块删除行数 */
  removed: number
}

/** 一次加载到的 diff 数据：两个 model 的初始内容 */
interface DiffSource {
  original: string
  modified: string
  eol: Eol
  /** 每次重新加载都换一个值，用于重建 Monaco 实例 */
  key: string
}

/** 把 Monaco 对两份文本的行级比较结果整理成 hunk 数组 */
function toHunks(changes: readonly monaco.editor.ILineChange[]): ReviewHunk[] {
  return changes.map((change, index) => {
    const oldLines =
      change.originalEndLineNumber > 0
        ? change.originalEndLineNumber - change.originalStartLineNumber + 1
        : 0
    const newLines =
      change.modifiedEndLineNumber > 0
        ? change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1
        : 0
    return {
      index,
      oldStart: change.originalStartLineNumber,
      oldLines,
      newStart: change.modifiedStartLineNumber,
      newLines,
      added: newLines,
      removed: oldLines
    }
  })
}

/**
 * 把一处变更还原成改动前的内容。
 * Monaco 的约定：EndLineNumber 为 0 表示纯插入（原文件没有这几行）或纯删除
 * （新文件没有这几行），此时 StartLineNumber 是插入/删除发生的位置（前一行）。
 */
function revertHunkText(
  current: string,
  hunk: ReviewHunk,
  originalLines: readonly string[]
): string {
  // 整个文件被删空：这一处改动的还原结果就是完整原文
  if (current === '') {
    return originalLines.join('\n')
  }
  const lines = current.split('\n')
  const originalStart = hunk.oldLines > 0 ? hunk.oldStart - 1 : hunk.oldStart
  const modifiedStart = hunk.newLines > 0 ? hunk.newStart - 1 : hunk.newStart
  lines.splice(
    modifiedStart,
    hunk.newLines,
    ...originalLines.slice(originalStart, originalStart + hunk.oldLines)
  )
  return lines.join('\n')
}

/**
 * 接受一处改动：把新文件里的这段内容并进 diff 基线，
 * 这一块随即从待审阅的 diff 里消失（磁盘上的文件内容不变）。
 */
function applyHunkToOriginal(
  original: string,
  hunk: ReviewHunk,
  modifiedLines: readonly string[]
): string {
  // 原本是空文件（新建后整份写入）：接受这一处改动即接受整份新内容
  if (original === '') {
    return modifiedLines.join('\n')
  }
  const lines = original.split('\n')
  const originalStart = hunk.oldLines > 0 ? hunk.oldStart - 1 : hunk.oldStart
  const modifiedStart = hunk.newLines > 0 ? hunk.newStart - 1 : hunk.newStart
  lines.splice(
    originalStart,
    hunk.oldLines,
    ...modifiedLines.slice(modifiedStart, modifiedStart + hunk.newLines)
  )
  return lines.join('\n')
}

/** 写回文本文件：沿用目标文件已有编码，完成后原子替换 */
async function writeTextFile(path: string, text: string): Promise<void> {
  const { writeId } = await window.api.openWriteStream(path)
  try {
    await window.api.appendWriteChunk(writeId, text)
    await window.api.finishWriteStream(writeId)
  } catch (error) {
    await window.api.abortWriteStream(writeId).catch(() => undefined)
    throw error
  }
}

/** 还原原文的换行风格 */
function restoreEol(text: string, eol: Eol): string {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

/** 底部固定审查条的按钮样式 */
const REVIEW_BAR_BUTTON_CLASS =
  'flex h-6 cursor-pointer items-center gap-1 rounded-[3px] border-none bg-transparent px-1.5 text-[11px] leading-none text-fg transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-40'

/**
 * AI 改动审查视图。
 *
 * 视觉与交互对齐 Qoder：
 * - 单栏 inline unified（renderSideBySide=false），Git 风格红删/绿增；
 * - 未改动内容全部可见，不做 unchanged-region 折叠；
 * - 编辑器底部居中悬浮审查条：`↑ 1 / 9 ↓  拒绝  采纳`；
 * - 单块采纳/拒绝之外，顶部还有文件的采纳全部/拒绝全部；
 * - Ctrl+Enter 采纳当前块，Ctrl+Backspace 拒绝当前块。
 *
 * 同一文件一轮里被改多次时，diff 基线是第一次改动前的内容，
 * 因此这里看到的是本轮全部 hunk，而不是最后一次编辑的片段。
 */
export default function AiDiffView({
  sessionId,
  turn,
  path,
  absolutePath,
  cwd,
  dirty,
  onClose,
  onOpenFile,
  onReviewChange
}: AiDiffViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const eolRef = useRef<Eol>('\n')
  /** 打开 diff 时磁盘上的文本（LF）：写回前比对，避免覆盖审查期间的外部改动 */
  const diskTextRef = useRef('')
  const decorationRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const busyRef = useRef(false)
  const dirtyRef = useRef(dirty)
  /** 当前审查的 hunk 下标：按钮、快捷键与导航都围绕它工作 */
  const activeIndexRef = useRef(0)
  /** 本文件的审查进度：接受/拒绝累加，remaining 随 hunk 数同步 */
  const reviewRef = useRef<AiFileReview>({
    path,
    accepted: 0,
    rejected: 0,
    remaining: 0,
    updatedAt: 0
  })
  const onReviewChangeRef = useRef(onReviewChange)
  useEffect(() => {
    onReviewChangeRef.current = onReviewChange
  }, [onReviewChange])

  /** 更新本地审查进度并异步落盘；失败只影响面板刷新，不影响文件操作本身 */
  const queueReview = useCallback(
    (review: AiFileReview): void => {
      reviewRef.current = review
      if (cwd === null) {
        return
      }
      void window.api.ai
        .saveReview(cwd, sessionId, review)
        .then(() => onReviewChangeRef.current?.())
        .catch((error: unknown) => console.warn('保存审查进度失败', error))
    },
    [cwd, sessionId]
  )

  /** hunk 数变化时同步 remaining（打开 diff、刷新、接受/拒绝后都会走到） */
  const syncReviewRemaining = useCallback(
    (remaining: number): void => {
      if (reviewRef.current.remaining === remaining) {
        return
      }
      queueReview({ ...reviewRef.current, remaining, updatedAt: Date.now() })
    },
    [queueReview]
  )
  const syncReviewRef = useRef(syncReviewRemaining)
  useEffect(() => {
    syncReviewRef.current = syncReviewRemaining
  }, [syncReviewRemaining])

  const [source, setSource] = useState<DiffSource | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [hunks, setHunks] = useState<ReviewHunk[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirmRejectAll, setConfirmRejectAll] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  // AI 在同一轮里继续改这个文件时，自动刷新审查视图（基线仍在首次改动前），
  // 这样后一次改动会作为新的 hunk 出现，而不是停留在旧快照上。
  useEffect(() => {
    let timer: number | null = null
    const unsubscribe = window.api.ai.onEvent(({ sessionId: sourceId, event }) => {
      if (sourceId !== sessionId || event.type !== 'file-changed') {
        return
      }
      if (!event.paths.includes(path)) {
        return
      }
      if (timer !== null) {
        window.clearTimeout(timer)
      }
      timer = window.setTimeout(() => {
        timer = null
        if (!busyRef.current) {
          setStatus('loading')
          setReloadNonce((nonce) => nonce + 1)
        }
      }, 200)
    })
    return () => {
      unsubscribe()
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [path, sessionId])

  // 读取基线 + 当前文件内容。重新加载（刷新按钮）也走这里。
  useEffect(() => {
    // diff 视图只有在打开项目后才可能打开；这里只做类型收窄
    if (cwd === null) {
      return
    }
    let cancelled = false
    activeIndexRef.current = 0
    void (async (): Promise<void> => {
      try {
        const [baseline, raw] = await Promise.all([
          window.api.ai.readChangeBaseline(cwd, sessionId, turn, path),
          window.api.readFile(absolutePath)
        ])
        if (cancelled) {
          return
        }
        if (baseline === null) {
          throw new Error('这一轮没有记录该文件的改动基线（旧会话，或文件是被命令改动的）')
        }
        if (baseline.before === null && baseline.status !== 'A') {
          throw new Error('改动基线不可用：文件当时过大或不是可识别的文本')
        }
        const eol: Eol = raw.includes('\r\n') ? '\r\n' : '\n'
        diskTextRef.current = raw.replace(/\r\n/g, '\n')
        reviewRef.current = baseline.review ?? {
          path,
          accepted: 0,
          rejected: 0,
          remaining: 0,
          updatedAt: 0
        }
        setError(null)
        setNotice(null)
        setHunks([])
        setActiveIndex(0)
        setSource({
          original: baseline.status === 'A' ? '' : (baseline.before ?? ''),
          modified: raw.replace(/\r\n/g, '\n'),
          eol,
          key: `${Date.now()}-${reloadNonce}`
        })
        setStatus('ready')
      } catch (reason) {
        if (!cancelled) {
          setStatus('error')
          setError(extractErrorMessage(reason))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [absolutePath, cwd, path, reloadNonce, sessionId, turn])

  // 创建 Monaco inline diff 实例。重新加载时 source 换新对象，旧实例随之销毁。
  useEffect(() => {
    const container = containerRef.current
    if (source === null || container === null) {
      return
    }
    const language = detectLanguage(basename(path))
    const stamp = source.key.replace(/[^A-Za-z0-9-]/g, '')
    const original = monaco.editor.createModel(
      source.original,
      language,
      monaco.Uri.parse(`inmemory://scoder-diff/${stamp}/original`)
    )
    const modified = monaco.editor.createModel(
      source.modified,
      language,
      monaco.Uri.parse(`inmemory://scoder-diff/${stamp}/modified`)
    )
    originalModelRef.current = original
    modifiedModelRef.current = modified
    eolRef.current = source.eol

    const diff = monaco.editor.createDiffEditor(container, {
      theme: getActiveThemeId(),
      automaticLayout: true,
      // 单栏行内统一视图：不开启左右分栏
      renderSideBySide: false,
      readOnly: true,
      originalEditable: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      overviewRulerBorder: false,
      renderOverviewRuler: false,
      // 不做「显示空白字符差异」：AI 改动之外的格式噪声不应出现红绿
      ignoreTrimWhitespace: false,
      diffAlgorithm: 'advanced',
      // 由我们自己的逐块操作条提供接受/拒绝，不显示 Monaco 的 revert 箭头
      renderMarginRevertIcon: false,
      // 未改动内容保持可见：审查条固定在底部，不折叠上下文
      hideUnchangedRegions: { enabled: false },
      smoothScrolling: true,
      fixedOverflowWidgets: true
    })
    diff.setModel({ original, modified })
    diffRef.current = diff
    const decorations = diff.getModifiedEditor().createDecorationsCollection([])
    decorationRef.current = decorations

    /**
     * 用两份 model 的行级比较结果重建 hunk 数组。
     * 接受/拒绝后 hunk 会消失或移动，当前审查块尽量停在原下标（即下一处）。
     */
    const refreshHunks = (): void => {
      const next = toHunks(diff.getLineChanges() ?? [])
      setHunks(next)
      const clamped = Math.max(0, Math.min(activeIndexRef.current, next.length - 1))
      activeIndexRef.current = clamped
      setActiveIndex(clamped)
      syncReviewRef.current(next.length)
    }
    const listener = diff.onDidUpdateDiff(refreshHunks)
    const frame = requestAnimationFrame(refreshHunks)

    return () => {
      cancelAnimationFrame(frame)
      listener.dispose()
      decorations.clear()
      decorationRef.current = null
      diff.dispose()
      diffRef.current = null
      originalModelRef.current = null
      modifiedModelRef.current = null
      original.dispose()
      modified.dispose()
    }
  }, [path, source])

  /**
   * 写回审查结果：先确认磁盘文件自打开 diff 后没有被外部改动。
   * 若目标内容已经在磁盘上（例如采纳 AI 已写入的内容），不重复写盘，
   * 避免无意义的 mtime 变化打断仍在执行的 AI 对话（写工具的 CAS 会因此失效）。
   */
  const writeReviewText = useCallback(
    async (text: string): Promise<void> => {
      const raw = await window.api.readFile(absolutePath)
      const current = raw.replace(/\r\n/g, '\n')
      if (current !== diskTextRef.current) {
        throw new Error('文件已在磁盘上发生变化，请先点击「刷新」重新读取')
      }
      if (current === text) {
        return
      }
      await writeTextFile(absolutePath, restoreEol(text, eolRef.current))
      diskTextRef.current = text
    },
    [absolutePath]
  )

  /** 切换到本文件的上一处 / 下一处变更（越界时停在当前块） */
  const navigateTo = useCallback(
    (index: number): void => {
      if (hunks.length === 0) {
        return
      }
      const next = Math.max(0, Math.min(index, hunks.length - 1))
      activeIndexRef.current = next
      setActiveIndex(next)
    },
    [hunks.length]
  )

  /**
   * 采纳一处 hunk：把当前 modified 内容写回磁盘，并把这一块并进 diff 基线。
   *
   * AI 的 write/edit 已经把改动落到磁盘；这里显式再写一次，保证「采纳」后
   * 编辑器/磁盘就是当前审查内容（已拒绝的块不会回流），同时推进基线，
   * 重新打开 diff 时这一块不再出现。
   */
  const acceptHunk = useCallback(
    async (hunk: ReviewHunk): Promise<void> => {
      if (busyRef.current || cwd === null) {
        return
      }
      if (dirtyRef.current) {
        setError('文件有未保存的修改，请先在编辑器中保存或关闭标签，再采纳 AI 改动')
        return
      }
      const originalModel = originalModelRef.current
      const modifiedModel = modifiedModelRef.current
      if (originalModel === null || modifiedModel === null) {
        return
      }
      const modifiedText = modifiedModel.getValue()
      const nextBaseline = applyHunkToOriginal(
        originalModel.getValue(),
        hunk,
        modifiedText.split('\n')
      )
      busyRef.current = true
      setBusy(true)
      setError(null)
      try {
        // 采纳 = 确认磁盘内容；写回当前 modified 文本（已拒绝的 hunk 不会回来）
        await writeReviewText(modifiedText)
        await window.api.ai.saveChangeBaseline(cwd, sessionId, turn, path, nextBaseline)
        originalModel.setValue(nextBaseline)
        const review = reviewRef.current
        queueReview({
          path,
          accepted: review.accepted + 1,
          rejected: review.rejected,
          remaining: Math.max(0, hunks.length - 1),
          updatedAt: Date.now()
        })
        setNotice(`已采纳第 ${hunk.index + 1} 处改动`)
      } catch (reason) {
        setError(`采纳改动失败：${extractErrorMessage(reason)}`)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [hunks.length, path, queueReview, writeReviewText, cwd, sessionId, turn]
  )

  /** 拒绝一处 hunk：把这一段恢复成改动前的内容并写回磁盘 */
  const rejectHunk = useCallback(
    async (hunk: ReviewHunk): Promise<void> => {
      if (busyRef.current) {
        return
      }
      if (dirtyRef.current) {
        setError('文件有未保存的修改，请先在编辑器中保存或关闭标签，再拒绝 AI 改动')
        return
      }
      const modifiedModel = modifiedModelRef.current
      const originalModel = originalModelRef.current
      if (modifiedModel === null || originalModel === null) {
        return
      }
      busyRef.current = true
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        const next = revertHunkText(
          modifiedModel.getValue(),
          hunk,
          originalModel.getValue().split('\n')
        )
        // 先落盘再更新视图：写失败时屏幕上仍然与磁盘一致
        await writeReviewText(next)
        modifiedModel.setValue(next)
        const review = reviewRef.current
        queueReview({
          path,
          accepted: review.accepted,
          rejected: review.rejected + 1,
          remaining: Math.max(0, hunks.length - 1),
          updatedAt: Date.now()
        })
        setNotice(`已拒绝第 ${hunk.index + 1} 处改动，文件已恢复`)
      } catch (reason) {
        setError(`拒绝改动失败：${extractErrorMessage(reason)}`)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [hunks.length, path, queueReview, writeReviewText]
  )

  const acceptActive = useCallback((): void => {
    const hunk = hunks[activeIndex]
    if (hunk !== undefined) {
      void acceptHunk(hunk)
    }
  }, [acceptHunk, activeIndex, hunks])

  const rejectActive = useCallback((): void => {
    const hunk = hunks[activeIndex]
    if (hunk !== undefined) {
      void rejectHunk(hunk)
    }
  }, [activeIndex, hunks, rejectHunk])

  /** 文件级采纳：把整份 modified 写回磁盘并并进基线 */
  const acceptAll = useCallback(async (): Promise<void> => {
    if (busyRef.current || cwd === null) {
      return
    }
    if (dirtyRef.current) {
      setError('文件有未保存的修改，请先在编辑器中保存或关闭标签，再采纳 AI 改动')
      return
    }
    const originalModel = originalModelRef.current
    const modifiedModel = modifiedModelRef.current
    if (originalModel === null || modifiedModel === null) {
      return
    }
    const next = modifiedModel.getValue()
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await writeReviewText(next)
      await window.api.ai.saveChangeBaseline(cwd, sessionId, turn, path, next)
      originalModel.setValue(next)
      const review = reviewRef.current
      queueReview({
        path,
        accepted: review.accepted + hunks.length,
        rejected: review.rejected,
        remaining: 0,
        updatedAt: Date.now()
      })
      setNotice('已采纳全部改动')
    } catch (reason) {
      setError(`采纳全部改动失败：${extractErrorMessage(reason)}`)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [hunks.length, path, queueReview, writeReviewText, cwd, sessionId, turn])

  // 当前审查块：高亮对应行，并把编辑器滚动到该行；隐藏的上下文区域会随之展开
  useEffect(() => {
    const diff = diffRef.current
    const decorations = decorationRef.current
    if (diff === null || decorations === null) {
      return
    }
    const hunk = hunks[activeIndex]
    const editor = diff.getModifiedEditor()
    const model = editor.getModel()
    if (hunk === undefined || model === null) {
      decorations.clear()
      return
    }
    const start = Math.min(Math.max(1, hunk.newStart), model.getLineCount())
    const end = hunk.newLines > 0 ? hunk.newStart + hunk.newLines - 1 : start
    const endLine = Math.min(Math.max(start, end), model.getLineCount())
    decorations.set([
      {
        range: new monaco.Range(start, 1, endLine, model.getLineMaxColumn(endLine)),
        options: { isWholeLine: true, className: 'ai-diff-active-hunk' }
      }
    ])
    const frame = requestAnimationFrame(() => {
      editor.setPosition({ lineNumber: start, column: 1 })
      editor.revealLineInCenter(start)
    })
    return () => cancelAnimationFrame(frame)
  }, [activeIndex, hunks])

  // Ctrl+Enter 采纳当前块，Ctrl+Backspace 拒绝当前块（捕获阶段先于 Monaco 处理）
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || confirmRejectAll) {
        return
      }
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) {
        return
      }
      const target = event.target as HTMLElement | null
      // Monaco 自己用一个隐藏 textarea 接收键盘；只有焦点在审查视图之外的
      // 真实输入框（例如 AI 输入框）里时，才把快捷键让回去
      const inReview = target !== null && containerRef.current?.contains(target) === true
      if (
        !inReview &&
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        acceptActive()
      } else if (event.key === 'Backspace') {
        event.preventDefault()
        event.stopPropagation()
        rejectActive()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [acceptActive, confirmRejectAll, rejectActive])

  /** 拒绝全部：直接把本轮改动前的内容写回文件 */
  const rejectAll = useCallback(async (): Promise<void> => {
    setConfirmRejectAll(false)
    if (busyRef.current) {
      return
    }
    if (dirtyRef.current) {
      setError('文件有未保存的修改，请先在编辑器中保存或关闭标签，再拒绝 AI 改动')
      return
    }
    const modifiedModel = modifiedModelRef.current
    const originalModel = originalModelRef.current
    if (modifiedModel === null || originalModel === null) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      // 已接受的块已经并进 originalModel，这里只回退仍待处理的改动
      const baseline = originalModel.getValue()
      await writeReviewText(baseline)
      modifiedModel.setValue(baseline)
      const review = reviewRef.current
      queueReview({
        path,
        accepted: review.accepted,
        rejected: review.rejected + hunks.length,
        remaining: 0,
        updatedAt: Date.now()
      })
      setNotice('已拒绝全部改动，文件已恢复为改动前的内容')
    } catch (reason) {
      setError(`拒绝全部改动失败：${extractErrorMessage(reason)}`)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [hunks.length, path, queueReview, writeReviewText])

  const added = hunks.reduce((total, hunk) => total + hunk.added, 0)
  const removed = hunks.reduce((total, hunk) => total + hunk.removed, 0)

  const handleReload = useCallback((): void => {
    setStatus('loading')
    setReloadNonce((nonce) => nonce + 1)
  }, [])

  const handleOpenPlainFile = useCallback((): void => {
    onOpenFile(path)
    onClose()
  }, [onClose, onOpenFile, path])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-elevated px-2">
        <FileDiff className="size-3.5 shrink-0 text-dim" />
        <span className="min-w-0 truncate text-[12px] font-medium text-fg" title={path}>
          {path}
        </span>
        <span className="shrink-0 text-[11px] text-dim">
          {hunks.length > 0 ? `${hunks.length} 处改动` : '没有待处理的改动'}
        </span>
        {hunks.length > 0 ? (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-link">+{added}</span>{' '}
            <span className="text-danger">-{removed}</span>
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-[12px] text-dim"
            title="重新读取文件与基线"
            disabled={busy}
            onClick={handleReload}
          >
            <RefreshCw className="size-3" />
            刷新
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-[12px] text-dim"
            title="采纳全部改动（写回当前文件内容）"
            disabled={busy || dirty || hunks.length === 0}
            onClick={() => {
              void acceptAll()
            }}
          >
            <CheckCheck className="size-3" />
            采纳全部
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-[12px] text-danger"
            title="拒绝全部改动（写回本轮改动前的内容）"
            disabled={busy || dirty || hunks.length === 0}
            onClick={() => setConfirmRejectAll(true)}
          >
            <Undo2 className="size-3" />
            拒绝全部
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-dim hover:text-fg"
            title="关闭改动视图"
            aria-label="关闭改动视图"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </header>

      {dirty ? (
        <p className="m-0 shrink-0 border-b border-line bg-elevated px-3 py-1 text-[11px] leading-[1.6] text-dim">
          文件有未保存的修改：当前 diff
          基于磁盘内容，采纳/拒绝会写回文件，暂时禁用；保存后点击「刷新」即可。
        </p>
      ) : null}
      {error !== null ? (
        <p className="m-0 shrink-0 border-b border-line bg-danger/10 px-3 py-1 text-[11px] leading-[1.6] break-all text-danger">
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p className="m-0 shrink-0 border-b border-line bg-elevated px-3 py-1 text-[11px] leading-[1.6] text-dim">
          {notice}
        </p>
      ) : null}

      <div className="relative min-h-0 min-w-0 flex-1">
        <div ref={containerRef} className="ai-diff-surface absolute inset-0" />
        {status === 'loading' ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="flex items-center gap-1.5 rounded border border-line bg-elevated px-3 py-1.5 text-[12px] text-dim shadow-sm">
              <Loader2 className="size-3 animate-spin" />
              正在读取改动…
            </span>
          </div>
        ) : null}
        {status === 'error' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="m-0 max-w-[460px] text-[12px] leading-[1.7] break-words text-dim">
              {error ?? '无法加载改动'}
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" size="xs" variant="outline" onClick={handleReload}>
                重试
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={handleOpenPlainFile}>
                以普通文件打开
              </Button>
            </div>
          </div>
        ) : null}
        {status === 'ready' && hunks.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="rounded border border-line bg-elevated px-3 py-1.5 text-[12px] text-dim shadow-sm">
              当前内容与本轮改动前的基线一致
            </span>
          </div>
        ) : null}
        {busy ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
            <span className="flex items-center gap-1.5 rounded border border-line bg-elevated px-3 py-1.5 text-[12px] text-dim shadow-sm">
              <Loader2 className="size-3 animate-spin" />
              正在保存改动状态…
            </span>
          </div>
        ) : null}
        {status === 'ready' && hunks.length > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center px-4">
            <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-line bg-elevated px-2 py-1 shadow-lg">
              <button
                type="button"
                className={`${REVIEW_BAR_BUTTON_CLASS} w-6 justify-center px-0`}
                title="上一处变更"
                aria-label="上一处变更"
                disabled={busy || activeIndex <= 0}
                onClick={() => navigateTo(activeIndex - 1)}
              >
                <MoveUp className="size-3.5" />
              </button>
              <span className="min-w-[48px] text-center font-mono text-[11px] text-fg">
                {activeIndex + 1} / {hunks.length}
              </span>
              <button
                type="button"
                className={`${REVIEW_BAR_BUTTON_CLASS} w-6 justify-center px-0`}
                title="下一处变更"
                aria-label="下一处变更"
                disabled={busy || activeIndex >= hunks.length - 1}
                onClick={() => navigateTo(activeIndex + 1)}
              >
                <MoveDown className="size-3.5" />
              </button>
              <span className="mx-1 h-4 w-px bg-line" aria-hidden />
              <button
                type="button"
                className={`${REVIEW_BAR_BUTTON_CLASS} text-danger`}
                title="拒绝这处改动（Ctrl+Backspace）"
                disabled={busy || dirty}
                onClick={rejectActive}
              >
                拒绝
                <span className="text-dim">(Ctrl+Backspace)</span>
              </button>
              <button
                type="button"
                className={`${REVIEW_BAR_BUTTON_CLASS} text-link`}
                title="采纳这处改动（Ctrl+Enter）"
                disabled={busy || dirty}
                onClick={acceptActive}
              >
                采纳
                <span className="text-dim">(Ctrl+Enter)</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {confirmRejectAll ? (
        <MessageDialog
          title="拒绝全部改动"
          message="将把文件写回本轮改动前的内容，AI 这一轮对该文件的修改会全部撤销。"
          detail={path}
          actions={[
            { label: '取消', onClick: () => setConfirmRejectAll(false) },
            {
              label: '全部拒绝',
              primary: true,
              onClick: () => {
                void rejectAll()
              }
            }
          ]}
          onClose={() => setConfirmRejectAll(false)}
        />
      ) : null}
    </div>
  )
}
