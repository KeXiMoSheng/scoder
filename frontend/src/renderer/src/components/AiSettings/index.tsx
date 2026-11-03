import { useCallback, useEffect, useState } from 'react'
import { extractErrorMessage } from '../../lib/errorMessage'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Skeleton } from '../ui/skeleton'
import {
  AI_RUNTIME_LIMITS,
  DEFAULT_AI_RUNTIME_SETTINGS,
  formatRemindThresholds,
  parseRemindThresholds
} from '@shared/ai/settings'
import type { AiRuntimeSettings } from '@shared/ai/settings'
import type { ChangeEvent, FormEvent } from 'react'

/** 表单状态：数字也用字符串保存，避免输入框清空时被强制拉回 0 */
interface FormState {
  maxSteps: string
  maxRounds: string
  repeatRemindThresholds: string
  repeatStopThreshold: string
}

/** 设置 → 表单 */
function toForm(settings: AiRuntimeSettings): FormState {
  return {
    maxSteps: String(settings.maxSteps),
    maxRounds: String(settings.maxRounds),
    repeatRemindThresholds: formatRemindThresholds(settings.repeatRemindThresholds),
    repeatStopThreshold: String(settings.repeatStopThreshold)
  }
}

/** 表单 → 设置；任一字段非法时返回可直接展示的错误消息 */
function parseForm(form: FormState): AiRuntimeSettings | string {
  const maxSteps = parseInteger(form.maxSteps, '每段步数', AI_RUNTIME_LIMITS.maxSteps)
  if (typeof maxSteps === 'string') {
    return maxSteps
  }
  const maxRounds = parseInteger(form.maxRounds, '最多续接段数', AI_RUNTIME_LIMITS.maxRounds)
  if (typeof maxRounds === 'string') {
    return maxRounds
  }
  const stop = parseInteger(
    form.repeatStopThreshold,
    '重复中止次数',
    AI_RUNTIME_LIMITS.repeatStopThreshold
  )
  if (typeof stop === 'string') {
    return stop
  }
  const thresholds = parseRemindThresholds(form.repeatRemindThresholds)
  if (thresholds === null) {
    return '重复提醒次数必须是逗号分隔的整数，且每个都不小于 2'
  }
  if (thresholds.length > 8) {
    return '重复提醒次数最多 8 个'
  }
  if (thresholds.some((value) => value >= stop)) {
    return `重复提醒次数必须小于中止次数 ${stop}`
  }
  return {
    maxSteps,
    maxRounds,
    repeatRemindThresholds: thresholds,
    repeatStopThreshold: stop
  }
}

/** 解析整数并检查范围；失败时返回错误消息 */
function parseInteger(
  text: string,
  label: string,
  range: { readonly min: number; readonly max: number }
): number | string {
  const value = Number(text.trim())
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    return `${label}必须是 ${range.min} 到 ${range.max} 之间的整数`
  }
  return value
}

/** AI 设置分区：执行预算与重复调用保护，保存后从下一条消息开始生效 */
export default function AiSettings(): React.JSX.Element {
  const [form, setForm] = useState<FormState>(() => toForm(DEFAULT_AI_RUNTIME_SETTINGS))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // 首屏加载：在异步回调里更新状态，避免 effect 内同步触发级联渲染
  useEffect(() => {
    let active = true
    window.api
      .getAiRuntimeSettings()
      .then((settings) => {
        if (active) {
          setForm(toForm(settings))
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

  const updateField = useCallback(
    (field: keyof FormState) =>
      (event: ChangeEvent<HTMLInputElement>): void => {
        const { value } = event.target
        setSaved(false)
        setForm((previous) => ({ ...previous, [field]: value }))
      },
    []
  )

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      if (saving) {
        return
      }
      const parsed = parseForm(form)
      if (typeof parsed === 'string') {
        setSaved(false)
        setError(parsed)
        return
      }
      setSaving(true)
      setError(null)
      try {
        // 主进程会再校验一遍，落库后的值才是最终值
        const applied = await window.api.saveAiRuntimeSettings(parsed)
        setForm(toForm(applied))
        setSaved(true)
      } catch (reason) {
        setError(extractErrorMessage(reason))
      } finally {
        setSaving(false)
      }
    },
    [form, saving]
  )

  const resetDefaults = useCallback((): void => {
    setForm(toForm(DEFAULT_AI_RUNTIME_SETTINGS))
    setSaved(false)
    setError(null)
  }, [])

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">AI 助手</h1>
        <p className="mt-1 leading-[1.6] text-dim">
          控制单次对话的执行预算与重复调用保护。保存后从下一条消息开始生效。
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 leading-[1.6] text-danger">
          {error}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <Card className="gap-5 py-5">
          <CardHeader>
            <CardTitle className="text-sm">执行预算</CardTitle>
            <CardDescription className="text-[12px]">
              长任务不会被步数上限掐断：一段预算用尽后自动续接，直到任务完成或达到段数上限。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor="ai-max-steps">每段步数</FieldLabel>
                <Input
                  id="ai-max-steps"
                  type="number"
                  min={AI_RUNTIME_LIMITS.maxSteps.min}
                  max={AI_RUNTIME_LIMITS.maxSteps.max}
                  value={form.maxSteps}
                  onChange={updateField('maxSteps')}
                  required
                />
                <FieldDescription>
                  一段工作最多调用模型多少次。用满后不会报错，而是注入续接指令接着干。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="ai-max-rounds">最多续接段数</FieldLabel>
                <Input
                  id="ai-max-rounds"
                  type="number"
                  min={AI_RUNTIME_LIMITS.maxRounds.min}
                  max={AI_RUNTIME_LIMITS.maxRounds.max}
                  value={form.maxRounds}
                  onChange={updateField('maxRounds')}
                  required
                />
                <FieldDescription>
                  一次对话最多自动续接多少段，到顶停止。总调用上限约为“每段步数 × 段数”。
                </FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card className="gap-5 py-5">
          <CardHeader>
            <CardTitle className="text-sm">重复调用保护</CardTitle>
            <CardDescription className="text-[12px]">
              模型连续以完全相同的参数调用同一个工具时逐级提醒，最后一档强制中止。
              参数比较前会按键名排序，字段顺序不同不影响判定。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor="ai-repeat-thresholds">提醒次数</FieldLabel>
                <Input
                  id="ai-repeat-thresholds"
                  value={form.repeatRemindThresholds}
                  onChange={updateField('repeatRemindThresholds')}
                  placeholder="例如 3,5,8"
                  autoComplete="off"
                />
                <FieldDescription>
                  用逗号分隔的连续次数，到达时给出提醒；留空表示只在中止次数处停。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="ai-repeat-stop">中止次数</FieldLabel>
                <Input
                  id="ai-repeat-stop"
                  type="number"
                  min={AI_RUNTIME_LIMITS.repeatStopThreshold.min}
                  max={AI_RUNTIME_LIMITS.repeatStopThreshold.max}
                  value={form.repeatStopThreshold}
                  onChange={updateField('repeatStopThreshold')}
                  required
                />
                <FieldDescription>
                  连续重复到这个次数就不再执行该调用，并中止本轮对话。
                </FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
          <Button type="button" variant="outline" onClick={resetDefaults} disabled={saving}>
            恢复默认
          </Button>
          {saved ? <span className="text-xs text-dim">已保存</span> : null}
        </div>
      </form>
    </div>
  )
}
