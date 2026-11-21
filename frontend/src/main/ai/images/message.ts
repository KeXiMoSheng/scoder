/**
 * 带图片的工具结果如何在模型请求里表达。
 *
 * 为什么另起一条用户消息，而不是把图片塞进 tool 消息：OpenAI 兼容接口里
 * tool 消息的 content 规范上只有文本，部分网关遇到数组会直接 400；
 * 而 user 消息接受 image_url 内容块，是最普遍的形态。
 * 会话重放与实时发送共用这一个函数，模型看到的历史才不会两次不一样。
 */
import type { ChatContentPart, ChatMessage } from '../llm/openai'
import type { ToolImageRef } from './types'

/** 一张已经取回字节、可以直接放进请求的图片 */
export interface ToolImagePayload {
  ref: ToolImageRef
  /** data:image/…;base64,… */
  dataUrl: string
}

/** 按引用取一张图片的 data URL；对象缺失或校验失败时返回 undefined */
export type ImageRefLoader = (ref: ToolImageRef) => Promise<string | undefined>

/**
 * 把用户文本与随之附加的图片拼成一条用户消息的内容。
 *
 * 用户在输入区粘贴的图片走这里：图片以 image_url 内容块跟在文本之后，
 * 文本里已经用 `<attachment type="image" … />` 说明了每张图的名字与尺寸。
 * 取不回来的图片直接省略 —— 宁可少一张图，也不要让整轮请求失败。
 * @param text 用户文本（含附件说明）
 * @param refs 按出现顺序的图片引用
 * @param load 按引用取 data URL 的方法
 * @returns 没有图片时是文本本身，否则是文本 + 图片内容块
 */
export async function userContentWithImages(
  text: string,
  refs: readonly ToolImageRef[],
  load: ImageRefLoader
): Promise<string | ChatContentPart[]> {
  if (refs.length === 0) {
    return text
  }
  const parts: ChatContentPart[] = text.length > 0 ? [{ type: 'text', text }] : []
  for (const ref of refs) {
    const dataUrl = await load(ref)
    if (dataUrl !== undefined) {
      parts.push({ type: 'image_url', image_url: { url: dataUrl } })
    }
  }
  return parts.length === 0 ? text : parts
}

/**
 * 组装「工具刚读到的图片」这条用户消息。
 * @param images 本次要附上的图片，按工具调用顺序
 * @returns 一条用户消息；没有图片时返回 undefined
 */
export function toolImageMessage(images: readonly ToolImagePayload[]): ChatMessage | undefined {
  if (images.length === 0) {
    return undefined
  }
  const text =
    images.length === 1
      ? `以下是工具读取的图片 ${images[0].ref.sourcePath}（图片本身，不是文字描述）：`
      : `以下是工具读取的图片：\n${images
          .map((image) => `- ${image.ref.sourcePath}（${image.ref.width}×${image.ref.height}）`)
          .join('\n')}`
  const parts: ChatContentPart[] = [
    { type: 'text', text },
    ...images.map((image): ChatContentPart => ({
      type: 'image_url',
      image_url: { url: image.dataUrl }
    }))
  ]
  return { role: 'user', content: parts }
}
