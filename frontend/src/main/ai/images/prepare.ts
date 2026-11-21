/**
 * 把工作区里的图片变成「可以直接放进模型请求」的字节。
 *
 * 分工（对齐 deepseek-harness 的 attachment 层思路，但只保留本项目需要的部分）：
 * - 识别与尺寸：probe.ts 读文件头，不依赖解码器；
 * - 缩放与重编码：nativeImage（Electron 内置，只可靠支持 PNG/JPEG）；
 * - 限额：源文件大小、解码像素、发出去的边长与编码字节数各有一道。
 *
 * 已经合规的图片原样直通，不重编码：动图、EXIF 方向、ICC 都保持用户给的样子。
 */
import { nativeImage } from 'electron'
import { readImageFacts } from './probe'
import type { ImageFacts, ImageMediaType } from './types'

/** 单个源文件字节上限：比模型端宽松，超出的图片本来也不适合贴进对话 */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024

/** 源图片解码像素上限：挡住解压炸弹，也挡住「一张 20000×20000 的截图」 */
export const MAX_SOURCE_PIXELS = 40_000_000

/** 发给模型的单张编码字节上限 */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024

/** 发给模型的长边像素上限：常见的视觉模型都在这个量级之上开始丢细节 */
export const MAX_REQUEST_DIMENSION = 2048

/** JPEG 重编码质量：够看清文字，又不会把字节撑爆 */
const JPEG_QUALITY = 85

/** 逐级缩小的比例：第一轮按长边上限缩放，之后按比例继续压 */
const SHRINK_LADDER = [1, 0.75, 0.56, 0.42, 0.32] as const

/** 可以直接进入请求的图片字节与它的事实 */
export interface PreparedImage {
  data: Uint8Array
  mediaType: ImageMediaType
  width: number
  height: number
  /** 源图事实：只有被缩小或重编码过时才有 */
  source?: ImageFacts
}

/** 是否已经满足请求限额 */
function fitsRequest(facts: ImageFacts, bytes: number): boolean {
  return bytes <= MAX_REQUEST_BYTES && Math.max(facts.width, facts.height) <= MAX_REQUEST_DIMENSION
}

/** 按长边上限等比缩放，不放大小图 */
function fitLongEdge(facts: ImageFacts): { width: number; height: number } {
  const longEdge = Math.max(facts.width, facts.height)
  if (longEdge <= MAX_REQUEST_DIMENSION) {
    return { width: facts.width, height: facts.height }
  }
  const scale = MAX_REQUEST_DIMENSION / longEdge
  return {
    width: Math.max(1, Math.round(facts.width * scale)),
    height: Math.max(1, Math.round(facts.height * scale))
  }
}

/** 人类可读的字节数，只用于给模型的说明文字 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/**
 * 校验并（必要时）缩小一张图片。
 * @param data 源文件字节
 * @param facts 源图格式与尺寸（由 probe 读出）
 * @returns 可以直接放进请求的字节与事实
 * @throws Error 源图超出像素上限、格式无法在本地缩放、或压缩后仍然过大
 */
export function prepareImageForModel(data: Uint8Array, facts: ImageFacts): PreparedImage {
  if (facts.width * facts.height > MAX_SOURCE_PIXELS) {
    throw new Error(
      `图片像素数 ${facts.width}×${facts.height} 超过上限（${MAX_SOURCE_PIXELS.toLocaleString()} 像素），请先缩小后再读`
    )
  }
  if (fitsRequest(facts, data.byteLength)) {
    return { data, mediaType: facts.mediaType, width: facts.width, height: facts.height }
  }
  // nativeImage 只可靠解码 PNG/JPEG；GIF 与 WebP 在这里无法缩放，只能如实报错
  if (facts.mediaType === 'image/gif' || facts.mediaType === 'image/webp') {
    throw new Error(
      `${facts.mediaType === 'image/gif' ? 'GIF' : 'WebP'} 图片 ${facts.width}×${facts.height}（${formatBytes(data.byteLength)}）超出单张限额，且本地无法缩放该格式；请转成 PNG 或 JPEG 后重试`
    )
  }
  const image = nativeImage.createFromBuffer(Buffer.from(data), { scaleFactor: 1 })
  if (image.isEmpty()) {
    throw new Error(`图片解码失败，可能已损坏：${facts.mediaType}`)
  }
  const target = fitLongEdge(facts)
  for (const scale of SHRINK_LADDER) {
    const width = Math.max(1, Math.round(target.width * scale))
    const height = Math.max(1, Math.round(target.height * scale))
    const resized =
      width === facts.width && height === facts.height
        ? image
        : image.resize({ width, height, quality: 'good' })
    const encoded = facts.mediaType === 'image/png' ? resized.toPNG() : resized.toJPEG(JPEG_QUALITY)
    if (encoded.byteLength > MAX_REQUEST_BYTES) {
      continue
    }
    // 编码器的实际输出才是事实：尺寸与格式以重新读回的头部为准
    const encodedFacts = readImageFacts(encoded)
    if (!encodedFacts) {
      throw new Error('图片重编码后无法识别，请把图片转成 PNG 或 JPEG 后重试')
    }
    return {
      data: encoded,
      mediaType: encodedFacts.mediaType,
      width: encodedFacts.width,
      height: encodedFacts.height,
      source: facts
    }
  }
  throw new Error(
    `图片缩放后仍然超过单张 ${formatBytes(MAX_REQUEST_BYTES)} 的限额，请先手工缩小后再读`
  )
}
