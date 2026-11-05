import { useCallback, useState } from 'react'
import { Download, Eye, EyeOff } from 'lucide-react'
import { extractErrorMessage } from '../../lib/errorMessage'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import type { ChangeEvent, FormEvent } from 'react'
import type {
  ModelConfigInput,
  ModelImportResult,
  RemoteModelListRequest
} from '@shared/model-config/types'
import type { ModelImportProps } from './types'

/** 一键导入模型：粘贴地址与 Authorization，拉取列表后按 id/name/owned_by 批量建配置 */
export default function ModelImport({ onOpenModels }: ModelImportProps): React.JSX.Element {
  const [form, setForm] = useState<RemoteModelListRequest>({
    baseUrl: '',
    modelsUrl: '',
    authorization: ''
  })
  const [authorizationVisible, setAuthorizationVisible] = useState(false)
  const [candidates, setCandidates] = useState<ModelConfigInput[]>([])
  const [fetching, setFetching] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [imported, setImported] = useState<ModelImportResult | null>(null)

  const updateField = useCallback(
    (field: keyof RemoteModelListRequest) =>
      (event: ChangeEvent<HTMLInputElement>): void => {
        const { value } = event.target
        // 改了连接信息后旧列表就失效了，清掉避免拿错地址的数据去导入
        setCandidates([])
        setImported(null)
        setForm((prev) => ({ ...prev, [field]: value }))
      },
    []
  )

  const handleFetch = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      if (fetching) {
        return
      }
      setFetching(true)
      setError(null)
      setImported(null)
      try {
        setCandidates(await window.api.fetchRemoteModels(form))
      } catch (reason) {
        setCandidates([])
        setError(extractErrorMessage(reason))
      } finally {
        setFetching(false)
      }
    },
    [fetching, form]
  )

  const handleImport = useCallback(async (): Promise<void> => {
    if (importing || candidates.length === 0) {
      return
    }
    setImporting(true)
    setError(null)
    try {
      setImported(await window.api.importModelConfigs(candidates))
      setCandidates([])
    } catch (reason) {
      setError(extractErrorMessage(reason))
    } finally {
      setImporting(false)
    }
  }, [candidates, importing])

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">一键导入模型</h1>
        <p className="mt-1 leading-[1.6] text-dim">
          填写模型服务地址与列表地址，拉取后自动生成模型配置：模型名称取 id、显示名称取
          name、供应商取 owned_by，API Key 取 Authorization 中 Bearer 之后的部分。
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 leading-[1.6] text-danger">
          {error}
        </div>
      ) : null}

      {imported ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-selection/40 px-3 py-2 leading-[1.6]">
          <span className="min-w-0 flex-1">
            已导入 {imported.created.length} 个模型
            {imported.skipped > 0 ? `，跳过 ${imported.skipped} 个已存在的配置` : ''}。
          </span>
          <Button type="button" variant="outline" size="sm" onClick={onOpenModels}>
            查看模型列表
          </Button>
        </div>
      ) : null}

      <Card className="gap-5 py-5">
        <CardHeader>
          <CardTitle className="text-sm">连接信息</CardTitle>
          <CardDescription className="text-[12px]">
            请求由主进程发起，凭据只保存在本机数据库，不会写入页面请求日志。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleFetch}>
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor="import-base-url">模型请求地址</FieldLabel>
                <Input
                  id="import-base-url"
                  value={form.baseUrl}
                  onChange={updateField('baseUrl')}
                  placeholder="https://api.example.com/v1"
                  autoComplete="off"
                  required
                />
                <FieldDescription>
                  导入后写入每条模型的「模型地址」，调用时在其后拼接 /chat/completions。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="import-models-url">模型列表地址</FieldLabel>
                <Input
                  id="import-models-url"
                  value={form.modelsUrl}
                  onChange={updateField('modelsUrl')}
                  placeholder="https://api.example.com/v1/models"
                  autoComplete="off"
                  required
                />
                <FieldDescription>
                  返回 OpenAI 兼容的模型列表：支持 data 数组与直接返回数组两种结构。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="import-authorization">Authorization</FieldLabel>
                <div className="relative">
                  <Input
                    id="import-authorization"
                    type={authorizationVisible ? 'text' : 'password'}
                    value={form.authorization}
                    onChange={updateField('authorization')}
                    placeholder="Bearer sk-…"
                    autoComplete="off"
                    className="pr-9"
                    required
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="absolute top-1/2 right-1 -translate-y-1/2 text-dim hover:text-fg"
                    title={authorizationVisible ? '隐藏 Authorization' : '显示 Authorization'}
                    aria-label={authorizationVisible ? '隐藏 Authorization' : '显示 Authorization'}
                    aria-pressed={authorizationVisible}
                    onClick={() => setAuthorizationVisible((prev) => !prev)}
                  >
                    {authorizationVisible ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                <FieldDescription>
                  整段粘贴请求头即可（如 Bearer sk-…）；只填密钥时会自动补上 Bearer 前缀。
                </FieldDescription>
              </Field>
              <Field orientation="horizontal" className="justify-end">
                <Button type="submit" disabled={fetching}>
                  {fetching ? '拉取中…' : '拉取模型列表'}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      {candidates.length > 0 ? (
        <Card className="gap-4 py-5">
          <CardHeader>
            <CardTitle className="text-sm">可导入的模型（{candidates.length}）</CardTitle>
            <CardDescription className="text-[12px]">
              模型地址与模型名称都相同的配置会自动跳过，重复导入不会产生重复卡片。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="max-h-[420px] overflow-y-auto rounded-md border border-line">
              {candidates.map((model) => (
                <div
                  key={model.modelName}
                  className="flex min-w-0 items-center gap-3 border-b border-line px-3 py-2 text-[12px] last:border-b-0"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-fg" title={model.displayName}>
                      {model.displayName}
                    </span>
                    <span className="truncate text-dim" title={model.modelName}>
                      {model.modelName}
                    </span>
                  </div>
                  <span
                    className="max-w-[40%] shrink-0 truncate text-dim"
                    title={model.providerName}
                  >
                    {model.providerName}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-end">
              <Button type="button" onClick={() => void handleImport()} disabled={importing}>
                <Download />
                {importing ? '导入中…' : `导入 ${candidates.length} 个模型`}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
