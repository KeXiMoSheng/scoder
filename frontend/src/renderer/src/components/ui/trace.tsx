import * as React from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from 'cn'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible'

/**
 * Trace 组件族（对齐 shadcn/ui 的 trace）：
 * 一行摘要 + 可展开的左侧竖线详情，用于推理过程、工具调用与任务清单。
 * 这里的样式取应用主题令牌（text-dim / border-line …），随主题切换联动。
 */

function Trace({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="trace"
      className={cn('flex w-full min-w-0 flex-col gap-2', className)}
      {...props}
    />
  )
}

function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<'span'> & {
  /** 行状态：pending 置灰、running 由调用方加流光、error 用危险色 */
  status?: 'running' | 'error' | 'pending'
}) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        'flex w-fit max-w-full min-w-0 items-center gap-2 text-[12px] leading-5 text-dim transition-colors',
        'data-[status=error]:text-danger data-[status=pending]:opacity-60',
        className
      )}
      {...props}
    />
  )
}

function TraceIcon({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        'flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*=size-])]:size-4',
        className
      )}
      {...props}
    />
  )
}

function TraceTitle({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="trace-title" className={cn('min-w-0', className)} {...props} />
}

function TraceDescription({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-description"
      className={cn('shrink-0 text-dim/70 tabular-nums', className)}
      {...props}
    />
  )
}

function TraceCollapsible({
  className,
  defaultExpanded,
  ...props
}: React.ComponentProps<typeof Collapsible> & {
  /** 打开时默认展开；与 Radix 的 defaultOpen 等价 */
  defaultExpanded?: boolean
}) {
  return (
    <Collapsible
      data-slot="trace-collapsible"
      defaultOpen={defaultExpanded}
      className={cn('flex w-full min-w-0 flex-col', className)}
      {...props}
    />
  )
}

function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        'group/trace-collapsible-trigger flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded text-left text-dim transition-colors outline-none',
        'hover:text-fg focus-visible:ring-1 focus-visible:ring-line has-[[data-status=error]]:text-danger',
        className
      )}
      {...props}
    >
      {children}
      <TraceIcon className="transition-transform group-data-[state=open]/trace-collapsible-trigger:rotate-90">
        <ChevronRightIcon />
      </TraceIcon>
    </CollapsibleTrigger>
  )
}

function TraceCollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="trace-collapsible-content"
      className="min-w-0 overflow-hidden"
      {...props}
    >
      <div
        data-slot="trace-collapsible-content-inner"
        className={cn(
          'mt-2 mb-1 ml-[7px] min-w-0 border-l border-line pr-1 pl-4 break-words text-dim',
          className
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  )
}

export {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent
}
