import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { extractErrorMessage } from '../../lib/errorMessage'
import ModelConfigCard from '../ModelConfigCard'
import ModelConfigForm from '../ModelConfigForm'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'
import type { ModelConfig, ModelConfigInput } from '@shared/model-config/types'
import type { ModelEditorState } from './types'

/** 列表加载骨架数量：与默认窗口下可见的卡片列数一致 */
const SKELETON_COUNT = 3

/** 模型设置分区：模型卡片列表 + 新建/编辑表单 */
export default function ModelSettings(): React.JSX.Element {
  const [configs, setConfigs] = useState<ModelConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<ModelEditorState>(null)

  /** 首屏加载：在异步回调中更新状态，避免 effect 内同步触发级联渲染 */
  useEffect(() => {
    let active = true
    window.api
      .listModelConfigs()
      .then((list) => {
        if (active) {
          setConfigs(list)
        }
      })
      .catch((reason) => {
        if (active) {
          setError(extractErrorMessage(reason))
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [])

  /** 加载失败后的重试入口（由点击事件触发） */
  const reloadConfigs = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setConfigs(await window.api.listModelConfigs())
    } catch (reason) {
      setError(extractErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  /** 保存表单：出错时抛出，由表单展示具体原因 */
  const handleSubmit = useCallback(
    async (input: ModelConfigInput): Promise<void> => {
      if (editor?.mode === 'edit') {
        const saved = await window.api.updateModelConfig(editor.config.id, input)
        setConfigs((prev) => prev.map((item) => (item.id === saved.id ? saved : item)))
      } else {
        const created = await window.api.createModelConfig(input)
        setConfigs((prev) => [created, ...prev])
      }
      setEditor(null)
      setError(null)
    },
    [editor]
  )

  const handleDelete = useCallback(async (config: ModelConfig): Promise<void> => {
    setError(null)
    try {
      const deleted = await window.api.deleteModelConfig(config.id)
      if (deleted) {
        setConfigs((prev) => prev.filter((item) => item.id !== config.id))
      }
    } catch (reason) {
      setError(extractErrorMessage(reason))
    }
  }, [])

  if (editor) {
    return (
      <ModelConfigForm
        key={editor.mode === 'edit' ? editor.config.id : 'create'}
        initial={editor.mode === 'edit' ? editor.config : null}
        onSubmit={handleSubmit}
        onCancel={() => setEditor(null)}
      />
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-fg">模型</h1>
          <p className="mt-1 leading-[1.6] text-dim">
            管理 AI 对话使用的模型供应商、模型与 API Key。
          </p>
        </div>
        <Button type="button" onClick={() => setEditor({ mode: 'create' })}>
          <Plus />
          添加模型
        </Button>
      </div>

      {error ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">
          <span className="min-w-0 flex-1 leading-[1.6]">{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0"
            onClick={() => void reloadConfigs()}
          >
            重试
          </Button>
        </div>
      ) : null}

      {loading ? (
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: SKELETON_COUNT }, (_, index) => (
            <Skeleton key={index} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : configs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line px-6 py-12 text-center">
          <p className="text-fg">还没有配置模型</p>
          <p className="max-w-sm leading-[1.6] text-dim">
            添加一个模型后，即可在 AI 对话中选择并使用它。
          </p>
          <Button type="button" variant="outline" onClick={() => setEditor({ mode: 'create' })}>
            <Plus />
            添加模型
          </Button>
        </div>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {configs.map((config) => (
            <ModelConfigCard
              key={config.id}
              config={config}
              onEdit={(target) => setEditor({ mode: 'edit', config: target })}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}
