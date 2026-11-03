/**
 * 重复调用守卫：连续以完全相同的参数调用同一个工具时逐级提醒，最后一档直接叫停。
 *
 * 判定前先把参数按键名递归排序：字段顺序不同但内容相同的两次调用算同一次，
 * 否则模型只要换个 JSON 字段顺序就能绕过检测。
 * 计数只在连续时累加，中间插入别的调用就重新开始；
 * 每一轮用户输入都新建一个守卫实例，因此计数天然按轮重置。
 */

import { DEFAULT_AI_RUNTIME_SETTINGS } from '../../../shared/ai/settings'

/** 详细提醒里参数预览的最大字符数，避免大段文件内容被反复带进上下文 */
const ARGUMENTS_PREVIEW_CHARS = 500

/** 守卫配置：来自设置页，每轮对话开始时读取一次 */
export interface RepeatGuardConfig {
  /** 触发提醒的连续次数；空数组表示只在中止阈值处停 */
  thresholds: readonly number[]
  /** 连续重复到这个次数强制中止本轮 */
  stopThreshold: number
}

/** 守卫对一次即将执行的调用的判定 */
export type RepeatAction =
  | { kind: 'allow' }
  /** 照常执行，执行完把提醒追加进消息序列 */
  | { kind: 'remind'; text: string }
  /** 不再执行，以失败结果收尾并中止本轮 */
  | { kind: 'stop'; text: string }

/**
 * 跨步骤累计的重复调用检测器。
 * 一个实例只服务一轮对话：轮次结束时随实例一起丢弃，不需要显式复位。
 */
export class RepeatCallGuard {
  /** 清洗后的提醒档位：只保留合法且小于中止阈值的次数 */
  private readonly thresholds: readonly number[]
  /** 清洗后的中止阈值 */
  private readonly stopThreshold: number
  /** 上一次调用（工具名 + 规范化参数）的键；null 表示这是第一次调用 */
  private lastKey: string | null = null
  private count = 0

  constructor(config: RepeatGuardConfig) {
    // 设置页已经校验过，这里再挡一次越界值：脏配置不能改变循环的可终止性
    const stop =
      Number.isInteger(config.stopThreshold) && config.stopThreshold >= 2
        ? config.stopThreshold
        : DEFAULT_AI_RUNTIME_SETTINGS.repeatStopThreshold
    this.stopThreshold = stop
    this.thresholds = [...new Set(config.thresholds)]
      .filter((value) => Number.isInteger(value) && value >= 2 && value < stop)
      .sort((left, right) => left - right)
  }

  /**
   * 记录一次即将执行的调用，返回本次应触发的动作。
   * @param name 工具名
   * @param rawArguments 模型给出的原始参数 JSON
   */
  observe(name: string, rawArguments: string): RepeatAction {
    const canonical = canonicalArguments(rawArguments)
    const key = `${name}\u0000${canonical}`
    this.count = this.lastKey === key ? this.count + 1 : 1
    this.lastKey = key

    if (this.count >= this.stopThreshold) {
      return {
        kind: 'stop',
        text:
          `工具「${name}」已连续 ${this.count} 次以完全相同的参数调用，判定为原地打转，本轮对话已中止。` +
          '请检查上一步的结果，换一种做法后再继续。'
      }
    }
    if (!this.thresholds.includes(this.count)) {
      return { kind: 'allow' }
    }
    return {
      kind: 'remind',
      text:
        this.count === this.thresholds[0]
          ? gentleReminder(name)
          : detailedReminder(
              name,
              this.count,
              previewArguments(canonical),
              this.count === this.thresholds[this.thresholds.length - 1],
              this.stopThreshold
            )
    }
  }
}

/** 第一次提醒：只讲道理，不点名具体参数 */
function gentleReminder(name: string): string {
  return (
    `你正在用完全相同的参数重复调用工具「${name}」。再次调用前先仔细查看上一次的结果：` +
    '如果任务还没完成，换一种做法或换一组参数，不要重复同样的调用。'
  )
}

/** 后续档位：把工具、次数和参数摆出来，明确要求换路；最后一档提前告知后果 */
function detailedReminder(
  name: string,
  count: number,
  canonical: string,
  lastChance: boolean,
  stopThreshold: number
): string {
  return (
    '检测到重复调用：\n' +
    `- 工具：${name}\n` +
    `- 连续次数：${count}\n` +
    `- 参数：${canonical}\n` +
    '这些调用没有带来任何进展。不要再用这组参数调用这个工具：' +
    '查看最近一次的结果，选择不同的动作、不同的参数，或者在信息已经足够时结束任务。' +
    (lastChance ? `\n再重复一次（第 ${stopThreshold} 次）将强制中止本轮对话。` : '')
  )
}

/**
 * 参数规范化：解析后按键名递归排序再序列化。
 * 解析失败时退回原始文本，至少不会把两组不同的坏参数误判成同一次调用。
 */
function canonicalArguments(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return '{}'
  }
  try {
    return JSON.stringify(sortValue(JSON.parse(trimmed))) ?? trimmed
  } catch {
    return trimmed
  }
}

/** 递归把对象键按字典序排列；数组保持原顺序（顺序本身有语义） */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key])
    }
    return sorted
  }
  return value
}

/** 截断参数预览，并注明省略了多少字符 */
function previewArguments(canonical: string): string {
  if (canonical.length <= ARGUMENTS_PREVIEW_CHARS) {
    return canonical
  }
  return `${canonical.slice(0, ARGUMENTS_PREVIEW_CHARS)}…（还有 ${canonical.length - ARGUMENTS_PREVIEW_CHARS} 个字符）`
}
