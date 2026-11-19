/**
 * MCP 通道：配置的增删改查、连接操作与状态推送。
 * 配置落在主进程 SQLite，连接由主进程持有；渲染进程只拿投影与状态。
 */
export const MCP_CHANNELS = {
  /** 列出全部服务端配置及其当前状态 */
  list: 'mcp:list',
  create: 'mcp:create',
  update: 'mcp:update',
  /** 删除配置（主进程弹确认框） */
  delete: 'mcp:delete',
  /** 启用/停用一条配置，触发连接挂载或卸载 */
  setEnabled: 'mcp:setEnabled',
  /** 按当前配置临时连接、列出工具后断开，不影响已连接实例 */
  probe: 'mcp:probe',
  /** 重建连接，重置重连预算 */
  restart: 'mcp:restart',
  /** 主进程 → 渲染进程：单个服务端状态变化 */
  status: 'mcp:status'
} as const
