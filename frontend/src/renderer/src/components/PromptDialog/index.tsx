import { useEffect, useState } from 'react'
import type { PromptDialogProps } from './types'

/**
 * 轻量名称输入对话框：用于新建文件/文件夹时录入名称。
 * 回车或「创建」提交（值去空白后为空则忽略），Esc、点击遮罩或「取消」关闭。
 */
export default function PromptDialog({
  title,
  placeholder,
  confirmLabel = '创建',
  defaultValue = '',
  onConfirm,
  onCancel
}: PromptDialogProps): React.JSX.Element {
  const [value, setValue] = useState(defaultValue)

  const submit = (): void => {
    const trimmed = value.trim()
    if (trimmed) {
      onConfirm(trimmed)
    }
  }

  // Esc 关闭（放在窗口层，避免输入框未聚焦时失效）
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center bg-[color-mix(in_srgb,var(--bg)_60%,transparent)] pt-[18vh]"
      onMouseDown={(event) => {
        // 仅点击遮罩本身（非面板）时取消
        if (event.target === event.currentTarget) {
          onCancel()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-[min(360px,90vw)] rounded-md border border-line bg-elevated p-3 shadow-[0_4px_16px_rgba(0,0,0,0.45)]"
      >
        <p className="m-0 mb-2 text-[13px] font-medium text-fg">{title}</p>
        <input
          className="w-full rounded-[3px] border border-line bg-base px-2 py-1 font-[inherit] text-[13px] text-fg outline-none transition-colors placeholder:text-dim focus:border-accent-hover"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          aria-label={title}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="cursor-pointer rounded-[3px] border border-line bg-transparent px-3 py-1 font-[inherit] text-[12px] text-fg transition-colors hover:bg-hover"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="cursor-pointer rounded-[3px] border border-accent-hover bg-accent-hover px-3 py-1 font-[inherit] text-[12px] text-[#fff] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
            disabled={!value.trim()}
            onClick={submit}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
