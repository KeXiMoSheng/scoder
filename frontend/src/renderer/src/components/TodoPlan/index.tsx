import { CircleCheckIcon, CircleDotIcon, CircleIcon, RouteIcon } from 'lucide-react'
import type { AiMessageView, TodoItem } from '@shared/ai/types'
import { cn } from '../../lib/utils'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle
} from '../ui/trace'

type PlanMessage = Extract<AiMessageView, { kind: 'tool' }>

/**
 * 任务清单的 Trace 展示（替代原先的平铺圆点列表）：
 *
 * 收起时是一行「任务清单 2/5 已完成」，展开后是带左侧竖线的步骤列表；
 * 已完成打勾、进行中圆点、未开始空心圆。最近的清单默认展开，
 * 历史快照保持收起，避免同一份清单在对话里反复铺满屏幕。
 */
export default function TodoPlan({
  message,
  defaultExpanded = false
}: {
  message: PlanMessage
  /** 最近的清单默认展开，历史快照收起 */
  defaultExpanded?: boolean
}): React.JSX.Element | null {
  const todos = message.card?.kind === 'todo' ? (message.card.todos ?? []) : []
  if (todos.length === 0) {
    return null
  }
  const streaming = message.status === 'running' || message.status === 'preparing'
  return <PlanRow todos={todos} streaming={streaming} defaultExpanded={defaultExpanded} />
}

function PlanRow({
  todos,
  streaming,
  defaultExpanded
}: {
  todos: readonly TodoItem[]
  streaming: boolean
  defaultExpanded: boolean
}): React.JSX.Element {
  const done = todos.filter((todo) => todo.status === 'completed').length
  const running = streaming && done < todos.length

  return (
    <div className="mb-1.5 pl-1">
      <Trace>
        <TraceCollapsible defaultExpanded={defaultExpanded}>
          <TraceCollapsibleTrigger>
            <TraceLine status={running ? 'running' : undefined}>
              <TraceIcon>
                <RouteIcon className="size-3.5" />
              </TraceIcon>
              <TraceTitle
                className={cn('truncate text-[13px] text-fg', running && 'tool-row-running-text')}
              >
                任务清单
              </TraceTitle>
              <TraceDescription>
                {done}/{todos.length} 已完成
              </TraceDescription>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <Trace className="gap-1">
              {todos.map((todo) => {
                const stepRunning = streaming && todo.status === 'in_progress'
                return (
                  <TraceLine
                    key={todo.content}
                    status={
                      todo.status === 'pending' ? 'pending' : stepRunning ? 'running' : undefined
                    }
                  >
                    <TraceIcon>
                      {todo.status === 'completed' ? (
                        <CircleCheckIcon className="size-3.5 text-link" />
                      ) : todo.status === 'in_progress' ? (
                        <CircleDotIcon className="size-3.5 text-fg" />
                      ) : (
                        <CircleIcon className="size-3.5 text-dim/60" />
                      )}
                    </TraceIcon>
                    <TraceTitle
                      className={cn(
                        'break-words',
                        todo.status === 'completed' && 'text-dim',
                        todo.status === 'in_progress' && 'text-fg',
                        stepRunning && 'tool-row-running-text'
                      )}
                    >
                      {todo.content}
                    </TraceTitle>
                  </TraceLine>
                )
              })}
            </Trace>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
    </div>
  )
}
