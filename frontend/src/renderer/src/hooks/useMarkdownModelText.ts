import { useCallback, useSyncExternalStore } from 'react'
import { monaco } from '../lib/monaco'

/** 合并连续击键的预览刷新间隔（ms） */
const REFRESH_DELAY = 120

const EMPTY_TEXT = ''

/**
 * 订阅指定路径 model 的内容变化。
 * 文件是异步读取的，模型可能晚于订阅创建；模型被丢弃后重建（如重命名）也需要重新挂接，
 * 因此统一监听 onDidCreateModel 并在模型就绪时补订阅。
 */
function subscribeModel(path: string, onStoreChange: () => void): () => void {
  const disposables: monaco.IDisposable[] = []
  const attached = new WeakSet<monaco.editor.ITextModel>()
  let disposed = false
  let timer: number | null = null

  /** 合并高频击键：同一时间窗内只通知一次 */
  const schedule = (): void => {
    if (timer !== null) {
      return
    }
    timer = window.setTimeout(() => {
      timer = null
      onStoreChange()
    }, REFRESH_DELAY)
  }

  const attach = (model: monaco.editor.ITextModel): void => {
    if (disposed || attached.has(model) || model.uri.fsPath !== path) {
      return
    }
    attached.add(model)
    disposables.push(model.onDidChangeContent(schedule))
    // 模型刚就绪：立即通知一次，让预览拿到首屏文本
    schedule()
  }

  const existing = monaco.editor.getModel(monaco.Uri.file(path))
  if (existing) {
    attach(existing)
  }
  disposables.push(monaco.editor.onDidCreateModel(attach))

  return () => {
    disposed = true
    if (timer !== null) {
      window.clearTimeout(timer)
    }
    for (const disposable of disposables) {
      disposable.dispose()
    }
  }
}

/**
 * 读取并订阅指定路径的 Monaco model 文本，作为预览的外部数据源：
 * 编辑内容与激活文件变化都由订阅驱动，无需把全文放进组件 state。
 * enabled 为 false（非 Markdown 文件或编辑模式）时不订阅并返回空文本。
 */
export function useMarkdownModelText(path: string | null, enabled: boolean): string {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) =>
      path !== null && enabled ? subscribeModel(path, onStoreChange) : () => {},
    [enabled, path]
  )
  const getSnapshot = useCallback((): string => {
    if (path === null || !enabled) {
      return EMPTY_TEXT
    }
    return monaco.editor.getModel(monaco.Uri.file(path))?.getValue() ?? EMPTY_TEXT
  }, [enabled, path])
  return useSyncExternalStore(subscribe, getSnapshot)
}
