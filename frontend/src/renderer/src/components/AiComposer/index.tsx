import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, Folder, Square, X } from 'lucide-react'
import { DEFAULT_CONTEXT_WINDOW } from '@shared/ai/context'
import { attachmentKey } from '@shared/ai/attachments'
import type { ModelConfig } from '@shared/model-config/types'
import AiContextUsage from '../AiContextUsage'
import FileRow from '../FileRow'
import ModelSelector from '../ModelSelector'
import { Textarea } from '../ui/textarea'
import { attachmentLabel, attachmentLineLabel } from '../../lib/aiAttachment'
import { basename } from '../../lib/filePath'
import type { ModelCallSettingsValue } from '../ModelCallSettings/types'
import type { AiComposerProps } from './types'

/**
 * 发送按钮：绿底方块 + 黑色前进箭头，输入为空或无会话时禁用。
 * 由右侧工具组固定在行尾，左侧留给模型选择器与上下文用量入口。
 */
const SEND_BUTTON_CLASS =
  'inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-[#3fb950] p-0 text-[#0b0f14] transition-[filter] hover:brightness-110 disabled:cursor-default disabled:opacity-40'

/**
 * 停止按钮：生成中用同一位置、同一尺寸替换发送键，避免光标与视线跳动。
 * 用中性色而不是红色——停止是正常操作，不是危险动作。
 */
const STOP_BUTTON_CLASS =
  'inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-line bg-elevated p-0 text-fg transition-colors hover:bg-hover'

/**
 * AI 输入区：多行输入框 + 底部状态栏（左模型选择器、右发送按钮）。
 * Enter 发送、Shift+Enter 换行；输入法组合输入期间的 Enter 不触发发送。
 * 生成中发送键变成停止键，Esc 等价于点击停止（焦点在输入框时）。
 */
