/**
 * 上下文窗口与用量展示共用的常量与纯函数。
 * 用量本身完全来自服务商返回的 usage，这里只放窗口上限与百分比口径。
 */
import { DEFAULT_MODEL_CONTEXT_WINDOW } from '../model-config/types'

/** 上下文窗口缺省上限：模型配置缺失或尚未读取时使用 */
export const DEFAULT_CONTEXT_WINDOW = DEFAULT_MODEL_CONTEXT_WINDOW

/** 窗口档位的紧凑标签：200000 → 200k、1000000 → 1M */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1000) {
    const thousands = tokens / 1000
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`
  }
  return String(tokens)
}

/**
 * 已用上下文占窗口的百分比（0-100 的整数，四舍五入）。
 * 不足 0.5% 时显示 0%，避免小会话看起来已经占用了空间。
 * @param usedTokens 已用 token
 * @param limitTokens 窗口上限
 */
export function contextUsagePercent(usedTokens: number, limitTokens: number): number {
  if (usedTokens <= 0 || limitTokens <= 0) {
    return 0
  }
  return Math.min(100, Math.round((usedTokens / limitTokens) * 100))
}
