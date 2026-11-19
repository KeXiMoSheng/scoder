import { useCallback, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import {
  formatKeyValueLines,
  formatLineList,
  parseKeyValueLines,
  parseLineList
} from '@shared/mcp/format'
import {
  DEFAULT_MCP_RECONNECT,
  MCP_RECONNECT_LIMITS,
  MCP_SERVER_NAME_PATTERN,
  MCP_TIMEOUT_LIMITS,
  type McpReconnectSettings,
  type McpServerInput,
  type McpTransport
} from '@shared/mcp/types'
import { extractErrorMessage } from '../../lib/errorMessage'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Textarea } from '../ui/textarea'
import type { ChangeEvent, FormEvent } from 'react'
import type { McpServerFormProps } from './types'

/**
 * 表单状态：数字与键值集合都用文本保存。
 * 数字用字符串是为了“清空输入框”时不被强制拉回 0；键值集合用文本是为了保留编辑中的非法行，
 * 提交时再统一解析并给出可读错误。
 */
interface FormState {
  name: string
  enabled: boolean
  transport: McpTransport
  command: string
  args: string
  env: string
  cwd: string
  url: string
  headers: string
  toolCallTimeoutMs: string
  startupTimeoutMs: string
  reconnectEnabled: boolean
  initialDelayMs: string
  maxDelayMs: string
  maxAttempts: string
}

/** 配置 → 表单 */
function toForm(initial: McpServerFormProps['initial']): FormState {
  if (initial === null) {
    return {
      name: '',
      enabled: true,
      transport: 'stdio',
      command: '',
      args: '',
      env: '',
      cwd: '',
      url: '',
      headers: '',
      toolCallTimeoutMs: '60000',
      startupTimeoutMs: '30000',
      reconnectEnabled: DEFAULT_MCP_RECONNECT.enabled,
      initialDelayMs: String(DEFAULT_MCP_RECONNECT.initialDelayMs),
      maxDelayMs: String(DEFAULT_MCP_RECONNECT.maxDelayMs),
      maxAttempts: String(DEFAULT_MCP_RECONNECT.maxAttempts)
    }
  }
  return {
    name: initial.name,
    enabled: initial.enabled,
    transport: initial.transport,
    command: initial.command,
    args: formatLineList(initial.args),
    env: formatKeyValueLines(initial.env),
    cwd: initial.cwd,
    url: initial.url,
    headers: formatKeyValueLines(initial.headers),
    toolCallTimeoutMs: String(initial.toolCallTimeoutMs),
    startupTimeoutMs: String(initial.startupTimeoutMs),
    reconnectEnabled: initial.reconnect.enabled,
    initialDelayMs: String(initial.reconnect.initialDelayMs),
    maxDelayMs: String(initial.reconnect.maxDelayMs),
    maxAttempts: String(initial.reconnect.maxAttempts)
  }
}

/**
 * 新增/编辑 MCP 服务端的表单。
 *
 * 字段与 mcp_servers 表一一对应，并按传输方式分组：stdio 用命令/参数/环境变量/工作目录，
 * streamable-http 用地址/请求头。两侧互斥的字段在这里就不展示，主进程仍会再校验一次。
 */
