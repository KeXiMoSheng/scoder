import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { OpenedFile } from '../hooks/useOpenedFiles'
import { monaco } from '../lib/monaco'
import { detectLanguage } from '../lib/language'
import { extractErrorMessage } from '../lib/errorMessage'
import { isAtOrUnder } from '../lib/filePath'

/** 暴露给 App 的命令式接口（通过 ref 调用） */
export interface CodeEditorHandle {
  /** 保存指定路径及其子路径下所有有未保存修改的文件；任一保存失败时抛错（用于移动/重命名前落盘） */
  saveDirtyUnder: (path: string) => Promise<void>
  /** 丢弃指定路径及其子路径的模型缓存（条目被重命名/移动后调用，避免旧路径残留） */
  dropCachedUnder: (path: string) => void
}

interface CodeEditorProps {
  /** 当前激活的标签文件（由标签栏切换）；null 表示没有打开任何文件 */
  file: OpenedFile | null
  /** 未保存状态变化通知（按文件绝对路径归属） */
  onDirtyChange: (path: string, dirty: boolean) => void
  ref?: React.Ref<CodeEditorHandle>
}

/** 读取或保存失败的文件及原因（按路径归属，切换文件后旧错误不再展示） */
interface LoadFailure {
  path: string
  message: string
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
      theme: 'vs-dark',
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

  return (
    <div className="editor-pane__body">
      <div ref={containerRef} className="editor-pane__canvas" />
      {errorMessage ? <p className="editor-pane__notice">{errorMessage}</p> : null}
      {!file && !errorMessage ? (
        <p className="editor-pane__notice">从左侧选择一个文件进行编辑</p>
      ) : null}
    </div>
  )
}
