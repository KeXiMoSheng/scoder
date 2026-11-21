/**
 * 本轮模型的输入能力。
 *
 * 图片输入默认按「支持」处理：OpenAI 兼容生态里带视觉的模型直接接受图片块，
 * 而文本模型会以 400 回复。这里就是按模型区分的口子 —— 要接入「某个模型不能看图」，
 * 只要让 {@link resolveModelCapabilities} 返回 false（按模型名查表、或以后在模型配置里加字段），
 * 下游三处都会自动跟着变，不必改它们：
 *
 * 1. `runTurn` 下发的工具清单：`read_image` 声明了 `requiresVision`，不可看图时不下发；
 * 2. 历史重放：不可看图时不把历史图片作为图片消息回放，只留工具结果的文字说明；
 * 3. 系统提示：不可看图时不出现看图规则（见 `buildSystemPrompt` 的 capabilities 参数）。
 */
import type { OpenAiConfig } from './llm/openai'

/** 一轮对话里模型的输入能力 */
export interface ModelCapabilities {
  /** 能否把图片放进请求（image_url 内容块） */
  vision: boolean
}

/**
 * 明确不能看图的模型名（小写全名）。
 * 默认留空：绝大多数接入场景用的是视觉模型；遇到文本模型把名字加进来即可。
 */
const TEXT_ONLY_MODELS: ReadonlySet<string> = new Set()

/**
 * 解析本轮模型的输入能力。
 * @param model 本轮的连接配置
 * @returns 本轮可用的输入能力
 */
export function resolveModelCapabilities(model: OpenAiConfig): ModelCapabilities {
  return { vision: !TEXT_ONLY_MODELS.has(model.modelName.toLowerCase()) }
}
