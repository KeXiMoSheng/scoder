import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { monaco } from '../../lib/monaco'
import { detectLanguage, isMarkdownFile, isSvgFile } from '../../lib/language'
import { extractErrorMessage } from '../../lib/errorMessage'
import { appendModelText, LineEndingNormalizer } from '../../lib/fileStream'
import { dirname, isAtOrUnder } from '../../lib/filePath'
import { getActiveThemeId } from '../../lib/theme'
import { cn } from '../../lib/utils'
import { useModelText } from '../../hooks/useModelText'
import { megabytesToBytes } from '@shared/files/settings'
import type { EncodingCandidate, TextEncodingId } from '@shared/files/encoding'
import MarkdownPreview from '../MarkdownPreview'
import MessageDialog from '../MessageDialog'
import ResizeHandle from '../ResizeHandle'
import SvgPreview from '../SvgPreview'
import { Button } from '../ui/button'
import type {
  CodeEditorProps,
  EditorRevealRequest,
  FileLoadProgress,
  FileSaveProgress,
  LoadFailure,
  OversizeFile,
  PreviewViewMode
} from './types'

/**
 * 每个 model 的保存点版本：model 是全局缓存，保存点也跟随 model 而非组件实例，
 * 组件重挂载（热更新）后复用缓存时不会因查不到保存点而误报脏点。
 */
const savedVersions = new WeakMap<monaco.editor.ITextModel, number>()

/**
 * 每个 model 的编码：自动识别或手动切换的结果，保存时按它写回。
 * 与保存点一样跟随 model（而非组件实例），切标签或组件重挂载后不丢。
 */
const modelEncodings = new WeakMap<monaco.editor.ITextModel, TextEncodingId>()

/** 每个 model 的候选编码：打开时由主进程自动识别，供状态栏菜单标注最可能的编码 */
const modelEncodingCandidates = new WeakMap<
  monaco.editor.ITextModel,
  readonly EncodingCandidate[]
>()

/** 分栏模式下的编辑区宽度占比上下限 */
const SPLIT_MIN_RATIO = 0.2
const SPLIT_MAX_RATIO = 0.8

/**
 * 磁盘文件基线（mtime + 大小）：保存与打开时记录，
 * 收到文件监听事件后与最新 stat 比对，用于区分自身保存与外部修改。
 */
interface DiskFileMeta {
  mtimeMs: number
  size: number
}

/** 外部变更提示：内容被修改（带最新磁盘基线），或文件被删除/重命名（旧路径消失） */
type ExternalNotice = ({ kind: 'modified' } & DiskFileMeta) | { kind: 'deleted' }

/** 流式保存的单块字符数：snapshot 约 64 KB 一块，攒到 128M 字符再发一次 IPC */
const SAVE_CHUNK_CHARS = 128 * 1024 * 1024

/** 超过该体积才展示保存进度：小文件写入是瞬时的，避免提示闪烁 */
const SAVE_PROGRESS_CHARS = 4 * 1024 * 1024

/**
 * 大文件阈值（字符数）：超过后关闭需要扫描/索引全文的编辑器特性。
 * 单词补全索引、出现高亮、选区高亮都会在 GB 级文本上产生海量对象，
 * 是 1GB 文件把渲染进程堆打满的直接原因。
 */
const LARGE_FILE_CHARS = 20 * 1024 * 1024

/**
 * 编辑器文件级选项：wordBasedSuggestions 在类型上属于全局选项，但运行时
 * updateOptions 同样会更新它；用交叉类型避免 IEditorOptions 的声明限制。
 */
type EditorFileOptions = monaco.editor.IEditorOptions & {
  wordBasedSuggestions?: 'off' | 'currentDocument' | 'matchingDocuments' | 'allDocuments'
}

/** 大文件编辑器选项：关闭全文索引类特性，保留搜索与滚动 */
const LARGE_FILE_OPTIONS: EditorFileOptions = {
  occurrencesHighlight: 'off',
  selectionHighlight: false,
  wordBasedSuggestions: 'off',
  codeLens: false,
  folding: false,
  bracketPairColorization: { enabled: false },
  guides: { indentation: false },
  stickyScroll: { enabled: false },
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  parameterHints: { enabled: false },
  lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off }
}

/** 普通文件的编辑器选项：恢复 Monaco 默认行为 */
const NORMAL_FILE_OPTIONS: EditorFileOptions = {
  occurrencesHighlight: 'singleFile',
  selectionHighlight: true,
  wordBasedSuggestions: 'currentDocument',
  codeLens: true,
  folding: true,
  bracketPairColorization: { enabled: true },
  guides: { indentation: true },
  stickyScroll: { enabled: true },
  quickSuggestions: { other: true, comments: false, strings: false },
  suggestOnTriggerCharacters: true,
  parameterHints: { enabled: true },
  lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode }
}

/** 工具栏上的三档视图选项 */
const VIEW_MODES: readonly { id: PreviewViewMode; label: string }[] = [
  { id: 'edit', label: '编辑' },
  { id: 'split', label: '分栏' },
  { id: 'preview', label: '预览' }
]

/** 加载进度文案：分块阶段按 MB 展示；缓存大文件恢复视图时只显示打开提示 */
function formatLoadingProgress(progress: FileLoadProgress): string {
  if (progress.total <= 0) {
    return '正在打开…'
  }
  const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)
  const percent = Math.min(100, Math.floor((progress.loaded / progress.total) * 100))
  return `正在加载 ${mb(progress.loaded)} / ${mb(progress.total)} MB（${percent}%）`
}

/** 文件大小展示：MB 保留一位小数 */
function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 保存进度文案：字符数换算成 MB 展示 */
function formatSaveProgress(progress: FileSaveProgress): string {
  const mb = (chars: number): string => (chars / 1024 / 1024).toFixed(1)
  if (progress.total <= 0) {
    return '正在保存…'
  }
  const percent = Math.min(100, Math.floor((progress.written / progress.total) * 100))
  return `正在保存 ${mb(progress.written)} / ${mb(progress.total)} MB（${percent}%）`
}

