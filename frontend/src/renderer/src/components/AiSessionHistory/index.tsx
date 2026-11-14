import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Download, Minus, Trash2, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'
import { cn } from '../../lib/utils'
import type { AiSessionHistoryProps } from './types'

/** 历史列表的紧凑时间格式：MM-DD HH:mm（完整时间放在 title 里） */
function formatSessionTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatFullTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 批量导出主按钮：与对话框主按钮同一套强调色，保持主题一致 */
const BATCH_EXPORT_CLASS =
  'cursor-pointer rounded-[3px] border border-accent-hover bg-accent-hover px-2 py-0.5 font-[inherit] text-[11px] text-[#fff] transition-opacity hover:opacity-90'

/** 多选框：自绘方块，跟随主题强调色，不依赖原生 checkbox 的默认外观 */
function SelectionBox({
  checked,
  indeterminate = false,
  label,
  onToggle
}: {
  checked: boolean
  indeterminate?: boolean
  label: string
  onToggle: () => void
}): React.JSX.Element {
  const active = checked || indeterminate
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-[2px] border p-0 transition-colors',
        active
          ? 'border-accent-hover bg-accent-hover text-[#fff]'
          : 'border-line bg-transparent text-transparent hover:border-dim'
      )}
      onClick={(event) => {
        // 别让选择冒泡成“打开这一行”
        event.stopPropagation()
        onToggle()
      }}
    >
      {indeterminate ? (
        <Minus className="size-2.5" strokeWidth={3} />
      ) : (
        <Check className="size-2.5" strokeWidth={3} />
      )}
    </button>
  )
}

/**
 * 对话历史弹层：以表格展示会话标题（左）、最后活动时间与导出/删除入口（右）。
 * 点击任意行打开该会话；导出与删除按钮单独点击、不会触发行切换。
 * 每行带复选框，配合表头全选可多选后批量导出。
 */
export default function AiSessionHistory({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onExport,
  onExportMany,
  onClose
}: AiSessionHistoryProps): React.JSX.Element {
  // 最近活动的会话排在最前
  const ordered = useMemo(
    () => [...sessions].sort((left, right) => right.updatedAt - left.updatedAt),
    [sessions]
  )
  // 多选状态：只存 id，已从磁盘删除的会话在统计时自然被过滤掉
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())

  // 实际选中的会话 id（按列表顺序）；历史刷新后失效的 id 不参与统计与导出
  const checkedIds = useMemo(
    () => ordered.filter((session) => selectedIds.has(session.id)).map((session) => session.id),
    [ordered, selectedIds]
  )
  const allSelected = ordered.length > 0 && checkedIds.length === ordered.length

  const toggleOne = useCallback((id: string): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const toggleAll = useCallback((): void => {
    setSelectedIds(allSelected ? new Set() : new Set(ordered.map((session) => session.id)))
  }, [allSelected, ordered])

  const clearSelection = useCallback((): void => setSelectedIds(new Set()), [])

  const handleExportSelected = useCallback((): void => {
    if (checkedIds.length > 0) {
      onExportMany(checkedIds)
    }
  }, [checkedIds, onExportMany])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <>
      {/* 透明遮罩层：拦截并关闭弹层外部的点击 */}
      <div className="fixed inset-0 z-30" aria-hidden="true" onMouseDown={onClose} />
      <div
        className="absolute top-full right-2 left-2 z-40 mt-1 overflow-hidden rounded-md border border-line bg-elevated shadow-[0_4px_16px_rgba(0,0,0,0.45)]"
        role="dialog"
        aria-label="对话历史"
      >
        {ordered.length === 0 ? (
          <p className="m-0 px-3 py-4 text-center text-dim">还没有历史会话</p>
        ) : (
          <>
            {/* 选中后浮现的批量操作条：只对勾选的行生效，不影响点行打开会话 */}
            {checkedIds.length > 0 ? (
              <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-1">
                <span className="text-[11px] text-dim">已选 {checkedIds.length} 项</span>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    className={BATCH_EXPORT_CLASS}
                    onClick={handleExportSelected}
                  >
                    导出选中
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-dim hover:text-fg"
                    title="清除选择"
                    aria-label="清除选择"
                    onClick={clearSelection}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="max-h-[320px] overflow-y-auto">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-7 w-[26px] px-2">
                      {/* 全选：部分选中时显示半选横线 */}
                      <SelectionBox
                        checked={allSelected}
                        indeterminate={!allSelected && checkedIds.length > 0}
                        label={allSelected ? '取消全选' : '全选'}
                        onToggle={toggleAll}
                      />
                    </TableHead>
                    <TableHead className="h-7 px-2 text-[11px]">标题</TableHead>
                    <TableHead className="h-7 w-[80px] px-2 text-right text-[11px]">时间</TableHead>
                    <TableHead className="h-7 w-[58px] px-1" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ordered.map((session) => (
                    <TableRow
                      key={session.id}
                      data-state={
                        selectedIds.has(session.id) || session.id === activeId
                          ? 'selected'
                          : undefined
                      }
                      className="group cursor-pointer"
                      onClick={() => onSelect(session.id)}
                    >
                      <TableCell className="px-2 py-1.5">
                        <SelectionBox
                          checked={selectedIds.has(session.id)}
                          label={`选择会话 ${session.title}`}
                          onToggle={() => toggleOne(session.id)}
                        />
                      </TableCell>
                      <TableCell className="max-w-0 truncate px-2 py-1.5 text-[12px]">
                        {session.title}
                      </TableCell>
                      <TableCell
                        className="px-2 py-1.5 text-right text-[11px] whitespace-nowrap text-dim"
                        title={formatFullTime(session.updatedAt)}
                      >
                        {formatSessionTime(session.updatedAt)}
                      </TableCell>
                      <TableCell className="px-1 py-1">
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            // 默认隐藏，悬停才浮现：列表安静，需要时随手可导出
                            className="text-dim opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
                            title="导出会话文件"
                            aria-label={`导出会话 ${session.title}`}
                            onClick={(event) => {
                              // 别让导出冒泡成“选中这一行”
                              event.stopPropagation()
                              onExport(session.id)
                            }}
                          >
                            <Download className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            // 默认隐藏，悬停才浮现：列表安静，需要时随手可删
                            className="text-dim opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                            title="删除会话"
                            aria-label={`删除会话 ${session.title}`}
                            onClick={(event) => {
                              // 别让删除冒泡成“选中这一行”
                              event.stopPropagation()
                              onDelete(session.id)
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>
    </>
  )
}