export default function AiComposer({
  disabled = false,
  running = false,
  usage,
  canCreateSession,
  onCreateSession,
  attachments,
  onRemoveAttachment,
  onOpenFile,
  onSend,
  onAbort
}: AiComposerProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [models, setModels] = useState<ModelConfig[]>([])
  const [selectedModelId, setSelectedModelId] = useState<number | null>(null)

  // 模型列表与上次选中的模型都来自本地数据库；任一读取失败都不阻塞输入。
  // 记录的模型已被删除时回落到列表第一个，并把回落结果写回数据库。
  useEffect(() => {
    let active = true
    Promise.all([
      window.api.listModelConfigs(),
      window.api.getSelectedModelConfigId().catch(() => null)
    ])
      .then(([list, saved]) => {
        if (!active) {
          return
        }
        setModels(list)
        const storedValid = saved !== null && list.some((model) => model.id === saved)
        const resolved = storedValid ? saved : (list[0]?.id ?? null)
        setSelectedModelId(resolved)
        if (resolved !== null && resolved !== saved) {
          window.api.saveSelectedModelConfigId(resolved).catch(() => undefined)
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  // 用户切换模型时立即记住选择，下次打开对话框直接恢复
  const handleModelChange = useCallback((id: number): void => {
    setSelectedModelId(id)
    window.api.saveSelectedModelConfigId(id).catch(() => undefined)
  }, [])

  // 保存单个模型的窗口与思考深度：落库后同步本地列表，切回该模型立即生效
  const handleSaveCallSettings = useCallback(
    async (id: number, settings: ModelCallSettingsValue): Promise<void> => {
      const model = models.find((item) => item.id === id)
      if (!model) {
        return
      }
      const saved = await window.api.updateModelConfig(id, {
        providerName: model.providerName,
        baseUrl: model.baseUrl,
        displayName: model.displayName,
        modelName: model.modelName,
        apiKey: model.apiKey,
        contextWindow: settings.contextWindow,
        reasoningEffort: settings.reasoningEffort
      })
      setModels((previous) => previous.map((item) => (item.id === saved.id ? saved : item)))
    },
    [models]
  )

  const selectedModel = models.find((model) => model.id === selectedModelId) ?? null
  // 用量百分比跟随当前模型配置的窗口：切换模型后不必等下一次调用就能看到新口径
  const displayUsage = usage
    ? {
        usedTokens: usage.usedTokens,
        limitTokens: selectedModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
      }
    : null

  // 没有可用模型时也无法发送：主进程按 modelConfigId 读密钥
  const canSend = value.trim().length > 0 && !disabled && !running && selectedModelId !== null

  const submit = useCallback((): void => {
    const text = value.trim()
    if (!text || disabled || running || selectedModelId === null) {
      return
    }
    onSend(text, selectedModelId, attachments)
    setValue('')
  }, [attachments, disabled, onSend, running, selectedModelId, value])

  return (
    <div className="shrink-0 border-t border-line p-2">
      {attachments.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1" aria-label="已附加的上下文">
          {attachments.map((attachment) => {
            const lineLabel = attachmentLineLabel(attachment)
            const content = (
              <>
                <FileRow
                  name={basename(attachment.path)}
                  icon={
                    attachment.kind === 'directory' ? (
                      <Folder className="size-3.5 fill-current text-[#dcb67a]" />
                    ) : undefined
                  }
                  className="gap-1"
                />
                {lineLabel ? (
                  <span className="ml-0.5 shrink-0 text-[10px] text-dim">{lineLabel}</span>
                ) : null}
              </>
            )
            return (
              <span
                key={attachmentKey(attachment)}
                className="inline-flex h-5 max-w-[220px] items-center rounded-[3px] border border-line bg-elevated pl-1.5 text-[12px] leading-5 text-fg"
              >
                {attachment.kind === 'directory' ? (
                  <span title={attachment.path}>{content}</span>
                ) : (
                  <button
                    type="button"
                    className="inline-flex min-w-0 cursor-pointer items-center border-none bg-transparent p-0 text-inherit transition-opacity hover:opacity-80"
                    aria-label={`打开 ${basename(attachment.path)}`}
                    title={`打开 ${attachment.path}`}
                    onClick={() => onOpenFile(attachment.path)}
                  >
                    {content}
                  </button>
                )}
                {/* 与编辑器标签的关闭按钮同一套交互：悬停出底色，点击只移除自己 */}
                <button
                  type="button"
                  className="relative ml-0.5 inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent p-0 text-dim transition-colors hover:bg-[color-mix(in_srgb,var(--text)_14%,transparent)] hover:text-fg"
                  aria-label={`移除 ${attachmentLabel(attachment)}`}
                  title="移除"
                  onClick={() => onRemoveAttachment(attachment)}
                >
                  <X className="size-2.5" />
                </button>
              </span>
            )
          })}
        </div>
      ) : null}
      <Textarea
        className="max-h-40 min-h-[64px] resize-none bg-base text-[13px] focus-visible:border-accent-hover"
        placeholder={
          disabled
            ? '先新建一个会话'
            : running
              ? '正在生成，可点右侧停止'
              : '输入消息，Enter 发送，Shift+Enter 换行'
        }
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // 停在心里觉得不对的时候手不用离开键盘：Esc 等价于点停止键
          if (event.key === 'Escape' && running && onAbort) {
            event.preventDefault()
            onAbort()
            return
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
      />
      {/* 状态栏：左侧模型选择器，右侧上下文用量与发送键 */}
      <div className="mt-2 flex items-center gap-2">
        {/* 模型选择器：列表单选，行内铅笔按钮在列表左侧展开调用设置浮层 */}
        <ModelSelector
          models={models}
          selectedModelId={selectedModelId}
          onSelect={handleModelChange}
          onUpdateModel={handleSaveCallSettings}
        />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <AiContextUsage
            usage={displayUsage}
            canCreate={canCreateSession}
            onCreateSession={onCreateSession}
          />
          {running && onAbort ? (
            <button
              type="button"
              className={STOP_BUTTON_CLASS}
              aria-label="停止生成"
              title="停止生成（Esc）"
              onClick={onAbort}
            >
              <Square className="size-3 fill-current" strokeWidth={0} />
            </button>
          ) : (
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
          )}
        </div>
      </div>
    </div>
  )
}
