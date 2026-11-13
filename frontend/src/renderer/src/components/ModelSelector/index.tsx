import { useRef, useState } from 'react'
import { Check, ChevronDown, Pencil } from 'lucide-react'
import { formatContextWindow } from '@shared/ai/context'
import type { ModelConfig } from '@shared/model-config/types'
import { cn } from '../../lib/utils'
import { CallSettingsFields } from '../ModelCallSettings'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import type { ModelSelectorProps } from './types'

/** 模型行右侧摘要：窗口 · 思考深度 */
function callSummary(model: ModelConfig): string {
  return `${formatContextWindow(model.contextWindow)} · ${model.reasoningEffort}`
}

/**
 * 模型选择器：菜单式单选列表。
 * 每行右侧的铅笔按钮打开该模型的调用设置，浮层悬空在模型列表左侧，
 * 不占位、不挤压列表；窗口与思考深度都是无边框单选，选中项带对勾。
 */
export default function ModelSelector({
  models,
  selectedModelId,
  onSelect,
  onUpdateModel
}: ModelSelectorProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [settingsModelId, setSettingsModelId] = useState<number | null>(null)
  // 设置浮层 Portal 在 body：菜单判定「点击/焦点在外部」时要放行它，否则一操作设置整个列表就关了
  const settingsContentRef = useRef<HTMLDivElement>(null)
  // 模型列表本体：用来把设置浮层的右边缘对齐到列表左边缘
  const menuContentRef = useRef<HTMLDivElement>(null)
  const [settingsOffset, setSettingsOffset] = useState(0)

  const selectedModel = models.find((model) => model.id === selectedModelId) ?? null

  // side="left" 时浮层右边缘距锚点左边缘的偏移：锚点到列表左边缘的距离再加 6px，
  // 让浮层右边缘与列表左边缘之间留出一道缝
  const measureSettingsAnchor = (trigger: HTMLElement): void => {
    const menuRect = menuContentRef.current?.getBoundingClientRect()
    if (!menuRect) {
      return
    }
    const triggerRect = trigger.getBoundingClientRect()
    setSettingsOffset(Math.max(0, Math.round(triggerRect.left - menuRect.left) + 6))
  }

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) {
      setSettingsModelId(null)
    }
  }

  const handleSelect = (id: number): void => {
    onSelect(id)
    setOpen(false)
  }

  const isInsideSettings = (target: EventTarget | null): boolean =>
    target instanceof Node && settingsContentRef.current?.contains(target) === true

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-w-0 max-w-full justify-between gap-2 bg-transparent px-2 text-xs font-normal text-fg hover:bg-hover hover:text-fg data-[state=open]:bg-hover"
          aria-label="选择模型"
          disabled={models.length === 0}
          title={
            selectedModel
              ? `${selectedModel.displayName}（${callSummary(selectedModel)}）`
              : '尚未配置模型，请到「设置 → 模型」中添加'
          }
        >
          <span className="truncate">{selectedModel?.displayName ?? '未配置模型'}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={menuContentRef}
        side="top"
        align="start"
        sideOffset={6}
        className="w-72"
        onPointerDownOutside={(event) => {
          if (isInsideSettings(event.target)) {
            event.preventDefault()
          }
        }}
        onFocusOutside={(event) => {
          if (isInsideSettings(event.target)) {
            event.preventDefault()
          }
        }}
      >
        {models.length === 0 ? (
          <p className="m-0 px-2 py-3 text-center text-[11px] text-dim">
            尚未配置模型，请到「设置 → 模型」中添加
          </p>
        ) : null}
        {models.map((model) => {
          const selected = model.id === selectedModelId
          return (
            <div
              key={model.id}
              className={cn(
                'flex items-center gap-0.5 rounded-[3px] pr-0.5 transition-colors',
                // 选中行用主题链接色的淡底 + 左侧色条，与普通 hover 的灰底区分
                selected &&
                  'bg-[color-mix(in_srgb,var(--link)_14%,transparent)] shadow-[inset_2px_0_0_0_var(--link)]'
              )}
            >
              <DropdownMenuItem
                className={cn(
                  'min-w-0 flex-1 gap-1.5 py-1.5 pr-1 pl-1.5',
                  selected &&
                    'focus:bg-[color-mix(in_srgb,var(--link)_20%,transparent)] focus:text-fg'
                )}
                onSelect={() => handleSelect(model.id)}
              >
                {/* 固定宽度占位：无论是否选中，文字都从同一列开始 */}
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  {selected ? <Check className="size-3.5 text-link" /> : null}
                </span>
                <span className="truncate text-[12px] text-fg">{model.displayName}</span>
                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-dim">
                  {callSummary(model)}
                </span>
              </DropdownMenuItem>
              {/* 行内编辑按钮：点击后在列表左侧悬空展开该模型的调用设置 */}
              <DropdownMenu
                open={settingsModelId === model.id}
                onOpenChange={(next) => setSettingsModelId(next ? model.id : null)}
                modal={false}
              >
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={(event) => measureSettingsAnchor(event.currentTarget)}
                    className="inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-[3px] border-none bg-transparent p-0 text-dim transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"
                    aria-label={`编辑 ${model.displayName} 的调用设置`}
                    title="上下文窗口与思考深度"
                  >
                    <Pencil className="size-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  ref={settingsContentRef}
                  side="left"
                  align="start"
                  sideOffset={settingsOffset}
                  className="w-48"
                  // modal={false} 的菜单不拦焦点外移：鼠标划过模型列表时列表项会抢走焦点，
                  // 这里兜住，浮层只由点击外部或再点铅笔来关闭
                  onFocusOutside={(event) => event.preventDefault()}
                >
                  <CallSettingsFields key={model.id} model={model} onSave={onUpdateModel} />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
