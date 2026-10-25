import { useEffect, useMemo } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'
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

/**
 * 对话历史弹层：以表格展示会话标题（左）与最后活动时间（右）。
 * 点击任意行切换到该会话；点击弹层外部或按 Esc 关闭。
 */
export default function AiSessionHistory({
  sessions,
  activeId,
  onSelect,
  onClose
}: AiSessionHistoryProps): React.JSX.Element {
  // 最近活动的会话排在最前
  const ordered = useMemo(
    () => [...sessions].sort((left, right) => right.updatedAt - left.updatedAt),
    [sessions]
  )

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
          <div className="max-h-[320px] overflow-y-auto">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-7 px-2 text-[11px]">标题</TableHead>
                  <TableHead className="h-7 w-[80px] px-2 text-right text-[11px]">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ordered.map((session) => (
                  <TableRow
                    key={session.id}
                    data-state={session.id === activeId ? 'selected' : undefined}
                    className="cursor-pointer"
                    onClick={() => onSelect(session.id)}
                  >
                    <TableCell className="max-w-0 truncate px-2 py-1.5 text-[12px]">
                      {session.title}
                    </TableCell>
                    <TableCell
                      className="px-2 py-1.5 text-right text-[11px] whitespace-nowrap text-dim"
                      title={formatFullTime(session.updatedAt)}
                    >
                      {formatSessionTime(session.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  )
}
