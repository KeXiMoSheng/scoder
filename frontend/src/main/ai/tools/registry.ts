import type { JsonSchemaObject, JsonValue, ToolCardView } from '../../../shared/ai/types'
import type { FileSystemService } from '../fs/service'

/** 工具执行上下文：由循环在每次调用时构造，工具不得跨调用缓存 */
export interface ToolContext {
  fs: FileSystemService
  /** 会话工作目录（P0 恒为工作区根） */
  cwd: string
  sessionId: string
  /** 用户中止本轮对话时触发；长耗时工具必须转发 */
  signal: AbortSignal
}

/** 工具的规范输出：text 给模型，meta 给 UI（可回放） */
export interface ToolOutcome {
  text: string
  meta?: JsonValue
}

/**
 * 工具定义。
 * 工具只描述“做什么”和“怎么给模型看”，不持有文件句柄、不做权限判断；
 * 权限、观测与审批属于执行流水线（P1 在 Registry.execute 处插入）。
 */
export interface ToolDefinition {
  name: string
  description: string
  /** 参数 schema，直接转成模型的 function.parameters */
  parameters: JsonSchemaObject
  /** 声明为 true 才允许与同批次的兄弟调用并发；P0 一律串行 */
  isConcurrencySafe?: (args: Record<string, unknown>) => boolean
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>
  /** 执行前推导的挂起卡片（纯函数，只依赖参数，供实时展示与回放） */
  presentCall?: (args: Record<string, unknown>) => ToolCardView | undefined
  /** 执行后推导的完成卡片（纯函数，只依赖参数与结果） */
  presentResult?: (args: Record<string, unknown>, outcome: ToolOutcome) => ToolCardView | undefined
}

/** 一次工具调用的结果：失败也作为文本回灌给模型，让它可以自我纠正 */
export interface ToolExecutionResult {
  ok: boolean
  text: string
  card?: ToolCardView
}

/** 从参数表读取必填字符串（模型偶尔传 null 或空串） */
export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`参数 ${key} 必须是非空字符串`)
  }
  return value
}

/** 从参数表读取可选字符串 */
export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** 从参数表读取可选整数，越界时落到 upper 上 */
export function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  upper: number
): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return fallback
  return Math.min(value, upper)
}

/** 统一把未知异常转成可读文本 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 工具注册表：名称 → 定义。
 * 与 deepseek-harness 的 ctx.tools 同构，但 P0 不引入依赖注入与事件总线，
 * 策略钩子（先读后改、沙箱、审批）在 execute 内以普通函数插入。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(definition: ToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`工具重名：${definition.name}`)
    }
    this.tools.set(definition.name, definition)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  /**
   * 执行一次模型发起的工具调用。
   * 失败不抛出：错误文本会作为工具结果回灌，模型据此重试或换路径。
   * @param name 工具名
   * @param rawArguments 模型给出的 JSON 字符串
   * @param ctx 执行上下文
   */
  async execute(
    name: string,
    rawArguments: string,
    ctx: ToolContext
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { ok: false, text: `未知工具：${name}` }
    }
    let args: Record<string, unknown>
    try {
      args = parseArguments(rawArguments)
    } catch (error) {
      return { ok: false, text: `工具参数不是合法的 JSON 对象：${errorMessage(error)}` }
    }
    const missing = (tool.parameters.required ?? []).filter((key) => !(key in args))
    if (missing.length > 0) {
      return { ok: false, text: `缺少必填参数：${missing.join(', ')}` }
    }
    // P1：在此插入 pre-execute 策略（先读后改、工作区包含、危险路径、审批）
    try {
      const outcome = await tool.execute(args, ctx)
      const card = tool.presentResult?.(args, outcome)
      return { ok: true, text: outcome.text, ...(card ? { card } : {}) }
    } catch (error) {
      // 用户中止不是工具失败：向上传播，让循环以 aborted 收尾
      if (ctx.signal.aborted) throw error
      return { ok: false, text: `工具执行失败：${errorMessage(error)}` }
    }
  }
}

/** 解析模型给出的工具参数；只接受 JSON 对象 */
function parseArguments(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('期望一个 JSON 对象')
  }
  return parsed as Record<string, unknown>
}
