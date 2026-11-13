import { useEffect } from 'react'
import { cn } from '../../lib/utils'
import type { MessageDialogProps } from './types'

/** 次按钮：与 PromptDialog 的取消按钮同一套主题样式 */
const SECONDARY_CLASS =
  'cursor-pointer rounded-[3px] border border-line bg-transparent px-3 py-1 font-[inherit] text-[12px] text-fg transition-colors hover:bg-hover'

/** 主按钮：跟随主题强调色 */
const PRIMARY_CLASS =
  'cursor-pointer rounded-[3px] border border-accent-hover bg-accent-hover px-3 py-1 font-[inherit] text-[12px] text-[#fff] transition-opacity hover:opacity-90'

/**
 * 轻量消息对话框：标题 + 正文 + 可选详情（如导出路径），按钮由调用方给出。
 * 与 PromptDialog 共用主题变量，颜色随应用主题切换，不使用原生弹窗。
 */
export default function MessageDialog({
  title,
  message,
  detail,
  tone = 'info',
  actions,
  onClose
}: MessageDialogProps): React.JSX.Element {
  // Esc 关闭：捕获阶段阻断传播，避免同时触发下层弹层（如会话历史）的关闭逻辑
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center bg-[color-mix(in_srgb,var(--bg)_60%,transparent)] pt-[18vh]"
      onMouseDown={(event) => {
        // 仅点击遮罩本身（非面板）时关闭
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-[min(440px,90vw)] rounded-md border border-line bg-elevated p-3 shadow-[0_4px_16px_rgba(0,0,0,0.45)]"
      >
        <p className="m-0 mb-2 text-[13px] font-medium text-fg">{title}</p>
        <p
          className={cn(
            'm-0 text-[12px] break-words',
            tone === 'error' ? 'text-danger' : 'text-fg'
          )}
        >
          {message}
        </p>
        {detail ? <p className="m-0 mt-2 text-[11px] break-all text-dim">{detail}</p> : null}
        <div className="mt-3 flex justify-end gap-2">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={action.primary ? PRIMARY_CLASS : SECONDARY_CLASS}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
