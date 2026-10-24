import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { monaco } from '../../lib/monaco'
import { detectLanguage, isMarkdownFile } from '../../lib/language'
import { extractErrorMessage } from '../../lib/errorMessage'
import { dirname, isAtOrUnder } from '../../lib/filePath'
import { getActiveThemeId } from '../../lib/theme'
import { cn } from '../../lib/utils'
import { useMarkdownModelText } from '../../hooks/useMarkdownModelText'
import MarkdownPreview from '../MarkdownPreview'
import ResizeHandle from '../ResizeHandle'
import { Button } from '../ui/button'
import type { CodeEditorProps, LoadFailure, MarkdownViewMode } from './types'

/** Markdown 视图模式偏好（跨会话保留） */
const VIEW_MODE_STORAGE_KEY = 'scoder.markdownViewMode'

/** 分栏模式下的编辑区宽度占比上下限 */
const SPLIT_MIN_RATIO = 0.2
const SPLIT_MAX_RATIO = 0.8

/** 工具栏上的三档视图选项 */
const VIEW_MODES: readonly { id: MarkdownViewMode; label: string }[] = [
  { id: 'edit', label: '编辑' },
  { id: 'split', label: '分栏' },
  { id: 'preview', label: '预览' }
]

function readStoredViewMode(): MarkdownViewMode {
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)
    if (stored === 'edit' || stored === 'split' || stored === 'preview') {
      return stored
    }
  } catch {
    // localStorage 不可用时按默认处理
  }
  return 'edit'
}

export default function CodeEditor({
  file,
  onDirtyChange,
  ref
}: CodeEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [failure, setFailure] = useState<LoadFailure | null>(null)
  // 每个缓冲区最近一次保存（或从磁盘载入）时的替代版本号：
  // 撤销回保存点后版本号复原，脏标记随之消失（与 VS Code 一致）
  const savedVersionRef = useRef<Map<string, number>>(new Map())
  // 各文件已上报的脏状态（仅在翻转时通知外部，避免每次击键都触发重渲染）
  const reportedDirtyRef = useRef<Map<string, boolean>>(new Map())
  // 已挂载内容变更监听的 model（避免重复挂载）
  const observedModelsRef = useRef<WeakSet<monaco.editor.ITextModel>>(new WeakSet())
  // 供编辑器内快捷键与右键菜单调用，避免创建 effect 依赖
  const saveCurrentRef = useRef<() => void>(() => {})
  // Markdown 视图模式（仅对 Markdown 文件生效，其他文件不渲染工具栏）
  const [viewMode, setViewMode] = useState<MarkdownViewMode>(readStoredViewMode)
  // 分栏模式下编辑区宽度占比（拖动中间分隔条调整）
  const [splitRatio, setSplitRatio] = useState(0.5)
  const splitStartRatioRef = useRef(0.5)
  const splitAreaRef = useRef<HTMLDivElement | null>(null)

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

  /** 计算 model 相对保存点的脏状态并上报 */
  const syncDirty = useCallback(
    (model: monaco.editor.ITextModel): void => {
      const path = model.uri.fsPath
      reportDirty(path, savedVersionRef.current.get(path) !== model.getAlternativeVersionId())
    },
    [reportDirty]
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

  /** 保存单个缓冲区到磁盘；保存期间产生的新改动仍保持未保存状态 */
  const saveModel = useCallback(
    async (model: monaco.editor.ITextModel): Promise<void> => {
      const path = model.uri.fsPath
      const version = model.getAlternativeVersionId()
      await window.api.writeFile(path, model.getValue())
      savedVersionRef.current.set(path, version)
      reportDirty(path, model.getAlternativeVersionId() !== version)
    },
    [reportDirty]
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
  // （保留内容缓存、未保存修改与滚动位置），未缓存时才读盘创建
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) {
      return
    }
    if (!file) {
      editor.setModel(null)
      return
    }

    const uri = monaco.Uri.file(file.path)
    const cachedModel = monaco.editor.getModel(uri)
    if (cachedModel) {
      // 错误提示按路径派生过滤（errorMessage），切换文件后旧错误自然隐藏
      observeModel(cachedModel)
      editor.setModel(cachedModel)
      syncDirty(cachedModel)
      return
    }

    let cancelled = false
    window.api
      .readFile(file.path)
      .then((content) => {
        if (cancelled) {
          return
        }
        const model = monaco.editor.createModel(content, detectLanguage(file.name), uri)
        savedVersionRef.current.set(file.path, model.getAlternativeVersionId())
        observeModel(model)
        editor.setModel(model)
        syncDirty(model)
        setFailure(null)
      })
      .catch((reason: unknown) => {
        if (cancelled) {
          return
        }
        editor.setModel(null)
        setFailure({ path: file.path, message: extractErrorMessage(reason) })
      })
    return () => {
      cancelled = true
    }
  }, [file, observeModel, syncDirty])

  // Markdown 视图状态：预览文本由 useMarkdownModelText 直接订阅当前激活的 model
  const isMarkdown = file !== null && isMarkdownFile(file.name)
  const previewVisible = isMarkdown && viewMode !== 'edit'
  const markdownText = useMarkdownModelText(file?.path ?? null, previewVisible)

  /** 切换视图模式并持久化选择 */
  const changeViewMode = useCallback((mode: MarkdownViewMode): void => {
    setViewMode(mode)
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode)
    } catch {
      // 持久化失败不影响本次切换
    }
  }, [])

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

  useImperativeHandle(
    ref,
    () => ({
      async saveDirtyUnder(path: string): Promise<void> {
        const dirtyModels = monaco.editor
          .getModels()
          .filter(
            (model) =>
              isAtOrUnder(model.uri.fsPath, path) &&
              savedVersionRef.current.get(model.uri.fsPath) !== model.getAlternativeVersionId()
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
          savedVersionRef.current.delete(modelPath)
          reportedDirtyRef.current.delete(modelPath)
          model.dispose()
        }
      }
    }),
    [saveModel]
  )

  // 仅展示当前文件对应的错误（派生值，无需在 effect 中同步重置）
  const errorMessage = failure && failure.path === file?.path ? failure.message : null
  // 读取失败时保留编辑器可见，否则错误提示会随预览一起被隐藏
  const editorHidden = previewVisible && viewMode === 'preview' && !errorMessage

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isMarkdown ? (
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
          <span className="ml-auto pr-1 text-[11px] text-dim">Markdown</span>
        </div>
      ) : null}
      <div ref={splitAreaRef} className="flex min-h-0 flex-1">
        <div
          className={cn(
            'relative min-h-0 min-w-0 flex-1 overflow-hidden',
            editorHidden && 'invisible absolute inset-0'
          )}
          style={viewMode === 'split' ? { flex: `${splitRatio} 1 0%` } : undefined}
          aria-hidden={editorHidden}
        >
          <div ref={containerRef} className="absolute inset-0" />
          {errorMessage ? (
            <p className="pointer-events-none absolute inset-0 m-0 flex items-center justify-center p-6 text-center text-dim">
              {errorMessage}
            </p>
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
              style={viewMode === 'split' ? { flex: `${1 - splitRatio} 1 0%` } : undefined}
            >
              <MarkdownPreview
                content={markdownText}
                basePath={file ? dirname(file.path) : undefined}
                className="min-h-0 flex-1"
              />
              {markdownText.trim() === '' ? (
                <p className="pointer-events-none absolute inset-0 m-0 flex items-center justify-center p-6 text-center text-dim">
                  空文档
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
