import { useCallback, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { extractErrorMessage } from '../../lib/errorMessage'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import type { ChangeEvent, FormEvent } from 'react'
import type { ModelConfigInput } from '@shared/model-config/types'
import type { ModelConfigFormProps } from './types'

/** 新建/编辑模型的表单：字段与主进程 model_configs 表一一对应 */
export default function ModelConfigForm({
  initial,
  onSubmit,
  onCancel
}: ModelConfigFormProps): React.JSX.Element {
  const [form, setForm] = useState<ModelConfigInput>(() => ({
    providerName: initial?.providerName ?? '',
    baseUrl: initial?.baseUrl ?? '',
    displayName: initial?.displayName ?? '',
    modelName: initial?.modelName ?? '',
    apiKey: initial?.apiKey ?? ''
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updateField = useCallback(
    (field: keyof ModelConfigInput) =>
      (event: ChangeEvent<HTMLInputElement>): void => {
        const { value } = event.target
        setForm((prev) => ({ ...prev, [field]: value }))
      },
    []
  )

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      if (saving) {
        return
      }
      setSaving(true)
      setError(null)
      try {
        await onSubmit(form)
      } catch (reason) {
        setError(extractErrorMessage(reason))
      } finally {
        setSaving(false)
      }
    },
    [form, onSubmit, saving]
  )

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <Button type="button" variant="ghost" size="sm" className="-ml-2 w-fit" onClick={onCancel}>
        <ArrowLeft />
        返回模型列表
      </Button>
      <Card className="gap-5 py-5">
        <CardHeader>
          <CardTitle className="text-sm">{initial ? '编辑模型' : '添加模型'}</CardTitle>
          <CardDescription className="text-[12px]">
            配置供应商与连接信息，保存后写入本地数据库，仅保存在本机。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor="model-provider-name">供应商名</FieldLabel>
                <Input
                  id="model-provider-name"
                  value={form.providerName}
                  onChange={updateField('providerName')}
                  placeholder="例如 OpenAI"
                  autoComplete="off"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="model-base-url">模型地址</FieldLabel>
                <Input
                  id="model-base-url"
                  value={form.baseUrl}
                  onChange={updateField('baseUrl')}
                  placeholder="https://api.openai.com/v1"
                  autoComplete="off"
                  required
                />
                <FieldDescription>
                  OpenAI 兼容接口的 base URL，调用时会在其后拼接 /chat/completions。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="model-display-name">模型显示名称</FieldLabel>
                <Input
                  id="model-display-name"
                  value={form.displayName}
                  onChange={updateField('displayName')}
                  placeholder="例如 GPT-4o"
                  autoComplete="off"
                  required
                />
                <FieldDescription>展示在模型列表与对话界面中的名称。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="model-name">模型名称</FieldLabel>
                <Input
                  id="model-name"
                  value={form.modelName}
                  onChange={updateField('modelName')}
                  placeholder="例如 gpt-4o"
                  autoComplete="off"
                  required
                />
                <FieldDescription>请求接口时传给 model 参数的值。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="model-api-key">API Key</FieldLabel>
                <Input
                  id="model-api-key"
                  type="password"
                  value={form.apiKey}
                  onChange={updateField('apiKey')}
                  placeholder="sk-…"
                  autoComplete="off"
                />
                <FieldDescription>
                  仅保存在本机数据库中；本地模型不需要鉴权时可留空。
                </FieldDescription>
              </Field>
              {error ? <FieldError>{error}</FieldError> : null}
              <Field orientation="horizontal" className="justify-end">
                <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
                  取消
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? '保存中…' : '保存'}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
