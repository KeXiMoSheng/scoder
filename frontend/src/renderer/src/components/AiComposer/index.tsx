import { useCallback, useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import type { ModelConfig } from '@shared/model-config/types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Textarea } from '../ui/textarea'
import type { AiComposerProps } from './types'

/**
 * 发送按钮：绿底方块 + 黑色前进箭头，输入为空或无会话时禁用。
 * ml-auto 把它固定在行尾，左侧留给模型选择器和后续工具按钮。
 */
const SEND_BUTTON_CLASS =
  'ml-auto inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-[#3fb950] p-0 text-[#0b0f14] transition-[filter] hover:brightness-110 disabled:cursor-default disabled:opacity-40'

/**
 * AI 输入区：多行输入框 + 底部状态栏（左模型选择器、右发送按钮）。
 * Enter 发送、Shift+Enter 换行；输入法组合输入期间的 Enter 不触发发送。
 */
export default function AiComposer({
  disabled = false,
  onSend
}: AiComposerProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [models, setModels] = useState<ModelConfig[]>([])
  const [modelId, setModelId] = useState<number | null>(null)

  // 模型列表来自本地数据库；读取失败时按「未配置模型」展示，不阻塞输入
  useEffect(() => {
    let active = true
    window.api
      .listModelConfigs()
      .then((list) => {
        if (active) {
          setModels(list)
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  // 选中的模型被删除后回落到列表第一个
  const selectedModelId =
    modelId !== null && models.some((model) => model.id === modelId)
      ? modelId
      : (models[0]?.id ?? null)

  const canSend = value.trim().length > 0 && !disabled

  const submit = useCallback((): void => {
    const text = value.trim()
    if (!text || disabled) {
      return
    }
    onSend(text)
    setValue('')
  }, [disabled, onSend, value])

  return (
    <div className="shrink-0 border-t border-line p-2">
      <Textarea
        className="max-h-40 min-h-[64px] resize-none bg-base text-[13px] focus-visible:border-accent-hover"
        placeholder={disabled ? '先新建一个会话' : '输入消息，Enter 发送，Shift+Enter 换行'}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
      />
      {/* 状态栏：模型选择器只占模型名所需宽度，后续工具按钮插在发送键之前 */}
      <div className="mt-2 flex items-center gap-2">
        {/* 用主题化的 Select 而非原生 select：原生下拉弹层的高亮色由系统决定，不随主题变化 */}
        <Select
          value={selectedModelId === null ? undefined : String(selectedModelId)}
          onValueChange={(value) => setModelId(Number(value))}
          disabled={models.length === 0}
        >
          <SelectTrigger
            size="sm"
            className="min-w-0 max-w-full px-2 text-xs"
            aria-label="选择模型"
            title={
              selectedModelId === null
                ? '尚未配置模型，请到「设置 → 模型」中添加'
                : models.find((model) => model.id === selectedModelId)?.displayName
            }
          >
            <SelectValue placeholder="未配置模型" />
          </SelectTrigger>
          <SelectContent className="max-w-[280px]">
            {models.map((model) => (
              <SelectItem key={model.id} value={String(model.id)}>
                {model.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          className={SEND_BUTTON_CLASS}
          aria-label="发送消息"
          title="发送（Enter）"
          disabled={!canSend}
          onClick={submit}
        >
          <ArrowRight className="size-4" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  )
}