export default function McpServerForm({
  initial,
  onSubmit,
  onCancel
}: McpServerFormProps): React.JSX.Element {
  const [form, setForm] = useState<FormState>(() => toForm(initial))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update =
    (field: keyof FormState) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      const { value } = event.target
      setForm((prev) => ({ ...prev, [field]: value }))
    }

  /** 传输方式与两个开关不在输入框里，单独的回调 */
  const updateTransport = useCallback((value: string): void => {
    setForm((prev) => ({
      ...prev,
      transport: value === 'streamable-http' ? 'streamable-http' : 'stdio'
    }))
  }, [])

  const updateReconnectEnabled = useCallback((value: string): void => {
    setForm((prev) => ({ ...prev, reconnectEnabled: value === 'on' }))
  }, [])

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      if (saving) {
        return
      }
      setError(null)
      const parsed = parseForm(form)
      if (typeof parsed === 'string') {
        setError(parsed)
        return
      }
      setSaving(true)
      try {
        await onSubmit(parsed)
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
        返回服务列表
      </Button>
      <Card className="gap-5 py-5">
        <CardHeader>
          <CardTitle className="text-sm">
            {initial === null ? '添加 MCP 服务' : '编辑 MCP 服务'}
          </CardTitle>
          <CardDescription className="text-[12px]">
            配置一个 MCP 服务端，它的工具会以 mcp__服务名__工具名 的名字提供给
            AI；配置只保存在本机。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor="mcp-name">服务名</FieldLabel>
                <Input
                  id="mcp-name"
                  value={form.name}
                  onChange={update('name')}
                  placeholder="例如 filesystem"
                  autoComplete="off"
                  required
                />
                <FieldDescription>
                  只允许字母、数字、下划线与短横线，长度
                  1-32；它同时是工具名的命名空间，改名后旧名字的工具不再存在。
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="mcp-transport">连接方式</FieldLabel>
                <Select value={form.transport} onValueChange={updateTransport}>
                  <SelectTrigger id="mcp-transport" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">stdio（本地子进程）</SelectItem>
                    <SelectItem value="streamable-http">streamable-http（远程地址）</SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  stdio 由本机启动服务端进程；streamable-http 连接已经在运行的 MCP 端点。
                </FieldDescription>
              </Field>

              {form.transport === 'stdio' ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="mcp-command">启动命令</FieldLabel>
                    <Input
                      id="mcp-command"
                      value={form.command}
                      onChange={update('command')}
                      placeholder="例如 npx"
                      autoComplete="off"
                      required
                    />
                    <FieldDescription>
                      可执行文件名或绝对路径；Windows 上通常是 npx.cmd 或 node.exe。
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mcp-args">参数</FieldLabel>
                    <Textarea
                      id="mcp-args"
                      value={form.args}
                      onChange={update('args')}
                      placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:\\work'}
                      rows={4}
                      spellCheck={false}
                    />
                    <FieldDescription>
                      每行一个参数，按原样传给子进程，不经 shell 解释；以 # 开头的行是注释。
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mcp-env">环境变量</FieldLabel>
                    <Textarea
                      id="mcp-env"
                      value={form.env}
                      onChange={update('env')}
                      placeholder={'NODE_ENV=production\n# 每行一条 KEY=VALUE'}
                      rows={3}
                      spellCheck={false}
                    />
                    <FieldDescription>
                      叠加在系统环境之上；系统里已有的密钥类变量不会传给子进程。
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mcp-cwd">工作目录</FieldLabel>
                    <Input
                      id="mcp-cwd"
                      value={form.cwd}
                      onChange={update('cwd')}
                      placeholder="留空表示继承应用的工作目录"
                      autoComplete="off"
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field>
                    <FieldLabel htmlFor="mcp-url">服务地址</FieldLabel>
                    <Input
                      id="mcp-url"
                      value={form.url}
                      onChange={update('url')}
                      placeholder="https://example.com/mcp"
                      autoComplete="off"
                      required
                    />
                    <FieldDescription>MCP 端点地址，必须使用 http 或 https。</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mcp-headers">请求头</FieldLabel>
                    <Textarea
                      id="mcp-headers"
                      value={form.headers}
                      onChange={update('headers')}
                      placeholder="Authorization=Bearer sk-…"
                      rows={3}
                      spellCheck={false}
                    />
                    <FieldDescription>
                      每行一条 KEY=VALUE，随每个请求发送；密钥类请求头会以明文保存在本机数据库。
                    </FieldDescription>
                  </Field>
                </>
              )}

              <div className="grid gap-5 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="mcp-tool-timeout">工具调用超时（毫秒）</FieldLabel>
                  <Input
                    id="mcp-tool-timeout"
                    value={form.toolCallTimeoutMs}
                    onChange={update('toolCallTimeoutMs')}
                    inputMode="numeric"
                    required
                  />
                  <FieldDescription>
                    {MCP_TIMEOUT_LIMITS.toolCallTimeoutMs.min} -{' '}
                    {MCP_TIMEOUT_LIMITS.toolCallTimeoutMs.max}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="mcp-startup-timeout">启动超时（毫秒）</FieldLabel>
                  <Input
                    id="mcp-startup-timeout"
                    value={form.startupTimeoutMs}
                    onChange={update('startupTimeoutMs')}
                    inputMode="numeric"
                    required
                  />
                  <FieldDescription>
                    连接加首次同步工具的预算，{MCP_TIMEOUT_LIMITS.startupTimeoutMs.min} -{' '}
                    {MCP_TIMEOUT_LIMITS.startupTimeoutMs.max}
                  </FieldDescription>
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="mcp-reconnect-enabled">断线自动重连</FieldLabel>
                <Select
                  value={form.reconnectEnabled ? 'on' : 'off'}
                  onValueChange={updateReconnectEnabled}
                >
                  <SelectTrigger id="mcp-reconnect-enabled" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="on">开启</SelectItem>
                    <SelectItem value="off">关闭</SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  关闭后断线即放弃并注销工具；开启时按下面的退避参数重试。
                </FieldDescription>
              </Field>

              <div className="grid gap-5 sm:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="mcp-reconnect-initial">首次延迟（毫秒）</FieldLabel>
                  <Input
                    id="mcp-reconnect-initial"
                    value={form.initialDelayMs}
                    onChange={update('initialDelayMs')}
                    inputMode="numeric"
                    required
                  />
                  <FieldDescription>
                    {MCP_RECONNECT_LIMITS.initialDelayMs.min} -{' '}
                    {MCP_RECONNECT_LIMITS.initialDelayMs.max}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="mcp-reconnect-max-delay">最大延迟（毫秒）</FieldLabel>
                  <Input
                    id="mcp-reconnect-max-delay"
                    value={form.maxDelayMs}
                    onChange={update('maxDelayMs')}
                    inputMode="numeric"
                    required
                  />
                  <FieldDescription>
                    {MCP_RECONNECT_LIMITS.maxDelayMs.min} - {MCP_RECONNECT_LIMITS.maxDelayMs.max}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="mcp-reconnect-attempts">最大重试次数</FieldLabel>
                  <Input
                    id="mcp-reconnect-attempts"
                    value={form.maxAttempts}
                    onChange={update('maxAttempts')}
                    inputMode="numeric"
                    required
                  />
                  <FieldDescription>
                    {MCP_RECONNECT_LIMITS.maxAttempts.min} - {MCP_RECONNECT_LIMITS.maxAttempts.max}
                  </FieldDescription>
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="mcp-enabled">保存后启用</FieldLabel>
                <Select
                  value={form.enabled ? 'on' : 'off'}
                  onValueChange={(value) =>
                    setForm((prev) => ({ ...prev, enabled: value === 'on' }))
                  }
                >
                  <SelectTrigger id="mcp-enabled" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="on">启用（保存后立即连接）</SelectItem>
                    <SelectItem value="off">停用（只保存配置）</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              {error !== null ? (
                <p role="alert" className="text-[12px] leading-[1.6] text-danger">
                  {error}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
                  取消
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? '保存中…' : '保存'}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * 表单 → 提交字段；任一字段非法时返回可直接展示的错误消息。
 * 只做“能立刻看出来”的检查：命名规则、必填项、数字范围、键值文本；
 * 服务名唯一性、地址协议等仍由主进程统一裁定。
 */
function parseForm(form: FormState): McpServerInput | string {
  const name = form.name.trim()
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    return '服务名只能包含字母、数字、下划线和短横线，长度 1-32'
  }
  const args = parseLineList(form.args)
  const env = parseKeyValueLines(form.env)
  if (env.error !== null) {
    return `环境变量：${env.error}`
  }
  const headers = parseKeyValueLines(form.headers)
  if (headers.error !== null) {
    return `请求头：${headers.error}`
  }
  const toolCallTimeoutMs = parseInteger(
    form.toolCallTimeoutMs,
    '工具调用超时',
    MCP_TIMEOUT_LIMITS.toolCallTimeoutMs
  )
  if (typeof toolCallTimeoutMs === 'string') {
    return toolCallTimeoutMs
  }
  const startupTimeoutMs = parseInteger(
    form.startupTimeoutMs,
    '启动超时',
    MCP_TIMEOUT_LIMITS.startupTimeoutMs
  )
  if (typeof startupTimeoutMs === 'string') {
    return startupTimeoutMs
  }
  const reconnect = parseReconnect(form)
  if (typeof reconnect === 'string') {
    return reconnect
  }
  const transport = form.transport
  if (transport === 'stdio' && form.command.trim().length === 0) {
    return 'stdio 传输必须填写启动命令'
  }
  if (transport === 'streamable-http' && form.url.trim().length === 0) {
    return 'streamable-http 传输必须填写服务地址'
  }
  return {
    name,
    enabled: form.enabled,
    transport,
    // 只提交当前传输方式用得上的字段，另一侧留空：主进程会拒绝跨方式的残留值
    command: transport === 'stdio' ? form.command.trim() : '',
    args: transport === 'stdio' ? args : [],
    env: transport === 'stdio' ? env.values : {},
    cwd: transport === 'stdio' ? form.cwd.trim() : '',
    url: transport === 'streamable-http' ? form.url.trim() : '',
    headers: transport === 'streamable-http' ? headers.values : {},
    toolCallTimeoutMs,
    startupTimeoutMs,
    reconnect
  }
}

/** 解析重连策略 */
function parseReconnect(form: FormState): McpReconnectSettings | string {
  const initialDelayMs = parseInteger(
    form.initialDelayMs,
    '首次重试延迟',
    MCP_RECONNECT_LIMITS.initialDelayMs
  )
  if (typeof initialDelayMs === 'string') {
    return initialDelayMs
  }
  const maxDelayMs = parseInteger(form.maxDelayMs, '最大重试延迟', MCP_RECONNECT_LIMITS.maxDelayMs)
  if (typeof maxDelayMs === 'string') {
    return maxDelayMs
  }
  const maxAttempts = parseInteger(
    form.maxAttempts,
    '最大重试次数',
    MCP_RECONNECT_LIMITS.maxAttempts
  )
  if (typeof maxAttempts === 'string') {
    return maxAttempts
  }
  if (initialDelayMs > maxDelayMs) {
    return '首次重试延迟不能大于最大重试延迟'
  }
  return { enabled: form.reconnectEnabled, initialDelayMs, maxDelayMs, maxAttempts }
}

/** 解析范围内的整数；失败时返回错误消息 */
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
