import { Check } from 'lucide-react'
import { TEXT_ENCODINGS, encodingLabel } from '@shared/files/encoding'
import { cn } from '../../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import type { StatusBarProps } from './types'

/** 置信度转成百分比文案（用于菜单项的悬停提示） */
function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`
}

/**
 * 窗口底部状态栏：编码选择器贴在最右侧。
 * 与 VS Code 一致：选择后按该编码重新解释文件内容，后续保存也按同一编码写回；
 * 菜单里把自动识别出的候选编码标出来——第一条为「最可能」，其余为「可能」，
 * 当前生效的编码另有对勾，三者相互独立。
 */
export default function StatusBar({
  encoding,
  candidates,
  onChange
}: StatusBarProps): React.JSX.Element {
  const top = candidates[0]
  const triggerTitle =
    encoding === null
      ? ''
      : top === undefined
        ? `当前编码：${encodingLabel(encoding)}`
        : `当前编码：${encodingLabel(encoding)}；最可能：${encodingLabel(top.encoding)}（${formatConfidence(top.confidence)}）`

  return (
    <footer className="flex h-6 shrink-0 items-center justify-end border-t border-line bg-elevated px-2">
      {encoding !== null ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="cursor-pointer rounded-sm border-none bg-transparent px-1.5 text-[11px] leading-5 text-dim transition-colors hover:bg-hover hover:text-fg"
              title={triggerTitle}
            >
              {encodingLabel(encoding)}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="min-w-[220px]">
            {TEXT_ENCODINGS.map((item) => {
              const candidateIndex = candidates.findIndex(
                (candidate) => candidate.encoding === item.id
              )
              return (
                <DropdownMenuItem
                  key={item.id}
                  className="text-[12px]"
                  title={
                    candidateIndex === -1
                      ? undefined
                      : `检测置信度 ${formatConfidence(candidates[candidateIndex].confidence)}`
                  }
                  onSelect={() => onChange(item.id)}
                >
                  <span className="flex-1">{item.label}</span>
                  {candidateIndex !== -1 ? (
                    <span
                      className={cn(
                        'shrink-0 text-[10px] leading-4',
                        candidateIndex === 0 ? 'text-link' : 'text-dim/70'
                      )}
                    >
                      {candidateIndex === 0 ? '最可能' : '可能'}
                    </span>
                  ) : null}
                  {item.id === encoding ? <Check className="size-3.5 text-link" /> : null}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </footer>
  )
}
