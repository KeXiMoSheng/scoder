import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { monaco } from '../../lib/monaco'
import { detectLanguage, isMarkdownFile, isSvgFile } from '../../lib/language'
import { extractErrorMessage } from '../../lib/errorMessage'
import { dirname, isAtOrUnder } from '../../lib/filePath'
import { getActiveThemeId } from '../../lib/theme'
import { cn } from '../../lib/utils'
import { useModelText } from '../../hooks/useModelText'
import MarkdownPreview from '../MarkdownPreview'
import ResizeHandle from '../ResizeHandle'
import SvgPreview from '../SvgPreview'
import { Button } from '../ui/button'
import type { CodeEditorProps, LoadFailure, PreviewViewMode } from './types'

/**
 * 每个 model 的保存点版本：model 是全局缓存，保存点也跟随 model 而非组件实例，
 * 组件重挂载（热更新）后复用缓存时不会因查不到保存点而误报脏点。
 */
const savedVersions = new WeakMap<monaco.editor.ITextModel, number>()

/** 分栏模式下的编辑区宽度占比上下限 */
const SPLIT_MIN_RATIO = 0.2
const SPLIT_MAX_RATIO = 0.8

/** 工具栏上的三档视图选项 */
const VIEW_MODES: readonly { id: PreviewViewMode; label: string }[] = [
  { id: 'edit', label: '编辑' },
  { id: 'split', label: '分栏' },
  { id: 'preview', label: '预览' }
]

export default function CodeEditor({
  file,
  onDirtyChange,
  onSendSelectionToAi,
  ref
}: CodeEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [failure, setFailure] = useState<LoadFailure | null>(null)
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

  /** 保存单个缓冲区到磁盘；保存期间产生的新改动仍保持未保存状态 */
  const saveModel = useCallback(
    async (model: monaco.editor.ITextModel): Promise<void> => {
      const path = model.uri.fsPath
      const version = model.getAlternativeVersionId()
      await window.api.writeFile(path, model.getValue())
      savedVersions.set(model, version)
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
      // 模型缓存可能早于本次组件挂载（热更新重挂载后保存点已丢失）：
      // 以当前内容为基线，避免仅打开文件就误报脏点
      if (!savedVersions.has(cachedModel)) {
        savedVersions.set(cachedModel, cachedModel.getAlternativeVersionId())
      }
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
        savedVersions.set(model, model.getAlternativeVersionId())
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
        void window.api
          .readFile(path)
          .then((content) => {
            // 读盘期间用户可能开始输入：再判一次，避免冲掉刚写的内容
            if (isDirty(model) || model.getValue() === content) {
              return
            }
            model.setValue(content)
            savedVersions.set(model, model.getAlternativeVersionId())
            syncDirty(model)
          })
          .catch(() => {
            // 读不到（例如刚被删除）：保持现状，让用户下次操作时看到真实错误
          })
      }
    }),
    [isDirty, saveModel, syncDirty]
  )

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
    </div>
  )
}
