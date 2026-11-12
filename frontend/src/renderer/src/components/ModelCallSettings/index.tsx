import { useState } from 'react'
import { formatContextWindow } from '@shared/ai/context'
import {
  MODEL_CONTEXT_WINDOW_OPTIONS,
  MODEL_REASONING_EFFORT_OPTIONS,
  type ModelContextWindow,
  type ModelReasoningEffort
} from '@shared/model-config/types'
import { extractErrorMessage } from '../../lib/errorMessage'
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '../ui/dropdown-menu'
import type { CallSettingsFieldsProps, ModelCallSettingsValue } from './types'

/**
 * 单个模型的调用设置：上下文窗口、思考深度两组单选。
 * 由模型行的编辑按钮以浮层形式打开；点选即保存并保持菜单展开，
 * 保存失败时回滚勾选并在底部提示错误。
 */
export function CallSettingsFields({ model, onSave }: CallSettingsFieldsProps): React.JSX.Element {
  // 提交中的乐观值：落库结果回来前先用它回显，成功或失败都以父级刷新后的值为准
  const [draft, setDraft] = useState<ModelCallSettingsValue | null>(null)
  const [error, setError] = useState<string | null>(null)

  const contextWindow = draft?.contextWindow ?? model.contextWindow
  const reasoningEffort = draft?.reasoningEffort ?? model.reasoningEffort

  const persist = (next: ModelCallSettingsValue): void => {
    setError(null)
    setDraft(next)
    onSave(model.id, next)
      .then(() => setDraft(null))
      .catch((reason) => {
        setDraft(null)
        setError(extractErrorMessage(reason))
      })
  }

  const chooseContextWindow = (value: string): void => {
    persist({ contextWindow: Number(value) as ModelContextWindow, reasoningEffort })
  }

  const chooseReasoningEffort = (value: string): void => {
    persist({ contextWindow, reasoningEffort: value as ModelReasoningEffort })
  }

  // preventDefault：点选项后保持菜单展开，方便连续调整另一组
  const keepOpen = (event: Event): void => event.preventDefault()

  return (
    <>
      <DropdownMenuLabel className="px-2 py-1 text-[10px] font-normal text-dim">
        上下文窗口
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup value={String(contextWindow)} onValueChange={chooseContextWindow}>
        {MODEL_CONTEXT_WINDOW_OPTIONS.map((option) => (
          <DropdownMenuRadioItem
            key={option}
            value={String(option)}
            className="py-1.5 pl-8 text-[12px] tabular-nums"
            onSelect={keepOpen}
          >
            {formatContextWindow(option)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>

      <DropdownMenuSeparator />

      <DropdownMenuLabel className="px-2 py-1 text-[10px] font-normal text-dim">
        思考深度
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup value={reasoningEffort} onValueChange={chooseReasoningEffort}>
        {MODEL_REASONING_EFFORT_OPTIONS.map((option) => (
          <DropdownMenuRadioItem
            key={option}
            value={option}
            className="py-1.5 pl-8 text-[12px]"
            onSelect={keepOpen}
          >
            {option}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>

      {error ? (
        <p className="mx-2 mt-1 mb-0 text-[10px] leading-4 text-danger" title={error}>
          {error}
        </p>
      ) : null}
    </>
  )
}
