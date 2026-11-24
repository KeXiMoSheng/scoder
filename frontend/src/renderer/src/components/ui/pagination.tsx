import * as React from 'react'
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react'
import type { VariantProps } from 'class-variance-authority'
import { cn } from 'cn'
import { buttonVariants } from './button'

/**
 * 分页导航：把一组同质内容（如问题、步骤）拆成一次展示一页。
 *
 * 与 shadcn/ui 的 Pagination 保持同一套 API，但链接渲染成 button：
 * 应用内的分页不跳转 URL，全部由调用方的 onClick 驱动，也不该带 href。
 */
function Pagination({ className, ...props }: React.ComponentProps<'nav'>) {
  return (
    <nav
      role="navigation"
      aria-label="pagination"
      data-slot="pagination"
      className={cn('mx-auto flex w-full justify-center', className)}
      {...props}
    />
  )
}

function PaginationContent({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn('flex flex-row items-center gap-0.5', className)}
      {...props}
    />
  )
}

function PaginationItem(props: React.ComponentProps<'li'>) {
  return <li data-slot="pagination-item" {...props} />
}

type PaginationLinkProps = {
  /** 当前页：以描边样式与 aria-current 标出 */
  isActive?: boolean
} & Pick<VariantProps<typeof buttonVariants>, 'size'> &
  React.ComponentProps<'button'>

function PaginationLink({ className, isActive, size = 'icon-xs', ...props }: PaginationLinkProps) {
  return (
    <button
      type="button"
      aria-current={isActive ? 'page' : undefined}
      data-slot="pagination-link"
      data-active={isActive}
      className={cn(
        buttonVariants({ variant: isActive ? 'outline' : 'ghost', size }),
        'font-mono text-[11px] tabular-nums',
        className
      )}
      {...props}
    />
  )
}

/**
 * 上一页。text 由调用方按语境传入（例如「上一题」），默认英文与 shadcn 一致。
 * @param props 分页链接属性与按钮文字
 */
function PaginationPrevious({
  className,
  text = 'Previous',
  ...props
}: React.ComponentProps<typeof PaginationLink> & { text?: string }) {
  return (
    <PaginationLink
      aria-label={text}
      size="xs"
      className={cn('gap-1 px-1.5 text-[11px]', className)}
      {...props}
    >
      <ChevronLeft className="size-3.5" />
      <span>{text}</span>
    </PaginationLink>
  )
}

/**
 * 下一页。text 由调用方按语境传入（例如「下一题」），默认英文与 shadcn 一致。
 * @param props 分页链接属性与按钮文字
 */
function PaginationNext({
  className,
  text = 'Next',
  ...props
}: React.ComponentProps<typeof PaginationLink> & { text?: string }) {
  return (
    <PaginationLink
      aria-label={text}
      size="xs"
      className={cn('gap-1 px-1.5 text-[11px]', className)}
      {...props}
    >
      <span>{text}</span>
      <ChevronRight className="size-3.5" />
    </PaginationLink>
  )
}

function PaginationEllipsis({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden
      data-slot="pagination-ellipsis"
      className={cn('flex size-6 items-center justify-center text-dim', className)}
      {...props}
    >
      <MoreHorizontal className="size-3.5" />
      <span className="sr-only">More pages</span>
    </span>
  )
}

export {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis
}