/** 按 model 大小切换编辑器特性：大文件关闭全文索引类功能 */
function applyEditorFileMode(
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel | null
): void {
  const large = model !== null && model.getValueLength() > LARGE_FILE_CHARS
  editor.updateOptions(large ? LARGE_FILE_OPTIONS : NORMAL_FILE_OPTIONS)
}

/** 等浏览器完成一次绘制：先让「正在打开」提示可见，再执行同步 attach */
function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    requestAnimationFrame(() => requestAnimationFrame(finish))
    // rAF 在窗口不可见时会被暂停：加超时兜底，避免永远停在提示上
    window.setTimeout(finish, 100)
  })
}

export default function CodeEditor({
  file,
  onDirtyChange,
  onSendSelectionToAi,
  onDeletedFromDisk,
  onOpenEditorSettings,
  recheckToken,
  onEncodingChange,
  workspaceRoot,
  onOpenFile,
  revealRequest,
  ref
}: CodeEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [failure, setFailure] = useState<LoadFailure | null>(null)
  // 流式加载进度：块读取 + 增量灌入 model；按路径归属，切换文件后旧进度不展示
  const [loading, setLoading] = useState<FileLoadProgress | null>(null)
  // 流式保存进度（分块写入较大文件时展示）
  const [saving, setSaving] = useState<FileSaveProgress | null>(null)
  // 正在保存的路径：同一文件不允许并发写流，避免两次保存互相覆盖
  const savingPathsRef = useRef<Set<string>>(new Set())
  // 超过配置上限的普通文本文件：只提示不读取，等用户决定继续打开或调整配置
  const [oversize, setOversize] = useState<OversizeFile | null>(null)
  // 用户选择「继续打开」的路径：跳过上限检查，按一次性读取打开
  const [forceOpenPath, setForceOpenPath] = useState<string | null>(null)
  // 各文件已上报的脏状态（仅在翻转时通知外部，避免每次击键都触发重渲染）
  const reportedDirtyRef = useRef<Map<string, boolean>>(new Map())
  // 已挂载内容变更监听的 model（避免重复挂载）
  const observedModelsRef = useRef<WeakSet<monaco.editor.ITextModel>>(new WeakSet())
  // 供编辑器内快捷键与右键菜单调用，避免创建 effect 依赖
  const saveCurrentRef = useRef<() => void>(() => {})
  // 右键菜单「发送选中行给 AI」的出口：编辑器只创建一次，回调通过 ref 保持最新
  const sendSelectionRef = useRef(onSendSelectionToAi)
  // 文档视图模式（Markdown / SVG，其余文件不渲染工具栏）：始终从「编辑」满宽起步，
  // 不跨会话恢复分栏，避免一打开文件编辑器就被切成半屏
  const [viewMode, setViewMode] = useState<PreviewViewMode>('edit')
  // 分栏模式下编辑区宽度占比（拖动中间分隔条调整）
  const [splitRatio, setSplitRatio] = useState(0.5)
  const splitStartRatioRef = useRef(0.5)
  const splitAreaRef = useRef<HTMLDivElement | null>(null)
  // 等待用户确认的编码切换：有未保存修改时先弹框，确认后再重新读盘
  const [pendingEncoding, setPendingEncoding] = useState<TextEncodingId | null>(null)
  // 各文件在磁盘上的基线（mtime + 大小）：用于区分自身保存与外部修改
  const diskMetaRef = useRef<Map<string, DiskFileMeta>>(new Map())
  // 有未保存修改时遇到外部修改：按路径挂起提示，仅当前激活文件展示
  const [externalNotices, setExternalNotices] = useState<ReadonlyMap<string, ExternalNotice>>(
    new Map()
  )
  // 正在打开（流式读盘）的路径：打开流程本身会读到最新内容，期间的文件事件不重复处理
  const openingPathsRef = useRef<Set<string>>(new Set())
  // 正在流式重载的路径：清空+灌入的中间态不上报脏状态，也禁止保存
  const suppressDirtyPathsRef = useRef<Set<string>>(new Set())
  // 外部变更检查的串行队列：同一文件的事件按顺序处理，避免并发读盘把较旧内容写回
  const checkQueuesRef = useRef<Map<string, Promise<void>>>(new Map())
  // 指向最新的检查函数，供队列与保存中重试调用（避免回调自引用）
  const checkExternalRef = useRef<(path: string) => Promise<void>>(async () => {})
  // Markdown 路径跳转的目标行：目标文件可能还在加载，请求暂存到 model attach 后再消费
  const pendingRevealRef = useRef<EditorRevealRequest | null>(null)

  /** 上报脏状态：仅在翻转时通知外部（避免每次击键都触发重渲染） */
  const reportDirty = useCallback(
    (path: string, isDirty: boolean): void => {
      if (reportedDirtyRef.current.get(path) === isDirty) {
        return
      }
      reportedDirtyRef.current.set(path, isDirty)
      onDirtyChange(path, isDirty)
    },
    [onDirtyChange]
  )

  /** 缓冲区相对保存点是否有未保存修改 */
  const isDirty = useCallback(
    (model: monaco.editor.ITextModel): boolean =>
      savedVersions.get(model) !== model.getAlternativeVersionId(),
    []
  )

  /** 计算 model 相对保存点的脏状态并上报 */
  const syncDirty = useCallback(
    (model: monaco.editor.ITextModel): void => {
      // 流式重载会先清空再增量灌入：抑制中间态上报，完成后再统一同步
      if (suppressDirtyPathsRef.current.has(model.uri.fsPath)) {
        return
      }
      reportDirty(model.uri.fsPath, isDirty(model))
    },
    [isDirty, reportDirty]
  )

  /** 挂载内容变更监听（每个 model 仅一次） */
  const observeModel = useCallback(
    (model: monaco.editor.ITextModel): void => {
      if (observedModelsRef.current.has(model)) {
        return
      }
      observedModelsRef.current.add(model)
      model.onDidChangeContent(() => syncDirty(model))
    },
    [syncDirty]
  )

  /**
   * 消费 Markdown 路径跳转请求：model 已挂载且路径匹配时定位并聚焦编辑器。
   * 行号收敛到模型范围（路径里的行号可能来自旧版本文件）；
   * endLine 存在时选中起始行行首到结束行行尾的整段范围。
   */
  const revealPendingLine = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel): void => {
      const request = pendingRevealRef.current
      if (!request || request.path !== model.uri.fsPath) {
        return
      }
      pendingRevealRef.current = null
      const lineNumber = Math.min(Math.max(1, request.line), model.getLineCount())
      const endLineNumber =
        request.endLine === undefined
          ? lineNumber
          : Math.min(Math.max(lineNumber, request.endLine), model.getLineCount())
      if (endLineNumber > lineNumber) {
        const endColumn = model.getLineMaxColumn(endLineNumber)
        const range = new monaco.Range(lineNumber, 1, endLineNumber, endColumn)
        editor.setSelection(new monaco.Selection(lineNumber, 1, endLineNumber, endColumn))
        editor.revealRangeInCenter(range)
      } else {
        editor.revealLineInCenter(lineNumber)
        editor.setPosition({ lineNumber, column: 1 })
      }
      editor.focus()
    },
    []
  )

  /**
   * 把文件内容流式灌入 model：先打开文本流（编码可由调用方指定），再逐块 applyEdits。
   * 调用方负责创建/清空 model，以及取消后的清理；取消时返回 null。
   */
  const fillModelFromStream = useCallback(
    async (
      model: monaco.editor.ITextModel,
      path: string,
      encoding: TextEncodingId | undefined,
      onProgress: (loaded: number, total: number) => void,
      isCancelled: () => boolean,
      onOpened?: () => void
    ): Promise<{ encoding: TextEncodingId; candidates: EncodingCandidate[] } | null> => {
      const opened = await window.api.openTextStream(path, encoding)
      if (isCancelled()) {
        void window.api.closeTextStream(opened.streamId)
        return null
      }
      // 读取流已就绪后再清空缓冲区（调用方在打开失败时得以保留原内容）
      onOpened?.()
      const normalizer = new LineEndingNormalizer()
      let firstChunk = true
      let loaded = 0
      try {
        for (;;) {
          const chunk = await window.api.readTextStreamChunk(opened.streamId)
          if (isCancelled()) {
            return null
          }
          if (chunk.text.length > 0) {
            const normalized = normalizer.normalize(chunk.text)
            if (firstChunk) {
              firstChunk = false
              // 原文是 CRLF 时把 model 目标行尾设成一致，保存写回不会整文件变动
              if (normalizer.crlf) {
                model.setEOL(monaco.editor.EndOfLineSequence.CRLF)
              }
            }
            appendModelText(model, normalized)
          }
          loaded += chunk.bytesRead
          onProgress(loaded, opened.size)
          if (chunk.done) {
            break
          }
        }
        appendModelText(model, normalizer.flush())
        return { encoding: opened.encoding, candidates: opened.candidates }
      } finally {
        void window.api.closeTextStream(opened.streamId)
      }
    },
    []
  )

  /** 把编辑器缓存的全部 model 路径同步给主进程：外部改动后由主进程推送 */
  const syncWatchedFiles = useCallback((): void => {
    const paths = monaco.editor.getModels().map((model) => model.uri.fsPath)
    void window.api.setWatchedFiles(paths).catch(() => undefined)
  }, [])

  /** 清除某个文件的外部变更提示 */
  const clearExternalNotice = useCallback((path: string): void => {
    setExternalNotices((prev) => {
      if (!prev.has(path)) {
        return prev
      }
      const next = new Map(prev)
      next.delete(path)
      return next
    })
  }, [])

  /**
   * 用磁盘内容替换 model 缓冲区（自动重载与用户确认后重载共用）。
   * 统一走流式灌入：与打开文件一致地展示加载进度，大文本也不会整串读入。
   * force 为 false 时不会覆盖未保存修改。
   */
  const reloadModelFromStream = useCallback(
    async (
      model: monaco.editor.ITextModel,
      meta: DiskFileMeta,
      force: boolean
    ): Promise<boolean> => {
      const path = model.uri.fsPath
      if (!force && isDirty(model)) {
        return false
      }
      const editor = editorRef.current
      // 只有重载的正是当前挂载的缓冲区才影响编辑器：切只读并展示加载提示；
      // 其他缓存文件的静默重载不能干扰用户正在编辑的文件。
      const attached = editor !== null && editor.getModel() === model
      if (attached) {
        editor.updateOptions({ readOnly: true })
        setLoading({ path, loaded: 0, total: 0 })
      }
      // 清空+灌入的中间态：不上报脏状态，也禁止保存写盘
      suppressDirtyPathsRef.current.add(path)
      try {
        // 先让「正在加载」提示绘制出来；读取流建立成功后才清空缓冲区，失败时保留原内容
        if (attached) {
          await waitForPaint()
        }
        const loaded = await fillModelFromStream(
          model,
          path,
          modelEncodings.get(model),
          (loadedBytes, total) => {
            if (attached) {
              setLoading({ path, loaded: loadedBytes, total })
            }
          },
          () => false,
          () => model.setValue('')
        )
        if (loaded === null) {
          return false
        }
        modelEncodings.set(model, loaded.encoding)
        modelEncodingCandidates.set(model, loaded.candidates)
        savedVersions.set(model, model.getAlternativeVersionId())
        suppressDirtyPathsRef.current.delete(path)
        syncDirty(model)
        diskMetaRef.current.set(path, meta)
        onEncodingChange?.({ path, encoding: loaded.encoding, candidates: loaded.candidates })
        setFailure((prev) => (prev?.path === path ? null : prev))
        clearExternalNotice(path)
        return true
      } catch (error) {
        // 读取失败时缓冲区可能已被清空：按当前内容重新上报脏状态，提醒用户检查
        suppressDirtyPathsRef.current.delete(path)
        syncDirty(model)
        setFailure({ path, message: `重新加载失败：${extractErrorMessage(error)}` })
        return false
      } finally {
        suppressDirtyPathsRef.current.delete(path)
        if (attached) {
          editor?.updateOptions({ readOnly: false })
          setLoading((prev) => (prev?.path === path ? null : prev))
        }
      }
    },
    [clearExternalNotice, fillModelFromStream, isDirty, onEncodingChange, syncDirty]
  )

  /** 检查一个已缓存文件是否被外部改动：干净时静默重载，有未保存修改时挂起重载提示 */
  const checkExternalChange = useCallback(
    async (path: string): Promise<void> => {
      // 打开流程正在进行：它本身会读到最新内容，结束后会主动复核一次
      if (openingPathsRef.current.has(path)) {
        return
      }
      const model = monaco.editor.getModel(monaco.Uri.file(path))
      if (!model) {
        return
      }
      const info = await window.api.statFile(path)
      if (info === null) {
        // 外部删除或重命名（旧路径消失）统一按「已删除」提示，由用户决定是否关闭标签
        diskMetaRef.current.delete(path)
        setExternalNotices((prev) => {
          if (prev.get(path)?.kind === 'deleted') {
            return prev
          }
          const next = new Map(prev)
          next.set(path, { kind: 'deleted' })
          return next
        })
        return
      }
      const known = diskMetaRef.current.get(path)
      if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) {
        return // 自身保存或已处理过的变更
      }
      const meta: DiskFileMeta = { mtimeMs: info.mtimeMs, size: info.size }
      if (!isDirty(model)) {
        await reloadModelFromStream(model, meta, false)
        return
      }
      setExternalNotices((prev) => {
        const current = prev.get(path)
        if (
          current?.kind === 'modified' &&
          current.mtimeMs === meta.mtimeMs &&
          current.size === meta.size
        ) {
          return prev
        }
        const next = new Map(prev)
        next.set(path, { kind: 'modified', ...meta })
        return next
      })
    },
    [isDirty, reloadModelFromStream]
  )

  useEffect(() => {
    checkExternalRef.current = checkExternalChange
  }, [checkExternalChange])

  /** 外部变更事件入口：同一文件串行排队；自身保存尚未结束时等基线更新后再判断 */
  const enqueueExternalCheck = useCallback((path: string): void => {
    const previous = checkQueuesRef.current.get(path) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        while (savingPathsRef.current.has(path)) {
          await new Promise((resolve) => window.setTimeout(resolve, 200))
        }
        await checkExternalRef.current(path)
      })
      .catch(() => undefined)
    checkQueuesRef.current.set(path, next)
    void next.finally(() => {
      if (checkQueuesRef.current.get(path) === next) {
        checkQueuesRef.current.delete(path)
      }
    })
  }, [])

  // 外部改动（其他编辑器、终端、AI 写工具等）：干净缓冲区自动重载，有未保存修改时提示，
  // 不覆盖用户输入
  useEffect(() => {
    return window.api.onFilesChanged(({ paths }) => {
      for (const path of paths) {
        enqueueExternalCheck(path)
      }
    })
  }, [enqueueExternalCheck])

  /** 流式保存：snapshot 分块读 + 主进程写流，所有文件共用这一条路径 */
  const saveModelBySnapshot = useCallback(
    async (model: monaco.editor.ITextModel): Promise<void> => {
      const path = model.uri.fsPath
      const total = model.getValueLength()
      // snapshot 约 64 KB 一块，固定住保存时刻的内容；保存期间的编辑不影响本次写入
      const snapshot = model.createSnapshot()
      // 按本次打开/切换时记录的编码写回，文件编码不会因保存而改变
      const { writeId } = await window.api.openWriteStream(
        path,
        modelEncodings.get(model) ?? 'utf-8'
      )
      let written = 0
      // 小文件写入是瞬时的：不显示进度，避免提示闪烁
      const showProgress = total > SAVE_PROGRESS_CHARS
      try {
        let buffer = ''
        for (;;) {
          const chunk = snapshot.read()
          if (chunk === null) {
            break
          }
          buffer += chunk
          if (buffer.length < SAVE_CHUNK_CHARS) {
            continue
          }
          await window.api.appendWriteChunk(writeId, buffer)
          written += buffer.length
          buffer = ''
          if (showProgress) {
            setSaving({ path, written, total })
          }
        }
        if (buffer.length > 0) {
          await window.api.appendWriteChunk(writeId, buffer)
          written += buffer.length
          if (showProgress) {
            setSaving({ path, written, total })
          }
        }
        await window.api.finishWriteStream(writeId)
      } catch (error) {
        await window.api.abortWriteStream(writeId).catch(() => undefined)
        throw error
      } finally {
        setSaving((prev) => (prev?.path === path ? null : prev))
      }
    },
    []
  )

  /** 保存单个缓冲区到磁盘；保存期间产生的新改动仍保持未保存状态 */
  const saveModel = useCallback(
    async (model: monaco.editor.ITextModel): Promise<void> => {
      const path = model.uri.fsPath
      // 加载中（尚无保存点）不能把半截内容写回磁盘
      if (!savedVersions.has(model)) {
        return
      }
      // 同一文件不允许并发写流：两次保存会互相覆盖
      if (savingPathsRef.current.has(path)) {
        return
      }
      // 流式重载的中间态（已清空/半灌入）不能写回磁盘
      if (suppressDirtyPathsRef.current.has(path)) {
        return
      }
      savingPathsRef.current.add(path)
      try {
        const version = model.getAlternativeVersionId()
        // 所有保存统一走 snapshot + 写流，不再依赖 V8 单字符串上限
        await saveModelBySnapshot(model)
        savedVersions.set(model, version)
        reportDirty(path, model.getAlternativeVersionId() !== version)
        // 保存会触发文件的 rename 事件：先把新 mtime 记为基线，避免被当成外部修改
        const info = await window.api.statFile(path).catch(() => null)
        if (info !== null) {
          diskMetaRef.current.set(path, { mtimeMs: info.mtimeMs, size: info.size })
        }
        // 本地保存已经覆盖磁盘：针对旧磁盘内容的提示不再有意义
        setExternalNotices((prev) => {
          if (!prev.has(path)) {
            return prev
          }
          const next = new Map(prev)
          next.delete(path)
          return next
        })
      } finally {
        savingPathsRef.current.delete(path)
      }
    },
    [reportDirty, saveModelBySnapshot]
  )

  /** 保存当前文件（Ctrl/Cmd+S 及编辑器右键菜单入口） */
  const saveCurrent = useCallback(async (): Promise<void> => {
    const model = editorRef.current?.getModel()
    if (!model) {
      return
    }
    try {
      await saveModel(model)
      setFailure((prev) => (prev?.path === model.uri.fsPath ? null : prev))
    } catch (reason) {
      setFailure({ path: model.uri.fsPath, message: `保存失败：${extractErrorMessage(reason)}` })
    }
  }, [saveModel])

  useEffect(() => {
    saveCurrentRef.current = () => void saveCurrent()
  }, [saveCurrent])

  useEffect(() => {
    sendSelectionRef.current = onSendSelectionToAi
  }, [onSendSelectionToAi])

  // 创建编辑器实例（仅一次）；容器尺寸变化由 automaticLayout 自动跟随
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const editor = monaco.editor.create(container, {
      // 编辑器跟随应用级主题（lib/theme.ts 统一注册与切换）
      theme: getActiveThemeId(),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      // 关掉概览标尺左边缘的边框线（默认色会在编辑器右缘画出一条分界线），保留标尺本身
      overviewRulerBorder: false,
      smoothScrolling: true
    })
    editor.addAction({
      id: 'scoder.saveFile',
      label: '保存',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: () => saveCurrentRef.current()
    })
    editor.addAction({
      id: 'scoder.sendSelectionToAi',
      label: '发送选中行给 AI',
      // 只有存在非空选区时才出现在右键菜单里
      precondition: 'editorHasSelection',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: (editor) => {
        const model = editor.getModel()
        const selection = editor.getSelection()
        if (!model || !selection || selection.isEmpty()) {
          return
        }
        const startLine = selection.startLineNumber
        // 选区在下一行行首结束时，那一行并没有被选中，剔除避免多发一行
        const endLine =
          selection.endColumn === 1 && selection.endLineNumber > startLine
            ? selection.endLineNumber - 1
            : selection.endLineNumber
        const range = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine))
        sendSelectionRef.current({
          path: model.uri.fsPath,
          kind: 'selection',
          startLine,
          endLine,
          text: model.getValueInRange(range)
        })
      }
    })
    editorRef.current = editor
    return () => {
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  // 全局 Ctrl/Cmd+S：编辑器聚焦时由 Monaco 的快捷键处理，其余位置（如文件树）同样可保存
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) {
        return
      }
      if (event.key.toLowerCase() !== 's') {
        return
      }
      if (editorRef.current?.hasTextFocus()) {
        return
      }
      event.preventDefault()
      void saveCurrent()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [saveCurrent])

  // 切换激活文件：以文件路径为 model 的 URI 复用已有 model
  // （保留内容缓存、未保存修改与滚动位置），未缓存时才读盘创建。
  // 普通文本超过配置上限时先提示，用户可选择继续打开或调整上限。
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) {
      return
    }
    // 上一次大文件流式重载可能设置了只读：切换/打开文件时先恢复可编辑
    editor.updateOptions({ readOnly: false })
    if (!file) {
      editor.setModel(null)
      editor.updateOptions(NORMAL_FILE_OPTIONS)
      onEncodingChange?.(null)
      return
    }

    const uri = monaco.Uri.file(file.path)
    const cachedModel = monaco.editor.getModel(uri)
    if (cachedModel) {
      /** 恢复缓存 model：先按大小设好编辑器特性再 attach，避免按上一个文件的选项初始化 */
      const attach = (): void => {
        applyEditorFileMode(editor, cachedModel)
        observeModel(cachedModel)
        editor.setModel(cachedModel)
        // 模型缓存可能早于本次组件挂载（热更新重挂载后保存点已丢失）：
        // 以当前内容为基线，避免仅打开文件就误报脏点
        if (!savedVersions.has(cachedModel)) {
          savedVersions.set(cachedModel, cachedModel.getAlternativeVersionId())
        }
        syncDirty(cachedModel)
        onEncodingChange?.({
          path: file.path,
          encoding: modelEncodings.get(cachedModel) ?? 'utf-8',
          candidates: modelEncodingCandidates.get(cachedModel) ?? []
        })
        // 组件重挂载后监听集合是新的：按当前缓存的 model 集合重新同步一次
        syncWatchedFiles()
        revealPendingLine(editor, cachedModel)
      }
      if (cachedModel.getValueLength() <= LARGE_FILE_CHARS) {
        attach()
        return
      }
      // 大 model 同步 attach 会阻塞一段时间：先清空编辑器并画出「正在打开」，下一帧再挂
      let cancelled = false
      void (async (): Promise<void> => {
        setLoading({ path: file.path, loaded: 0, total: 0 })
        editor.setModel(null)
        await waitForPaint()
        if (cancelled) {
          return
        }
        attach()
        setLoading((prev) => (prev?.path === file.path ? null : prev))
      })()
      return () => {
        cancelled = true
      }
    }

    let cancelled = false
    // 打开流程本身会读到最新内容：期间的文件事件跳过，结束后主动复核一次
    const openingPaths = openingPathsRef.current
    openingPaths.add(file.path)
    // 先清空编辑器：大文件加载期间不能继续显示上一个文件的内容
    editor.setModel(null)
    // 加载期间先关闭全文索引类特性：否则 model 增长过程中会持续建单词索引
    editor.updateOptions(LARGE_FILE_OPTIONS)
    // recheckToken 只作为「从设置页返回后重新检查」的触发器，值本身不参与判断
    void recheckToken

    void (async (): Promise<void> => {
      // 先显示「正在打开」：stat/权限检查与建立读取流也可能耗时，不能等第一块到达才提示
      setLoading({ path: file.path, loaded: 0, total: 0 })
      try {
        const info = await window.api.statFile(file.path)
        if (info === null) {
          throw new Error(`文件不存在或不是普通文件：${file.path}`)
        }
        // 二进制文件不参与大小限制提示：直接按不支持打开处理
        if (info.binary) {
          throw new Error('二进制文件不支持在编辑器中打开')
        }
        // 普通文本超过配置上限：先不读取，交给用户决定继续打开或调整上限
        const settings = await window.api.getFileSettings()
        const limit = settings.maxEditorFileMegabytes
        if (info.size > megabytesToBytes(limit) && forceOpenPath !== file.path) {
          if (!cancelled) {
            setFailure(null)
            setOversize({ path: file.path, size: info.size, limit })
          }
          return
        }
        // 按块读取并增量灌入空 model：不拼整串，突破 V8 单字符串长度上限
        // 打开时自动识别编码，状态栏展示识别结果，保存按同一编码写回
        const model = monaco.editor.createModel('', detectLanguage(file.name), uri)
        let loaded: { encoding: TextEncodingId; candidates: EncodingCandidate[] } | null
        try {
          loaded = await fillModelFromStream(
            model,
            file.path,
            undefined,
            (loadedBytes, total) => {
              if (!cancelled) {
                setLoading({ path: file.path, loaded: loadedBytes, total })
              }
            },
            () => cancelled
          )
        } catch (error) {
          // 打开流失败时不能留下同 URI 的空 model，否则下次会命中缓存
          model.dispose()
          throw error
        }
        if (loaded === null) {
          model.dispose()
          return
        }
        modelEncodings.set(model, loaded.encoding)
        modelEncodingCandidates.set(model, loaded.candidates)
        // 全部灌入后一次性挂到编辑器：先按大小设好特性再 attach
        applyEditorFileMode(editor, model)
        editor.setModel(model)
        savedVersions.set(model, model.getAlternativeVersionId())
        // 记录磁盘基线：文件监听事件据此区分自身保存与外部修改
        diskMetaRef.current.set(file.path, { mtimeMs: info.mtimeMs, size: info.size })
        syncWatchedFiles()
        observeModel(model)
        syncDirty(model)
        setFailure(null)
        onEncodingChange?.({
          path: file.path,
          encoding: loaded.encoding,
          candidates: loaded.candidates
        })
        // 上限调大或选择继续打开后，同一路径的提示不再保留
        setOversize((previous) => (previous?.path === file.path ? null : previous))
        revealPendingLine(editor, model)
      } catch (reason) {
        if (cancelled) {
          return
        }
        editor.setModel(null)
        editor.updateOptions(NORMAL_FILE_OPTIONS)
        setFailure({ path: file.path, message: extractErrorMessage(reason) })
        onEncodingChange?.(null)
      } finally {
        if (!cancelled) {
          openingPaths.delete(file.path)
          setLoading((prev) => (prev?.path === file.path ? null : prev))
          // 打开期间文件可能又被写入（事件被 opening 标记跳过）：完成后主动复核一次
          enqueueExternalCheck(file.path)
        }
      }
    })()

    return () => {
      cancelled = true
      // 快速切换文件时清掉标记，避免目标路径后续的事件被永久跳过
      openingPaths.delete(file.path)
    }
  }, [
    file,
    observeModel,
    syncDirty,
    syncWatchedFiles,
    forceOpenPath,
    recheckToken,
    fillModelFromStream,
    enqueueExternalCheck,
    onEncodingChange,
    revealPendingLine
  ])

  // Markdown 路径跳转：文件已挂载时立即定位到目标行；否则请求暂存，
  // 由打开流程在 model attach 后调用 revealPendingLine 消费
  useEffect(() => {
    if (!revealRequest) {
      return
    }
    pendingRevealRef.current = revealRequest
    const editor = editorRef.current
    const model = editor?.getModel()
    if (editor && model) {
      revealPendingLine(editor, model)
    }
  }, [revealRequest, revealPendingLine])

  // 文档预览（Markdown / SVG）：预览文本由 useModelText 直接订阅当前激活的 model
  const isMarkdown = file !== null && isMarkdownFile(file.name)
  const isSvg = file !== null && isSvgFile(file.name)
  // 只有带预览能力的文档才显示编辑器顶部的「编辑 / 分栏 / 预览」工具条
  const previewable = isMarkdown || isSvg
  const previewVisible = previewable && viewMode !== 'edit'
  const previewText = useModelText(file?.path ?? null, previewVisible)

  /** 切换视图模式（仅本次会话生效；打开文件默认回到「编辑」满宽） */
  const changeViewMode = useCallback((mode: PreviewViewMode): void => {
    setViewMode(mode)
  }, [])

  // 分栏/预览只是「当前这份文档」的临时视图，不应跟到下一个文件：
  // 切换激活文件时把视图模式重置回「编辑」满宽。
  // （不能用 key 重挂载 CodeEditor，那会重建 Monaco 实例、丢掉模型复用；
  //  这里用 ref 守卫，只在路径真正变化时重置一次，不会随渲染反复触发。）
  const lastViewFilePathRef = useRef<string | null>(null)
  useEffect(() => {
    const path = file?.path ?? null
    if (lastViewFilePathRef.current === path) {
      return
    }
    lastViewFilePathRef.current = path
    setViewMode('edit')
  }, [file?.path])

  const handleSplitResizeStart = useCallback((): void => {
    splitStartRatioRef.current = splitRatio
  }, [splitRatio])

  /** 拖动分隔条：把横向偏移换算成编辑区占比，并限制两侧最小宽度 */
  const handleSplitResize = useCallback((offsetX: number): void => {
    const width = splitAreaRef.current?.clientWidth ?? 0
    if (width === 0) {
      return
    }
    const ratio = splitStartRatioRef.current + offsetX / width
    setSplitRatio(Math.min(Math.max(ratio, SPLIT_MIN_RATIO), SPLIT_MAX_RATIO))
  }, [])

  /**
   * 以指定编码重新解码当前文件：清空 model 后重新流式读盘。
   * 编码切换等价于「重新解释磁盘字节」，未保存修改在调用前已确认丢弃；
   * 切换失败时用原编码把内容读回来，不留下空或半截缓冲区。
   */
  const applyEncoding = useCallback(
    async (encoding: TextEncodingId): Promise<void> => {
      const model = editorRef.current?.getModel()
      if (!model) {
        return
      }
      const path = model.uri.fsPath
      const previous = modelEncodings.get(model) ?? 'utf-8'
      setLoading({ path, loaded: 0, total: 0 })
      try {
        model.setValue('')
        const loaded = await fillModelFromStream(
          model,
          path,
          encoding,
          (loadedBytes, total) => setLoading({ path, loaded: loadedBytes, total }),
          () => false
        )
        if (loaded === null) {
          return
        }
        modelEncodings.set(model, loaded.encoding)
        modelEncodingCandidates.set(model, loaded.candidates)
        savedVersions.set(model, model.getAlternativeVersionId())
        syncDirty(model)
        setFailure((last) => (last?.path === path ? null : last))
        onEncodingChange?.({
          path,
          encoding: loaded.encoding,
          candidates: loaded.candidates
        })
      } catch (reason) {
        // 切换失败：用原编码恢复内容，避免用户看到空文件并误存
        try {
          model.setValue('')
          const restored = await fillModelFromStream(
            model,
            path,
            previous,
            () => undefined,
            () => false
          )
          if (restored !== null) {
            modelEncodings.set(model, restored.encoding)
            modelEncodingCandidates.set(model, restored.candidates)
            savedVersions.set(model, model.getAlternativeVersionId())
            syncDirty(model)
            onEncodingChange?.({
              path,
              encoding: restored.encoding,
              candidates: restored.candidates
            })
          }
        } catch {
          // 恢复也失败：保留错误提示，缓冲区仍为未保存状态，不会被当成已保存
        }
        setFailure({ path, message: `切换编码失败：${extractErrorMessage(reason)}` })
      } finally {
        setLoading((last) => (last?.path === path ? null : last))
      }
    },
    [fillModelFromStream, onEncodingChange, syncDirty]
  )

  useImperativeHandle(
    ref,
    () => ({
      async saveDirtyUnder(path: string): Promise<void> {
        const dirtyModels = monaco.editor
          .getModels()
          .filter(
            (model) =>
              isAtOrUnder(model.uri.fsPath, path) &&
              savedVersions.get(model) !== model.getAlternativeVersionId()
          )
        for (const model of dirtyModels) {
          await saveModel(model)
        }
      },
      dropCachedUnder(path: string): void {
        const editor = editorRef.current
        const dropped: string[] = []
        for (const model of monaco.editor.getModels()) {
          const modelPath = model.uri.fsPath
          if (!isAtOrUnder(modelPath, path)) {
            continue
          }
          if (editor?.getModel() === model) {
            editor.setModel(null)
          }
          savedVersions.delete(model)
          reportedDirtyRef.current.delete(modelPath)
          diskMetaRef.current.delete(modelPath)
          dropped.push(modelPath)
          model.dispose()
        }
        if (dropped.length > 0) {
          // 提示与监听集合都属于被丢弃的 model，一并清理
          setExternalNotices((prev) => {
            let changed = false
            const next = new Map(prev)
            for (const modelPath of dropped) {
              if (next.delete(modelPath)) {
                changed = true
              }
            }
            return changed ? next : prev
          })
          syncWatchedFiles()
        }
      },
      reopenWithEncoding(encoding: TextEncodingId): void {
        const model = editorRef.current?.getModel()
        if (!model) {
          return
        }
        // 有未保存修改时先确认：切换编码会按磁盘内容重新解码
        if (isDirty(model)) {
          setPendingEncoding(encoding)
          return
        }
        void applyEncoding(encoding)
      }
    }),
    [applyEncoding, isDirty, saveModel, syncWatchedFiles]
  )

  /** 超限提示里的「继续打开」：跳过上限检查，按当前路径重新加载 */
  const handleForceOpen = useCallback((): void => {
    if (file === null) {
      return
    }
    setOversize(null)
    setForceOpenPath(file.path)
  }, [file])

  // 当前文件的外部修改提示（其他文件的提示在切换过去后再展示）
  const externalNotice = file !== null ? (externalNotices.get(file.path) ?? null) : null

  /** 用户确认重新加载：放弃本地未保存修改，用磁盘内容替换缓冲区 */
  const handleReloadExternal = useCallback((): void => {
    if (!file || externalNotice?.kind !== 'modified') {
      return
    }
    const model = monaco.editor.getModel(monaco.Uri.file(file.path))
    if (model) {
      void reloadModelFromStream(model, externalNotice, true)
    }
  }, [externalNotice, file, reloadModelFromStream])

  /** 忽略外部修改：把当前磁盘状态记为基线，保留本地缓冲区（之后的保存会覆盖磁盘） */
  const handleIgnoreExternal = useCallback((): void => {
    if (!file || !externalNotice) {
      return
    }
    if (externalNotice.kind === 'modified') {
      diskMetaRef.current.set(file.path, externalNotice)
    }
    clearExternalNotice(file.path)
  }, [clearExternalNotice, externalNotice, file])

  /** 磁盘上的文件已被删除/重命名：交给外层关闭标签并清理缓存（未提供回调时仅收起提示） */
  const handleCloseDeletedFile = useCallback((): void => {
    if (!file) {
      return
    }
    if (onDeletedFromDisk) {
      onDeletedFromDisk(file.path)
      return
    }
    clearExternalNotice(file.path)
  }, [clearExternalNotice, file, onDeletedFromDisk])

  // 仅展示当前文件对应的错误（派生值，无需在 effect 中同步重置）
  const errorMessage = failure && failure.path === file?.path ? failure.message : null
  // 读取失败时保留编辑器可见，否则错误提示会随预览一起被隐藏
  const editorHidden = previewVisible && viewMode === 'preview' && !errorMessage

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {previewable ? (
        <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line bg-elevated px-1.5">
          {VIEW_MODES.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant="ghost"
              size="xs"
              className={cn(
                'h-6 text-[12px]',
                viewMode === item.id ? 'bg-selection text-fg' : 'text-dim'
              )}
              aria-pressed={viewMode === item.id}
              onClick={() => changeViewMode(item.id)}
            >
              {item.label}
            </Button>
          ))}
          <span className="ml-auto pr-1 text-[11px] text-dim">
            {isMarkdown ? 'Markdown' : 'SVG'}
          </span>
        </div>
      ) : null}
      {externalNotice ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-elevated px-3 py-1.5">
          <span className="text-[12px] text-fg">
            {externalNotice.kind === 'deleted'
              ? '文件已在磁盘上删除或重命名。'
              : '文件已在磁盘上更改。'}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {externalNotice.kind === 'modified' ? (
              <Button type="button" size="xs" onClick={handleReloadExternal}>
                重新加载
              </Button>
            ) : (
              <Button type="button" size="xs" onClick={handleCloseDeletedFile}>
                关闭标签
              </Button>
            )}
            <Button type="button" size="xs" variant="ghost" onClick={handleIgnoreExternal}>
              忽略
            </Button>
          </div>
        </div>
      ) : null}
      <div ref={splitAreaRef} className="flex min-h-0 flex-1">
        <div
          className={cn(
            'relative min-h-0 min-w-0 flex-1 overflow-hidden',
            editorHidden && 'invisible absolute inset-0'
          )}
          style={previewable && viewMode === 'split' ? { flex: `${splitRatio} 1 0%` } : undefined}
          aria-hidden={editorHidden}
        >
          <div ref={containerRef} className="absolute inset-0" />
          {errorMessage ? (
            <p className="pointer-events-none absolute inset-0 m-0 flex items-center justify-center p-6 text-center text-dim">
              {errorMessage}
            </p>
          ) : null}
          {oversize && oversize.path === file?.path && !errorMessage ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="m-0 leading-[1.6] text-dim">
                文件大小 {formatMegabytes(oversize.size)}，超过编辑器上限 {oversize.limit}{' '}
                MB，未读取。
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" onClick={handleForceOpen}>
                  继续打开
                </Button>
                {onOpenEditorSettings ? (
                  <Button type="button" size="sm" variant="outline" onClick={onOpenEditorSettings}>
                    调整大小上限
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {loading && loading.path === file?.path ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <span className="rounded border border-line bg-elevated px-3 py-1.5 text-[12px] text-dim shadow-sm">
                {formatLoadingProgress(loading)}
              </span>
            </div>
          ) : null}
          {saving && saving.path === file?.path ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <span className="rounded border border-line bg-elevated px-3 py-1.5 text-[12px] text-dim shadow-sm">
                {formatSaveProgress(saving)}
              </span>
            </div>
          ) : null}
          {!file && !errorMessage ? (
            <p className="pointer-events-none absolute inset-0 m-0 flex items-center justify-center p-6 text-center text-dim">
              从左侧选择一个文件进行编辑
            </p>
          ) : null}
        </div>
        {previewVisible && !errorMessage ? (
          <>
            {viewMode === 'split' ? (
              <ResizeHandle
                label="调整编辑区与预览区宽度"
                onResizeStart={handleSplitResizeStart}
                onResize={handleSplitResize}
              />
            ) : null}
            <div
              className="relative flex min-h-0 min-w-0 flex-1"
              style={
                previewable && viewMode === 'split' ? { flex: `${1 - splitRatio} 1 0%` } : undefined
              }
            >
              {isSvg ? (
                <SvgPreview content={previewText} className="min-h-0 flex-1" />
              ) : (
                <MarkdownPreview
                  content={previewText}
                  basePath={file ? dirname(file.path) : undefined}
                  workspaceRoot={workspaceRoot}
                  onOpenFile={onOpenFile}
                  className="min-h-0 flex-1"
                />
              )}
              {previewText.trim() === '' ? (
                <p className="pointer-events-none absolute inset-0 m-0 flex items-center justify-center p-6 text-center text-dim">
                  空文档
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      {pendingEncoding !== null ? (
        <MessageDialog
          title="切换文件编码"
          message="将按新编码重新读取磁盘内容，当前未保存的修改会丢失。"
          actions={[
            { label: '取消', onClick: () => setPendingEncoding(null) },
            {
              label: '切换',
              primary: true,
              onClick: () => {
                const next = pendingEncoding
                setPendingEncoding(null)
                void applyEncoding(next)
              }
            }
          ]}
          onClose={() => setPendingEncoding(null)}
        />
      ) : null}
    </div>
  )
}
