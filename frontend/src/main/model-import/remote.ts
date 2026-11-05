import type { ModelConfigInput, RemoteModelListRequest } from '../../shared/model-config/types'

/** 拉取模型列表的超时时间：地址不通时不至于让设置页一直转圈 */
const FETCH_TIMEOUT_MS = 20_000

/** 提示里保留的错误详情长度：上游错误体可能很长 */
const MAX_ERROR_DETAIL = 300

/** 供应商名缺失时的兜底（model_configs.provider_name 不允许为空） */
const FALLBACK_PROVIDER = '未命名供应商'

/**
 * 拉取 OpenAI 兼容的模型列表，并把每条记录映射成待导入的模型配置：
 * id → 模型名称，name → 模型显示名称，owned_by → 供应商名，Bearer 之后的内容 → API Key。
 * 请求放在主进程：渲染进程直连第三方地址会被 CORS 拦住，密钥也不必落进页面请求。
 * @param request 模型请求地址、模型列表地址与 Authorization 头
 * @throws Error 地址非法、请求失败或响应不是可识别的模型列表
 */
export async function fetchRemoteModels(
  request: RemoteModelListRequest
): Promise<ModelConfigInput[]> {
  if (!request || typeof request !== 'object') {
    throw new Error('参数无效')
  }
  const baseUrl = requireHttpUrl(request.baseUrl, '模型请求地址')
  const modelsUrl = requireHttpUrl(request.modelsUrl, '模型列表地址')
  const authorization = normalizeAuthorization(request.authorization)
  const apiKey = extractApiKey(authorization)
  const fallbackProvider = providerFromUrl(modelsUrl)

  const response = await requestModels(modelsUrl, authorization)
  const body = await response.text()
  if (!response.ok) {
    throw new Error(
      `拉取模型列表失败（HTTP ${response.status}）：${body.slice(0, MAX_ERROR_DETAIL) || '无响应内容'}`
    )
  }
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error(
      `模型列表地址返回的不是 JSON（HTTP ${response.status}）：${body.slice(0, MAX_ERROR_DETAIL)}`
    )
  }

  const models: ModelConfigInput[] = []
  // 上游偶尔会重复返回同一个 id，先按模型名称去重，避免列表里出现重复条目
  const seen = new Set<string>()
  for (const raw of readModelItems(payload)) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const item = raw as Record<string, unknown>
    const modelName = text(item.id)
    if (!modelName || seen.has(modelName)) {
      continue
    }
    seen.add(modelName)
    models.push({
      providerName: text(item.owned_by) || fallbackProvider,
      baseUrl,
      // 展示名缺失时退回模型名称，避免出现空标题的卡片
      displayName: text(item.name) || modelName,
      modelName,
      apiKey
    })
  }
  if (models.length === 0) {
    throw new Error('模型列表里没有可导入的模型（每条记录都需要 id 字段）')
  }
  return models
}

/** 发起列表请求；网络错误与超时统一转成可展示的提示 */
async function requestModels(modelsUrl: string, authorization: string): Promise<Response> {
  try {
    return await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: authorization
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
  } catch (error) {
    throw new Error(`无法访问模型列表地址：${describeFetchError(error)}`, { cause: error })
  }
}

/** 网络层异常 → 用户能看懂的一句话 */
function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') {
      return `请求超时（${FETCH_TIMEOUT_MS / 1000} 秒）`
    }
    return error.message
  }
  return String(error)
}

/** 兼容两种常见形状：{ object: 'list', data: [...] } 与直接返回数组 */
function readModelItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload
  }
  if (payload && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data
    if (Array.isArray(data)) {
      return data
    }
  }
  throw new Error('模型列表格式无法识别：期望 { data: [...] } 或直接是数组')
}

/** 校验并清洗 http(s) 地址；模型请求地址去掉末尾斜杠，避免拼出双斜杠 */
function requireHttpUrl(value: unknown, label: string): string {
  const trimmed = text(value)
  if (!trimmed) {
    throw new Error(`${label}不能为空`)
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${label}不是合法的 URL：${trimmed}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label}必须是 http(s) 地址`)
  }
  return trimmed.replace(/\/+$/, '')
}

/**
 * 归一化 Authorization 头：用户可能粘贴完整的 “Bearer sk-…” 或只粘贴密钥。
 * 只填密钥时补上前缀，保证主进程发出的头是合法的 Bearer 凭证。
 */
function normalizeAuthorization(value: unknown): string {
  const trimmed = text(value)
  if (!trimmed) {
    throw new Error('Authorization 不能为空')
  }
  // 已经带方案（Bearer/Basic 等）时原样使用；纯密钥则按 Bearer 处理
  return /^[A-Za-z]+\s+/.test(trimmed) ? trimmed : `Bearer ${trimmed}`
}

/** 取 Authorization 中方案之后的凭证部分，作为所有导入模型的 API Key */
function extractApiKey(authorization: string): string {
  const match = /^\S+\s+(.+)$/.exec(authorization)
  return match ? match[1].trim() : authorization
}

/** owned_by 缺失时用列表地址的域名兜底，比统一的“未命名供应商”更容易辨认 */
function providerFromUrl(url: string): string {
  try {
    return new URL(url).host || FALLBACK_PROVIDER
  } catch {
    return FALLBACK_PROVIDER
  }
}

/** 任意值 → 去空白的字符串 */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
