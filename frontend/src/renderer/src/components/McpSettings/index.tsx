import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import type {
  McpProbeResult,
  McpServerConfig,
  McpServerInput,
  McpServerView
} from '@shared/mcp/types'
import { extractErrorMessage } from '../../lib/errorMessage'
import McpServerCard from '../McpServerCard'
import McpServerForm from '../McpServerForm'
import type { McpServerCardBusy } from '../McpServerCard/types'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'
import type { McpEditorState } from './types'

/** 列表加载骨架数量：与默认窗口下可见的卡片列数一致 */
const SKELETON_COUNT = 3

/** 一条服务端当前没有操作在进行 */
const IDLE_BUSY: McpServerCardBusy = {
  probing: false,
  restarting: false,
  toggling: false,
  deleting: false
}

/**
 * MCP 设置分区：服务端列表 + 新建/编辑表单。
 *
 * 数据有两个来源：首次加载走 invoke 拿全量列表；之后主进程按单条服务端推送状态变化，
 * 这里只替换对应那一项，避免每次状态变化都重拉列表。
 */
export default function McpSettings(): React.JSX.Element {
  const [views, setViews] = useState<McpServerView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<McpEditorState>(null)
  /** 每条服务端正在进行的操作，按 id 记录 */
  const [busy, setBusy] = useState<Record<number, McpServerCardBusy>>({})
  /** 最近一次「测试连接」的结果，按 id 记录 */
  const [probes, setProbes] = useState<Record<number, McpProbeResult>>({})

  // 首屏加载：在异步回调里更新状态，避免 effect 内同步触发级联渲染
  useEffect(() => {
    let active = true
    window.api
      .listMcpServers()
      .then((list) => {
        if (active) {
          setViews(list)
        }
      })
      .catch((reason) => {
        if (active) {
          setError(extractErrorMessage(reason))
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [])

  // 状态推送：只更新已存在的服务端；已删除的配置不再出现在列表里
  useEffect(() => {
    return window.api.onMcpServerStatus((view) => {
      setViews((prev) => {
        const index = prev.findIndex((item) => item.server.id === view.server.id)
        if (index < 0) {
          return prev
        }
        const next = [...prev]
        next[index] = view
        return next
      })
    })
  }, [])

  /** 更新单条服务端的忙碌标记 */
  const setBusyOf = useCallback((id: number, patch: Partial<McpServerCardBusy>): void => {
    setBusy((prev) => ({ ...prev, [id]: { ...(prev[id] ?? IDLE_BUSY), ...patch } }))
  }, [])

  /** 加载失败后的重试入口 */
  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setViews(await window.api.listMcpServers())
    } catch (reason) {
      setError(extractErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  /** 保存表单：出错时抛出，由表单展示具体原因 */
  const handleSubmit = useCallback(
    async (input: McpServerInput): Promise<void> => {
      if (editor?.mode === 'edit') {
        const saved = await window.api.updateMcpServer(editor.server.id, input)
        setViews((prev) =>
          prev.map((item) =>
            item.server.id === saved.id ? { server: saved, status: item.status } : item
          )
        )
      } else {
        const created = await window.api.createMcpServer(input)
        // 保存后停用的配置直接显示为已停用，避免先闪一下「连接中」
        setViews((prev) => [
          ...prev,
          {
            server: created,
            status: created.enabled ? { state: 'connecting', attempt: 0 } : { state: 'disabled' }
          }
        ])
      }
      setEditor(null)
      setError(null)
    },
    [editor]
  )

  const handleDelete = useCallback(
    async (server: McpServerConfig): Promise<void> => {
      setBusyOf(server.id, { deleting: true })
      try {
        if (await window.api.deleteMcpServer(server.id)) {
          setViews((prev) => prev.filter((item) => item.server.id !== server.id))
          setProbes((prev) => {
            const next = { ...prev }
            delete next[server.id]
            return next
          })
        }
      } catch (reason) {
        setError(extractErrorMessage(reason))
      } finally {
        setBusyOf(server.id, { deleting: false })
      }
    },
    [setBusyOf]
  )

  const handleProbe = useCallback(
    async (server: McpServerConfig): Promise<void> => {
      setBusyOf(server.id, { probing: true })
      setError(null)
      try {
        const result = await window.api.probeMcpServer(server.id)
        setProbes((prev) => ({ ...prev, [server.id]: result }))
      } catch (reason) {
        setError(extractErrorMessage(reason))
      } finally {
        setBusyOf(server.id, { probing: false })
      }
    },
    [setBusyOf]
  )

  const handleRestart = useCallback(
    async (server: McpServerConfig): Promise<void> => {
      setBusyOf(server.id, { restarting: true })
      setError(null)
      try {
        await window.api.restartMcpServer(server.id)
      } catch (reason) {
        setError(extractErrorMessage(reason))
      } finally {
        setBusyOf(server.id, { restarting: false })
      }
    },
    [setBusyOf]
  )

  const handleToggle = useCallback(
    async (server: McpServerConfig, enabled: boolean): Promise<void> => {
      setBusyOf(server.id, { toggling: true })
      setError(null)
      try {
        const saved = await window.api.setMcpServerEnabled(server.id, enabled)
        setViews((prev) =>
          prev.map((item) =>
            item.server.id === saved.id
              ? {
                  server: saved,
                  status: enabled ? { state: 'connecting', attempt: 0 } : { state: 'disabled' }
                }
              : item
          )
        )
      } catch (reason) {
        setError(extractErrorMessage(reason))
      } finally {
        setBusyOf(server.id, { toggling: false })
      }
    },
    [setBusyOf]
  )

  /** 列表里各服务端的连接目标摘要，供空态判断之外的统计使用 */
  const connectedCount = useMemo(
    () => views.filter((item) => item.status.state === 'connected').length,
    [views]
  )

  if (editor !== null) {
    return (
      <McpServerForm
        key={editor.mode === 'edit' ? editor.server.id : 'create'}
        initial={editor.mode === 'edit' ? editor.server : null}
        onSubmit={handleSubmit}
        onCancel={() => setEditor(null)}
      />
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-fg">MCP 服务</h1>
          <p className="mt-1 leading-[1.6] text-dim">
            连接 Model Context Protocol 服务端，把它们的工具交给 AI 使用；工具名形如
            mcp__服务名__工具名，只在本机配置与运行。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" onClick={() => setEditor({ mode: 'create' })}>
            <Plus />
            添加服务
          </Button>
        </div>
      </div>

      {error !== null ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md border border-danger/40 px-3 py-2 text-[12px] leading-[1.6] text-danger"
        >
          <span className="min-w-0 break-words">{error}</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => setError(null)}>
            知道了
          </Button>
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: SKELETON_COUNT }, (_, index) => (
            <Skeleton key={index} className="h-44 w-full rounded-xl" />
          ))}
        </div>
      ) : views.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-line px-6 py-10">
          <p className="text-sm text-fg">还没有配置 MCP 服务</p>
          <p className="max-w-2xl text-[12px] leading-[1.6] text-dim">
            添加一个服务端后，AI 会多出一批 mcp__ 前缀的工具。stdio 适合本机进程（例如 npx
            @modelcontextprotocol/server-filesystem），streamable-http 适合已经跑起来的远程端点。
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" onClick={() => setEditor({ mode: 'create' })}>
              <Plus />
              添加服务
            </Button>
            <Button type="button" variant="outline" onClick={() => void reload()}>
              重新加载
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="text-[12px] text-dim">
            共 {views.length} 个服务端，已连接 {connectedCount} 个。
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {views.map((view) => (
              <McpServerCard
                key={view.server.id}
                view={view}
                probe={probes[view.server.id] ?? null}
                busy={busy[view.server.id] ?? IDLE_BUSY}
                onEdit={(server) => setEditor({ mode: 'edit', server })}
                onDelete={(server) => void handleDelete(server)}
                onProbe={(server) => void handleProbe(server)}
                onRestart={(server) => void handleRestart(server)}
                onToggle={(server, enabled) => void handleToggle(server, enabled)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
