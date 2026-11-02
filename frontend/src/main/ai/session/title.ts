/**
 * 会话标题生成。
 *
 * 对应 deepseek-harness 的 session-title-first-prompt-llm：只在首轮跑一次，
 * 把首条用户消息润色成更可读的短标题；失败就保留首条消息摘要作为兜底，
 * 用户手工改名（autoTitle=false）后不再覆盖。
 *
 * 标题只用于展示，永远不进入模型输入。
 */
import type { OpenAiConfig } from '../llm/openai'
import { completeChat } from '../llm/openai'

/** 标题长度上限：与渲染层的首条消息摘要一致，避免两边长度跳变 */
const TITLE_MAX_CHARS = 20

/** 首条消息送进模型的最大字符数：标题不需要全文 */
const PROMPT_MAX_CHARS = 2000

/** 只产出标题本身，避免模型带解释、引号或 Markdown */
const SYSTEM_PROMPT = [
  '你是会话标题生成器。根据用户的第一条消息，生成一个能概括这次对话的短标题。',
  `要求：不超过 ${TITLE_MAX_CHARS} 个字符；不要引号、书名号、句号或任何前缀；只输出标题本身。`,
  '使用与用户消息相同的语言。'
].join('\n')

/** 去掉可能包裹标题的引号与括号 */
const WRAPPER_PATTERN = /^["'“”‘’《》【】]+|["'“”‘’《》【】]+$/g

/**
 * 用首条用户消息生成会话标题。
 * @param model 模型连接配置（沿用当前会话的模型）
 * @param prompt 首条用户消息
 * @param signal 取消信号
 * @returns 清洗后的标题；请求失败或输出不可用时返回 null，调用方保留兜底标题
 */
export async function generateTitle(
  model: OpenAiConfig,
  prompt: string,
  signal: AbortSignal
): Promise<string | null> {
  try {
    const raw = await completeChat(
      model,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [...prompt].slice(0, PROMPT_MAX_CHARS).join('') }
      ],
      signal
    )
    return sanitizeTitle(raw)
  } catch (error) {
    // 标题只是锦上添花：失败时静默保留首条消息摘要，不打扰用户
    if (!signal.aborted) {
      console.warn('生成会话标题失败，保留首条消息摘要', error)
    }
    return null
  }
}

/** 取首个非空行、剥掉"标题："前缀与包裹引号，再按字符数裁剪 */
export function sanitizeTitle(raw: string): string | null {
  const line = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (!line) {
    return null
  }
  const cleaned = line
    .replace(/^(?:标题|title)\s*[:：]\s*/i, '')
    .replace(WRAPPER_PATTERN, '')
    .trim()
  if (cleaned.length === 0) {
    return null
  }
  const chars = [...cleaned]
  return chars.length > TITLE_MAX_CHARS ? chars.slice(0, TITLE_MAX_CHARS).join('') : cleaned
}
