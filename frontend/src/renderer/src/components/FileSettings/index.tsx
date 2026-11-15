import { useCallback, useEffect, useState } from 'react'
import { extractErrorMessage } from '../../lib/errorMessage'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Skeleton } from '../ui/skeleton'
import { DEFAULT_FILE_SETTINGS, FILE_SETTINGS_LIMITS } from '@shared/files/settings'
import type { FileSettings as FileSettingsValue } from '@shared/files/settings'
import type { ChangeEvent, FormEvent } from 'react'

/** 表单状态：数字用字符串保存，避免输入框清空时被强制拉回默认值 */
interface FormState {
  maxEditorFileMegabytes: string
}

/** 设置 → 表单 */
function toForm(settings: FileSettingsValue): FormState {
  return { maxEditorFileMegabytes: String(settings.maxEditorFileMegabytes) }
}

/** 表单 → 设置；字段非法时返回可直接展示的错误消息 */
function parseForm(form: FormState): FileSettingsValue | string {
  const min = FILE_SETTINGS_LIMITS.maxEditorFileMegabytes.min
  const value = Number(form.maxEditorFileMegabytes.trim())
  if (!Number.isSafeInteger(value) || value < min) {
    return `文件大小上限必须是不小于 ${min} 的整数`
  }
  return { maxEditorFileMegabytes: value }
}

/** 编辑器设置分区：控制编辑器打开文本文件时的体积上限，保存后对新打开的文件生效 */
export default function FileSettings(): React.JSX.Element {
  const [form, setForm] = useState<FormState>(() => toForm(DEFAULT_FILE_SETTINGS))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // 首屏加载：在异步回调里更新状态，避免 effect 内同步触发级联渲染
  useEffect(() => {
    let active = true
    window.api
      .getFileSettings()
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

  const updateField = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const { value } = event.target
    setSaved(false)
    setForm({ maxEditorFileMegabytes: value })
  }, [])

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
        const applied = await window.api.saveFileSettings(parsed)
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
    setForm(toForm(DEFAULT_FILE_SETTINGS))
    setSaved(false)
    setError(null)
  }, [])

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">编辑器</h1>
        <p className="mt-1 leading-[1.6] text-dim">
          控制编辑器打开普通文本文件的体积上限。超过上限的文件不读取，可以在打开提示里选择继续打开，或回到这里调整；保存后对下次打开生效。
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
            <CardTitle className="text-sm">文件大小</CardTitle>
            <CardDescription className="text-[12px]">
              超过上限的文件不会在编辑器中读取；打开提示里可以临时继续打开，或跳转到此处调整。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor="file-max-editor-size">最大文件大小（MB）</FieldLabel>
                <Input
                  id="file-max-editor-size"
                  type="number"
                  min={FILE_SETTINGS_LIMITS.maxEditorFileMegabytes.min}
                  value={form.maxEditorFileMegabytes}
                  onChange={updateField}
                  required
                />
                <FieldDescription>
                  默认 {DEFAULT_FILE_SETTINGS.maxEditorFileMegabytes} MB，可设置不小于{' '}
                  {FILE_SETTINGS_LIMITS.maxEditorFileMegabytes.min} MB
                  的整数。该限制只作用于普通文本文件，不影响二进制预览。
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
