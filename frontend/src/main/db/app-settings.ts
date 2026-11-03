import {
  AI_RUNTIME_LIMITS,
  DEFAULT_AI_RUNTIME_SETTINGS,
  type AiRuntimeSettings
} from '../../shared/ai/settings'
import { requireDatabase } from './connection'
import { DbError } from './errors'

/** 设置表里的键：一个键存一份完整 JSON，新增字段时靠默认值合并 */
const AI_RUNTIME_KEY = 'ai.runtime'

/**
 * 读取 AI 运行参数。
 * 没存过、内容损坏或字段越界时一律回退默认值：
 * 设置存储坏了不该让对话功能起不来。
 */
export function getAiRuntimeSettings(): AiRuntimeSettings {
  const row = requireDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(AI_RUNTIME_KEY) as { value: string } | undefined
  if (!row) {
    return cloneDefaults()
  }
  try {
    return coerceSettings(JSON.parse(row.value))
  } catch (error) {
    console.warn('AI 运行设置无法解析，已使用默认值', error)
    return cloneDefaults()
  }
}

/**
 * 保存 AI 运行参数。
 * 校验不通过时整份拒绝，不做部分写入，避免出现“改了一半”的配置。
 * @throws DbError 任一字段非法
 */
export function saveAiRuntimeSettings(input: AiRuntimeSettings): AiRuntimeSettings {
  const settings = requireSettings(input)
  requireDatabase()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .run(AI_RUNTIME_KEY, JSON.stringify(settings))
  return settings
}

/** 默认值的深拷贝：数组字段不能被调用方改到常量上 */
function cloneDefaults(): AiRuntimeSettings {
  return {
    ...DEFAULT_AI_RUNTIME_SETTINGS,
    repeatRemindThresholds: [...DEFAULT_AI_RUNTIME_SETTINGS.repeatRemindThresholds]
  }
}

/** 读盘用的宽松解析：逐字段过滤，非法项回退默认值 */
function coerceSettings(input: unknown): AiRuntimeSettings {
  const defaults = cloneDefaults()
  if (!input || typeof input !== 'object') {
    return defaults
  }
  const record = input as Record<string, unknown>
  const stop = clampInteger(
    record.repeatStopThreshold,
    AI_RUNTIME_LIMITS.repeatStopThreshold,
    defaults.repeatStopThreshold
  )
  return {
    maxSteps: clampInteger(record.maxSteps, AI_RUNTIME_LIMITS.maxSteps, defaults.maxSteps),
    maxRounds: clampInteger(record.maxRounds, AI_RUNTIME_LIMITS.maxRounds, defaults.maxRounds),
    repeatRemindThresholds: Array.isArray(record.repeatRemindThresholds)
      ? sanitizeThresholds(record.repeatRemindThresholds, stop)
      : [...defaults.repeatRemindThresholds],
    repeatStopThreshold: stop
  }
}

/** 当前值合法就保留，否则用默认值 */
function clampInteger(
  value: unknown,
  range: { readonly min: number; readonly max: number },
  fallback: number
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= range.min &&
    value <= range.max
    ? value
    : fallback
}

/** 只保留“大于等于 2 且小于中止次数”的项，去重升序 */
function sanitizeThresholds(values: unknown[], stop: number): number[] {
  const kept = values.filter(
    (value): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= 2 && value < stop
  )
  return [...new Set(kept)].sort((left, right) => left - right)
}

/** 保存用的严格校验：全部字段必须合法，否则整份拒绝 */
function requireSettings(input: unknown): AiRuntimeSettings {
  if (!input || typeof input !== 'object') {
    throw new DbError('AI 运行设置无效', 'INVALID_ARGUMENT')
  }
  const record = input as Record<string, unknown>
  const maxSteps = requireInteger(record.maxSteps, '每段步数', AI_RUNTIME_LIMITS.maxSteps)
  const maxRounds = requireInteger(record.maxRounds, '最多续接段数', AI_RUNTIME_LIMITS.maxRounds)
  const stop = requireInteger(
    record.repeatStopThreshold,
    '重复中止次数',
    AI_RUNTIME_LIMITS.repeatStopThreshold
  )
  const rawThresholds = record.repeatRemindThresholds
  if (!Array.isArray(rawThresholds)) {
    throw new DbError('重复提醒次数必须是数组', 'INVALID_ARGUMENT')
  }
  if (rawThresholds.length > 8) {
    throw new DbError('重复提醒次数最多 8 个', 'INVALID_ARGUMENT')
  }
  const thresholds: number[] = []
  for (const value of rawThresholds) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 2) {
      throw new DbError('重复提醒次数必须是不小于 2 的整数', 'INVALID_ARGUMENT')
    }
    if (value >= stop) {
      throw new DbError(`重复提醒次数必须小于中止次数 ${stop}`, 'INVALID_ARGUMENT')
    }
    thresholds.push(value)
  }
  return {
    maxSteps,
    maxRounds,
    repeatRemindThresholds: [...new Set(thresholds)].sort((left, right) => left - right),
    repeatStopThreshold: stop
  }
}

/** 必填整数 + 范围校验 */
function requireInteger(
  value: unknown,
  label: string,
  range: { readonly min: number; readonly max: number }
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < range.min ||
    value > range.max
  ) {
    throw new DbError(`${label}必须是 ${range.min} 到 ${range.max} 之间的整数`, 'INVALID_ARGUMENT')
  }
  return value
}
