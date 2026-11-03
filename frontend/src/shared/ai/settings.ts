/**
 * AI 运行参数：设置页可调，主进程在每轮对话开始时读取一次。
 * 默认值同时给主进程兜底与渲染进程表单初值，避免两处维护两套数字。
 */

/** 一次对话允许的模型调用预算与重复保护 */
export interface AiRuntimeSettings {
  /** 一段工作允许的模型步数；用满后自动续接下一段，不中断任务 */
  maxSteps: number
  /** 一次对话最多自动续接多少段，到顶停止 */
  maxRounds: number
  /** 连续重复调用的提醒次数；空数组表示不提醒 */
  repeatRemindThresholds: number[]
  /** 连续重复到这个次数强制中止本轮 */
  repeatStopThreshold: number
}

/** 默认值：与接入设置前的行为一致 */
export const DEFAULT_AI_RUNTIME_SETTINGS: AiRuntimeSettings = {
  maxSteps: 24,
  maxRounds: 256,
  repeatRemindThresholds: [3, 5, 8],
  repeatStopThreshold: 10
}

/** 表单允许的取值范围：主进程校验收口，界面只做提示 */
export const AI_RUNTIME_LIMITS = {
  maxSteps: { min: 1, max: 200 },
  maxRounds: { min: 1, max: 1000 },
  repeatStopThreshold: { min: 2, max: 50 }
} as const

/** 设置读写通道：数据落在主进程 SQLite 的 app_settings 表 */
export const AI_RUNTIME_CHANNELS = {
  get: 'aiRuntime:get',
  save: 'aiRuntime:save'
} as const

/**
 * 把输入框里的 “3,5,8” 解析成阈值数组。
 * 中文逗号、英文逗号与空白都当分隔符；空串表示不提醒。
 * @returns 去重升序的数组；存在非法项时返回 null
 */
export function parseRemindThresholds(text: string): number[] | null {
  const parts = text
    .split(/[,，\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const values: number[] = []
  for (const part of parts) {
    const value = Number(part)
    if (!Number.isInteger(value) || value < 2) {
      return null
    }
    values.push(value)
  }
  return [...new Set(values)].sort((left, right) => left - right)
}

/** 把阈值数组还原成输入框文本 */
export function formatRemindThresholds(thresholds: readonly number[]): string {
  return thresholds.join(',')
}
