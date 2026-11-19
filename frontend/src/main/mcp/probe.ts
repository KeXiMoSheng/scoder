/**
 * 一次性探测：按配置临时连接、读服务端身份、列工具，然后关闭。
 *
 * 与 deepseek-harness 的 probe.ts 同义：不注册任何工具、不占用服务名的命名空间、
 * 不影响已经在跑的连接。设置面板的「测试连接」用它，因此禁用状态的配置也能测。
 * 预期内的失败返回带阶段的结果而不是抛错：调用方只是要一句话展示结果。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpProbeResult, McpProbeStage, McpServerConfig } from '../../shared/mcp/types'
import { describeError, withDeadline } from './deadline'
import { createMcpTransport } from './transport'

/** 整次探测的默认预算（毫秒）：设置面板需要在一个可接受的时间内给出结论 */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000

/** 翻页上限：游标实现异常的服务端应表现为“已截断”，而不是让界面卡住 */
const PROBE_MAX_PAGES = 16

/** 返回的工具名上限：够看清有哪些工具，又不至于把界面撑爆 */
const PROBE_MAX_TOOL_NAMES = 512

/** 关闭探测连接的预算（毫秒） */
const PROBE_CLOSE_TIMEOUT_MS = 3_000

/** 探测选项 */
export interface McpProbeOptions {
  /** 整次探测预算（含连接与列工具），默认 10 秒 */
  timeoutMs?: number
  /** 最多翻多少页 */
  maxPages?: number
  /** 最多保留多少个工具名 */
  maxToolNames?: number
}

/**
 * 探测一条服务端配置。
 * @param server 已校验的配置（不看 enabled：停用的配置也要能测试）
 * @param options 预算与上限，缺省用固定常量
 * @returns 成功时的服务端身份与工具名，失败时的阶段与原因
 */
export async function probeMcpServer(
  server: McpServerConfig,
  options: McpProbeOptions = {}
): Promise<McpProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const maxPages = options.maxPages ?? PROBE_MAX_PAGES
  const maxToolNames = options.maxToolNames ?? PROBE_MAX_TOOL_NAMES
  const startedAt = Date.now()
  const remaining = (): number => Math.max(1, timeoutMs - (Date.now() - startedAt))
  const client = new Client({ name: 'scoder-mcp-probe', version: '1.0.0' }, { capabilities: {} })
  let stage: McpProbeStage = 'connect'
  let result: McpProbeResult
  try {
    await withDeadline(client.connect(createMcpTransport(server)), remaining(), '连接超时')
    const identity = client.getServerVersion()
    const serverInfo =
      identity === undefined ? undefined : { name: identity.name, version: identity.version }
    stage = 'list'
    const toolNames: string[] = []
    let truncated = false
    let cursor: string | undefined
    if (client.getServerCapabilities()?.tools !== undefined) {
      for (let page = 0; page < maxPages; page += 1) {
        const response = await withDeadline(
          client.listTools(cursor === undefined ? undefined : { cursor }),
          remaining(),
          '读取工具列表超时'
        )
        for (const tool of response.tools) {
          if (toolNames.length >= maxToolNames) {
            truncated = true
            break
          }
          toolNames.push(tool.name)
        }
        cursor = response.nextCursor
        if (cursor === undefined || cursor === '' || truncated) break
        if (page === maxPages - 1) truncated = true
      }
    }
    result = {
      ok: true,
      ...(serverInfo === undefined ? {} : { serverInfo }),
      toolNames,
      truncated,
      durationMs: Date.now() - startedAt
    }
  } catch (error) {
    result = {
      ok: false,
      stage,
      message: describeError(error),
      durationMs: Date.now() - startedAt
    }
  }
  // 探测句柄必须收掉：stdio 的探测会拉起一个子进程，泄漏一次就多一个僵留进程
  try {
    await withDeadline(client.close(), PROBE_CLOSE_TIMEOUT_MS, '关闭探测连接超时')
  } catch (error) {
    if (result.ok) {
      result = {
        ok: false,
        stage: 'list',
        message: `探测成功但关闭连接失败：${describeError(error)}`,
        durationMs: Date.now() - startedAt
      }
    }
  }
  return result
}
