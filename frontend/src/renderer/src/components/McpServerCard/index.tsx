import { Pencil, PlugZap, RefreshCw, Trash2 } from 'lucide-react'
import type { McpProbeResult, McpServerStatus } from '@shared/mcp/types'
import { Button } from '../ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import type { McpServerCardProps } from './types'

/** 状态对应的文案与颜色：只用主题里已有的令牌，换主题后自动跟随 */
function statusLabel(status: McpServerStatus): { label: string; className: string } {
  switch (status.state) {
    case 'disabled':
      return { label: '已停用', className: 'text-dim' }
    case 'connecting':
      return { label: status.attempt > 0 ? '重新连接中…' : '连接中…', className: 'text-dim' }
    case 'connected':
      return { label: '已连接', className: 'text-link' }
    case 'reconnecting':
      return { label: '重试中', className: 'text-danger' }
    case 'failed':
      return { label: '失败', className: 'text-danger' }
  }
}

/**
 * 状态的一句话说明：把“为什么不是已连接”讲清楚。
 * 失败原因区分放弃重连、重连关闭、配置加载失败与清理未完成四种，用户据此决定是改配置还是重连。
 */
function statusDetail(status: McpServerStatus): string {
  switch (status.state) {
    case 'disabled':
      return '不会建立连接，它的工具不会出现在对话里。'
    case 'connecting':
      return status.attempt > 0 ? `第 ${status.attempt} 次重连中。` : '正在建立连接并同步工具。'
    case 'connected':
      return `已注册 ${status.toolCount} 个工具，连接于 ${formatTime(status.connectedAt)}。`
    case 'reconnecting': {
      const seconds = Math.max(0, Math.round((status.nextRetryAtMs - Date.now()) / 1000))
      return `第 ${status.attempt}/${status.maxAttempts} 次失败，约 ${seconds} 秒后重试。${status.lastError}`
    }
    case 'failed':
      switch (status.reason) {
        case 'gave-up':
          return `连续重连失败已达上限，工具已注销。${status.lastError}`
        case 'reconnect-disabled':
          return `连接失败且未开启自动重连。${status.lastError}`
        case 'load':
          return `配置无法加载。${status.lastError}`
        case 'cleanup':
          return `上次连接的清理未完成，重新加载应用后再试。${status.lastError}`
      }
  }
}

/** epoch 毫秒 → 本地时分秒 */
function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 连接目标的单行摘要：stdio 展示命令与参数，远程展示地址 */
function targetSummary(view: McpServerCardProps['view']): string {
  const { server } = view
  if (server.transport === 'stdio') {
    const joined = [server.command, ...server.args].filter((part) => part.length > 0).join(' ')
    return joined.length > 0 ? joined : '（未填写启动命令）'
  }
  return server.url.length > 0 ? server.url : '（未填写服务地址）'
}

/** 工具名列表：控制在一行内，超出部分用“等 N 个”收束 */
function toolSummary(status: McpServerStatus): string | null {
  if (status.state !== 'connected' || status.tools.length === 0) {
    return null
  }
  const names = status.tools.slice(0, 6).map((tool) => tool.name)
  const rest = status.tools.length - names.length
  return rest > 0 ? `${names.join('、')} 等 ${status.tools.length} 个` : names.join('、')
}

/** 探测结果的一行展示：成功给身份与工具数，失败给阶段与原因 */
function probeSummary(probe: McpProbeResult): { text: string; failed: boolean } {
  if (probe.ok) {
    const identity = probe.serverInfo
      ? `${probe.serverInfo.name} ${probe.serverInfo.version}`
      : '未报告身份'
    const count = probe.truncated
      ? `${probe.toolNames.length}+ 个工具`
      : `${probe.toolNames.length} 个工具`
    return { text: `测试成功：${identity}，${count}（${probe.durationMs}ms）`, failed: false }
  }
  const stage = probe.stage === 'connect' ? '建立连接' : '读取工具列表'
  return { text: `测试失败（${stage}）：${probe.message}`, failed: true }
}

/**
 * 单个 MCP 服务端的卡片：状态、连接目标、工具、操作入口。
 * 与模型卡片一样是纯展示组件：状态由设置页统一保管，操作通过回调上抛。
 */
export default function McpServerCard({
  view,
  probe,
  busy,
  onEdit,
  onDelete,
  onProbe,
  onRestart,
  onToggle
}: McpServerCardProps): React.JSX.Element {
  const { server, status } = view
  const chip = statusLabel(status)
  const tools = toolSummary(status)
  const target = targetSummary(view)
  return (
    <Card className="gap-4 py-4">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2 text-[13px]">
          <span className="truncate" title={server.name}>
            {server.name}
          </span>
          <span className={`shrink-0 text-[11px] font-normal ${chip.className}`}>{chip.label}</span>
          {!server.enabled ? (
            <span className="shrink-0 text-[11px] text-dim">（配置已停用）</span>
          ) : null}
        </CardTitle>
        <CardDescription className="truncate text-[12px]" title={target}>
          {server.transport === 'stdio' ? 'stdio · ' : 'streamable-http · '}
          {target}
        </CardDescription>
        <CardAction className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="编辑配置"
            aria-label={`编辑 ${server.name}`}
            onClick={() => onEdit(server)}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="hover:bg-danger hover:text-accent-fg"
            title="删除配置"
            aria-label={`删除 ${server.name}`}
            disabled={busy.deleting}
            onClick={() => onDelete(server)}
          >
            <Trash2 />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-[12px] leading-[1.6]">
        <div className="flex min-w-0 gap-2">
          <span className="shrink-0 text-dim">状态</span>
          <span className={`min-w-0 break-words ${chip.className}`}>{statusDetail(status)}</span>
        </div>
        {tools !== null ? (
          <div className="flex min-w-0 gap-2">
            <span className="shrink-0 text-dim">工具</span>
            <span className="min-w-0 truncate text-fg" title={tools}>
              {tools}
            </span>
          </div>
        ) : null}
        {probe !== null ? (
          <div
            className={`min-w-0 break-words ${probeSummary(probe).failed ? 'text-danger' : 'text-link'}`}
          >
            {probeSummary(probe).text}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busy.probing}
            onClick={() => onProbe(server)}
          >
            <PlugZap />
            {busy.probing ? '测试中…' : '测试连接'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busy.restarting || !server.enabled}
            onClick={() => onRestart(server)}
          >
            <RefreshCw />
            {busy.restarting ? '重连中…' : '重连'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busy.toggling}
            onClick={() => onToggle(server, !server.enabled)}
          >
            {server.enabled ? '停用' : '启用'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
