import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { monaco } from '../../lib/monaco'
import { detectLanguage, isMarkdownFile, isSvgFile } from '../../lib/language'
import { extractErrorMessage } from '../../lib/errorMessage'
import { appendModelText, LineEndingNormalizer } from '../../lib/fileStream'
import { dirname, isAtOrUnder } from '../../lib/filePath'
import { getActiveThemeId } from '../../lib/theme'
import { cn } from '../../lib/utils'
import { useModelText } from '../../hooks/useModelText'
import { MAX_EDITOR_TEXT_BYTES, megabytesToBytes } from '@shared/files/settings'
import type { EncodingCandidate, TextEncodingId } from '@shared/files/encoding'
import MarkdownPreview from '../MarkdownPreview'
import MessageDialog from '../MessageDialog'
import ResizeHandle from '../ResizeHandle'
import SvgPreview from '../SvgPreview'
import { Button } from '../ui/button'
import type {
  CodeEditorProps,
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

/** 流式保存的单块字符数：snapshot 约 64 KB 一块，攒到 4M 字符再发一次 IPC */
const SAVE_CHUNK_CHARS = 4 * 1024 * 1024

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
  onOpenEditorSettings,
  recheckToken,
  onEncodingChange,
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
   * 把文件内容流式灌入 model：先打开文本流（编码可由调用方指定），再逐块 applyEdits。
   * 调用方负责创建/清空 model，以及取消后的清理；取消时返回 null。
   */
  const fillModelFromStream = useCallback(
    async (
      model: monaco.editor.ITextModel,
      path: string,
      encoding: TextEncodingId | undefined,
      onProgress: (loaded: number, total: number) => void,
      isCancelled: () => boolean
    ): Promise<{ encoding: TextEncodingId; candidates: EncodingCandidate[] } | null> => {
      const opened = await window.api.openTextStream(path, encoding)
      if (isCancelled()) {
        void window.api.closeTextStream(opened.streamId)
        return null
      }
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
      const showProgress = total > SAVE_CHUNK_CHARS
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
      savingPathsRef.current.add(path)
      try {
        const version = model.getAlternativeVersionId()
        // 所有保存统一走 snapshot + 写流，不再依赖 V8 单字符串上限
        await saveModelBySnapshot(model)
        savedVersions.set(model, version)
        reportDirty(path, model.getAlternativeVersionId() !== version)
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
    // 先清空编辑器：大文件加载期间不能继续显示上一个文件的内容
    editor.setModel(null)
    // 加载期间先关闭全文索引类特性：否则 model 增长过程中会持续建单词索引
    editor.updateOptions(LARGE_FILE_OPTIONS)
    // recheckToken 只作为「从设置页返回后重新检查」的触发器，值本身不参与判断
    void recheckToken

    void (async (): Promise<void> => {
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
          setLoading((prev) => (prev?.path === file.path ? null : prev))
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    file,
    observeModel,
    syncDirty,
    forceOpenPath,
    recheckToken,
    fillModelFromStream,
    onEncodingChange
  ])

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
          model.dispose()
        }
      },
      reloadFromDisk(path: string): void {
        const model = monaco.editor.getModel(monaco.Uri.file(path))
        // 文件没在编辑器里打开过（或已有未保存修改）：切到该标签时会重新读盘，不覆盖用户输入
        if (!model || isDirty(model)) {
          return
        }
        // 超大文本不支持整串重载（readFile 是一次性字符串），跳过外部刷新
        if (model.getValueLength() > MAX_EDITOR_TEXT_BYTES) {
          return
        }
        void (async (): Promise<void> => {
          try {
            // 外部改动后按当前记录的编码重新解码，避免错误识别把内容变成乱码
            const content = await window.api.readFile(path, modelEncodings.get(model))
            // 读盘期间用户可能开始输入：再判一次，避免冲掉刚写的内容
            if (isDirty(model) || model.getValue() === content) {
              return
            }
            model.setValue(content)
            savedVersions.set(model, model.getAlternativeVersionId())
            syncDirty(model)
          } catch {
            // 读不到（例如刚被删除）：保持现状，让用户下次操作时看到真实错误
          }
        })()
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
    [applyEncoding, isDirty, saveModel, syncDirty]
  )

  /** 超限提示里的「继续打开」：跳过上限检查，按当前路径重新加载 */
  const handleForceOpen = useCallback((): void => {
    if (file === null) {
      return
    }
    setOversize(null)
    setForceOpenPath(file.path)
  }, [file])

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
