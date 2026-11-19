import { BrowserWindow, dialog, ipcMain } from 'electron'
import { MCP_CHANNELS } from '../../shared/mcp/events'
import type {
  McpProbeResult,
  McpServerConfig,
  McpServerInput,
  McpServerView
} from '../../shared/mcp/types'
import {
  createMcpServer,
  deleteMcpServer,
  findMcpServer,
  setMcpServerEnabled,
  updateMcpServer
} from '../db'
import { mcpManager } from './manager'

/**
 * 注册 MCP 相关通道。
 * 这一层只做三件事：接收参数、处理需要窗口的交互（确认框）、把落库后的配置
 * 交给管理器重新对齐；校验在仓储层，连接与工具在管理器与连接层。
 */
export function registerMcpHandlers(): void {
  ipcMain.handle(MCP_CHANNELS.list, (): McpServerView[] => mcpManager.list())

  ipcMain.handle(
    MCP_CHANNELS.create,
    async (_event, input: McpServerInput): Promise<McpServerConfig> => {
      const created = createMcpServer(input)
      await mcpManager.refresh()
      return created
    }
  )

  ipcMain.handle(
    MCP_CHANNELS.update,
    async (_event, id: number, input: McpServerInput): Promise<McpServerConfig> => {
      const updated = updateMcpServer(id, input)
      await mcpManager.refresh()
      return updated
    }
  )

  ipcMain.handle(MCP_CHANNELS.delete, async (event, id: number): Promise<boolean> => {
    const server = findMcpServer(id)
    if (server === null) {
      return false
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      type: 'warning' as const,
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
      title: '删除 MCP 服务端',
      message: `确定要删除 MCP 服务端「${server.name}」吗？`,
      detail: '删除后会立即断开连接并注销它提供的工具；本机配置文件不可恢复。'
    }
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
    if (result.response !== 1) {
      return false
    }
    const deleted = deleteMcpServer(id)
    await mcpManager.refresh()
    return deleted
  })

  ipcMain.handle(
    MCP_CHANNELS.setEnabled,
    async (_event, id: number, enabled: boolean): Promise<McpServerConfig> => {
      const saved = setMcpServerEnabled(id, enabled)
      await mcpManager.refresh()
      return saved
    }
  )

  ipcMain.handle(MCP_CHANNELS.probe, (_event, id: number): Promise<McpProbeResult> => {
    return mcpManager.probe(id)
  })

  ipcMain.handle(MCP_CHANNELS.restart, async (_event, id: number): Promise<void> => {
    await mcpManager.restart(id)
  })

  // 状态推送：设置面板可能开着多个窗口，逐个推送；关闭中的窗口跳过
  mcpManager.onChange((view) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send(MCP_CHANNELS.status, view)
    }
  })
}
