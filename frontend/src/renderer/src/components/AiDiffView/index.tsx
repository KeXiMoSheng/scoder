import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCheck, FileDiff, Loader2, RefreshCw, Undo2, X } from 'lucide-react'
import { extractErrorMessage } from '../../lib/errorMessage'
import { basename } from '../../lib/filePath'
import { detectLanguage } from '../../lib/language'
import { monaco } from '../../lib/monaco'
import { getActiveThemeId } from '../../lib/theme'
import MessageDialog from '../MessageDialog'
import { Button } from '../ui/button'
import type { AiDiffViewProps } from './types'

/** 文件原始换行风格：diff 内部统一 LF，写回时还原 */
type Eol = '\n' | '\r\n'

/** 一处连续变更（Monaco 的 ILineChange）加展示用的增删行数 */
interface HunkInfo {
  /** 第几处改动（1 起） */
  index: number
  change: monaco.editor.ILineChange
  added: number
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

/** 把 Monaco 的行级变更转成展示模型 */
function toHunks(changes: readonly monaco.editor.ILineChange[]): HunkInfo[] {
  return changes.map((change, index) => ({
    index: index + 1,
    change,
    added:
      change.modifiedEndLineNumber > 0
        ? change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1
        : 0,
    removed:
      change.originalEndLineNumber > 0
        ? change.originalEndLineNumber - change.originalStartLineNumber + 1
        : 0
  }))
}

/**
 * 把一处变更还原成改动前的内容。
 * Monaco 的约定：EndLineNumber 为 0 表示纯插入（原文件没有这几行）或纯删除
 * （新文件没有这几行），此时 StartLineNumber 是插入/删除发生的位置（前一行）。
 */
function revertHunkText(
  current: string,
  change: monaco.editor.ILineChange,
  originalLines: readonly string[]
): string {
  // 整个文件被删空：这一处改动的还原结果就是完整原文
  if (current === '') {
    return originalLines.join('\n')
  }
  const lines = current.split('\n')
  const originalStart =
    change.originalEndLineNumber > 0
      ? change.originalStartLineNumber - 1
      : change.originalStartLineNumber
  const originalCount =
    change.originalEndLineNumber > 0
      ? change.originalEndLineNumber - change.originalStartLineNumber + 1
      : 0
  const modifiedStart =
    change.modifiedEndLineNumber > 0
      ? change.modifiedStartLineNumber - 1
      : change.modifiedStartLineNumber
  const modifiedCount =
    change.modifiedEndLineNumber > 0
      ? change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1
      : 0
  lines.splice(
    modifiedStart,
    modifiedCount,
    ...originalLines.slice(originalStart, originalStart + originalCount)
  )
  return lines.join('\n')
}

/**
 * 接受一处改动：把新文件里的这段内容并进 diff 基线，
 * 这一块随即从待审阅的 diff 里消失（磁盘上的文件内容不变）。
 */
function applyHunkToOriginal(
  original: string,
  change: monaco.editor.ILineChange,
  modifiedLines: readonly string[]
): string {
  // 原本是空文件（新建后整份写入）：接受这一处改动即接受整份新内容
  if (original === '') {
    return modifiedLines.join('\n')
  }
  const lines = original.split('\n')
  const originalStart =
    change.originalEndLineNumber > 0
      ? change.originalStartLineNumber - 1
      : change.originalStartLineNumber
  const originalCount =
    change.originalEndLineNumber > 0
      ? change.originalEndLineNumber - change.originalStartLineNumber + 1
      : 0
  const modifiedStart =
    change.modifiedEndLineNumber > 0
      ? change.modifiedStartLineNumber - 1
      : change.modifiedStartLineNumber
  const modifiedCount =
    change.modifiedEndLineNumber > 0
      ? change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1
      : 0
  lines.splice(
    originalStart,
    originalCount,
    ...modifiedLines.slice(modifiedStart, modifiedStart + modifiedCount)
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

/**
 * 某处变更在 modified 编辑器里的挂载行：在首行之上放操作条，
 * 纯删除（新文件没有这几行）则挂到删除发生的位置之后。
 */
function zoneLine(change: monaco.editor.ILineChange): number {
  return change.modifiedEndLineNumber > 0
    ? Math.max(0, change.modifiedStartLineNumber - 1)
    : change.modifiedStartLineNumber
}

/** 操作条按钮的统一样式（与工具行的小按钮一致） */
const ZONE_BUTTON_CLASS =
  'cursor-pointer whitespace-nowrap rounded-[3px] border border-line bg-transparent px-1.5 py-0.5 text-[11px] leading-4 text-fg transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-50'

/**
 * AI 改动行内 diff 视图。
 *
 * 视觉对齐 Qoder：单栏 inline unified（renderSideBySide=false），
 * 保留上下文，新增/删除行由 Monaco 上色；每一处连续变更上方有一条
 * 独立操作条，可以单独「接受」（保留）或「拒绝」（写回改动前内容）。
 * 同一文件一轮里被改多次时，diff 的基线是第一次改动前的内容，
 * 因此这里看到的是本轮全部改动块，而不是最后一次编辑的片段。
 */
export default function AiDiffView({
  sessionId,
  turn,
  path,
  absolutePath,
  cwd,
  dirty,
  onClose,
  onOpenFile
}: AiDiffViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null)
  const eolRef = useRef<Eol>('\n')
  const zoneIdsRef = useRef<string[]>([])
  const busyRef = useRef(false)
  const dirtyRef = useRef(dirty)
  const revealedRef = useRef(false)
  /** 操作条内的按钮在 Monaco 创建的 DOM 里，通过 ref 取到最新的处理函数 */
  const actionsRef = useRef<{
    accept: (hunk: HunkInfo) => void
    reject: (hunk: HunkInfo) => void
  }>({
    accept: () => undefined,
    reject: () => undefined
  })

  const [source, setSource] = useState<DiffSource | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [hunks, setHunks] = useState<HunkInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmRejectAll, setConfirmRejectAll] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  // 读取基线 + 当前文件内容。重新加载（刷新按钮）也走这里。
  useEffect(() => {
    // diff 视图只有在打开项目后才可能打开；这里只做类型收窄
    if (cwd === null) {
      return
    }
    let cancelled = false
    revealedRef.current = false
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
        setError(null)
        setNotice(null)
        setHunks([])
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
      hideUnchangedRegions: { enabled: false },
      smoothScrolling: true,
      fixedOverflowWidgets: true
    })
    diff.setModel({ original, modified })
    diffRef.current = diff

    /** 读取当前 diff 的行级变更，更新操作条 */
    const refreshHunks = (): void => {
      const next = toHunks(diff.getLineChanges() ?? [])
      setHunks(next)
      if (!revealedRef.current && next.length > 0) {
        revealedRef.current = true
        requestAnimationFrame(() => {
          diff
            .getModifiedEditor()
            .revealLineInCenter(Math.max(1, next[0].change.modifiedStartLineNumber))
        })
      }
    }
    const listener = diff.onDidUpdateDiff(refreshHunks)
    const frame = requestAnimationFrame(refreshHunks)

    return () => {
      cancelAnimationFrame(frame)
      listener.dispose()
      diff.dispose()
      diffRef.current = null
      originalModelRef.current = null
      modifiedModelRef.current = null
      original.dispose()
      modified.dispose()
      zoneIdsRef.current = []
    }
  }, [path, source])

  /**
   * 接受一处改动：把这段新内容并进 diff 基线并落盘。
   * 文件本身已经包含这处改动（接受不写目标文件），只让这一块从待审阅的 diff 里消失；
   * 基线同步保存后重新打开 diff 也不会再出现。
   */
  const acceptHunk = useCallback(
    async (hunk: HunkInfo): Promise<void> => {
      if (busyRef.current || cwd === null) {
        return
      }
      const originalModel = originalModelRef.current
      const modifiedModel = modifiedModelRef.current
      if (originalModel === null || modifiedModel === null) {
        return
      }
      const next = applyHunkToOriginal(
        originalModel.getValue(),
        hunk.change,
        modifiedModel.getValue().split('\n')
      )
      busyRef.current = true
      setBusy(true)
      setError(null)
      try {
        await window.api.ai.saveChangeBaseline(cwd, sessionId, turn, path, next)
        originalModel.setValue(next)
        setNotice(`已接受第 ${hunk.index} 处改动`)
      } catch (reason) {
        setError(`接受改动失败：${extractErrorMessage(reason)}`)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [cwd, path, sessionId, turn]
  )

  /** 拒绝一处改动：把这一段写回改动前的内容 */
  const rejectHunk = useCallback(
    async (hunk: HunkInfo): Promise<void> => {
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
          hunk.change,
          originalModel.getValue().split('\n')
        )
        // 先落盘再更新视图：写失败时屏幕上仍然与磁盘一致
        await writeTextFile(absolutePath, restoreEol(next, eolRef.current))
        modifiedModel.setValue(next)
        setNotice(`已拒绝第 ${hunk.index} 处改动，文件已写回`)
      } catch (reason) {
        setError(`拒绝改动失败：${extractErrorMessage(reason)}`)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [absolutePath]
  )

  /** 接受全部：把当前文件内容整份并进基线并落盘，diff 随即清空 */
  const acceptAll = useCallback(async (): Promise<void> => {
    if (busyRef.current || cwd === null) {
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
      await window.api.ai.saveChangeBaseline(cwd, sessionId, turn, path, next)
      originalModel.setValue(next)
      setNotice('已接受全部改动')
    } catch (reason) {
      setError(`接受全部改动失败：${extractErrorMessage(reason)}`)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [cwd, path, sessionId, turn])

  useEffect(() => {
    actionsRef.current = {
      accept: (hunk) => {
        void acceptHunk(hunk)
      },
      reject: (hunk) => {
        void rejectHunk(hunk)
      }
    }
  }, [acceptHunk, rejectHunk])

  // 为每一处未接受的改动挂一条操作条（view zone 叠加在行间）
  useEffect(() => {
    const diff = diffRef.current
    if (diff === null) {
      return
    }
    const editor = diff.getModifiedEditor()
    editor.changeViewZones((accessor) => {
      for (const id of zoneIdsRef.current) {
        accessor.removeZone(id)
      }
      zoneIdsRef.current = []
      for (const hunk of hunks) {
        const node = createHunkZone(hunk, busy, dirty, actionsRef.current)
        zoneIdsRef.current.push(
          accessor.addZone({
            afterLineNumber: zoneLine(hunk.change),
            heightInPx: 28,
            domNode: node
          })
        )
      }
    })
  }, [busy, dirty, hunks])

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
      await writeTextFile(absolutePath, restoreEol(baseline, eolRef.current))
      modifiedModel.setValue(baseline)
      setNotice('已拒绝全部改动，文件已恢复为改动前的内容')
    } catch (reason) {
      setError(`拒绝全部改动失败：${extractErrorMessage(reason)}`)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [absolutePath])

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
            title="接受全部改动（保留当前文件内容）"
            disabled={busy || hunks.length === 0}
            onClick={() => {
              void acceptAll()
            }}
          >
            <CheckCheck className="size-3" />
            全部接受
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
            全部拒绝
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
          文件有未保存的修改：当前 diff 基于磁盘内容，拒绝操作已禁用；保存后点击「刷新」即可。
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
        <div ref={containerRef} className="absolute inset-0" />
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

/**
 * 构造一条 hunk 操作条。
 * Monaco 的 view zone 只接受 DOM 节点，这里直接建节点；
 * 样式类写在源码里，Tailwind 扫描时同样会生成。
 */
function createHunkZone(
  hunk: HunkInfo,
  busy: boolean,
  dirty: boolean,
  actions: {
    accept: (hunk: HunkInfo) => void
    reject: (hunk: HunkInfo) => void
  }
): HTMLElement {
  const node = document.createElement('div')
  node.className =
    'flex h-full items-center gap-2 border-y border-line bg-elevated px-2 text-[11px] text-dim'
  node.style.height = '100%'
  node.addEventListener('mousedown', (event) => event.stopPropagation())

  const label = document.createElement('span')
  label.className = 'shrink-0 text-[11px] text-fg'
  label.textContent = `第 ${hunk.index} 处改动`

  const stat = document.createElement('span')
  stat.className = 'shrink-0 font-mono text-[11px]'
  const added = document.createElement('span')
  added.className = 'text-link'
  added.textContent = `+${hunk.added}`
  const removed = document.createElement('span')
  removed.className = 'ml-1 text-danger'
  removed.textContent = `-${hunk.removed}`
  stat.append(added, removed)

  const spacer = document.createElement('span')
  spacer.className = 'min-w-0 flex-1'

  const accept = document.createElement('button')
  accept.type = 'button'
  accept.className = ZONE_BUTTON_CLASS
  accept.textContent = '接受'
  accept.title = '保留这处改动'
  accept.disabled = busy
  accept.addEventListener('mousedown', (event) => event.stopPropagation())
  accept.addEventListener('click', (event) => {
    event.stopPropagation()
    actions.accept(hunk)
  })

  const reject = document.createElement('button')
  reject.type = 'button'
  reject.className = ZONE_BUTTON_CLASS
  reject.textContent = '拒绝'
  reject.disabled = busy || dirty
  reject.title = dirty ? '文件有未保存修改，请先保存' : '把这处改动写回原样'
  reject.addEventListener('mousedown', (event) => event.stopPropagation())
  reject.addEventListener('click', (event) => {
    event.stopPropagation()
    actions.reject(hunk)
  })

  node.append(label, stat, spacer, accept, reject)
  return node
}
