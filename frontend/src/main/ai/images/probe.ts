/**
 * 图片探测：只读文件头，不完整解码。
 *
 * 为什么自己解析而不是交给 nativeImage：nativeImage 只可靠地解 PNG/JPEG，
 * 而 read_image 要支持 WebP/GIF（模型端也支持这四种），尺寸又要写进给模型的
 * 说明文字里。解析头部是纯函数，边界明确，也不会因为一张几十 MB 的图而在主进程里
 * 分配整块位图。
 */
import type { ImageFacts, ImageMediaType } from './types'

/** PNG 文件签名 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/** 读取大端 32 位整数 */
function u32be(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  )
}

/** 读取小端 16 位整数 */
function u16le(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8)
}

/** 读取小端 24 位整数 */
function u24le(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)
}

/** 读取小端 32 位整数 */
function u32le(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  )
}

/** 偏移处是否是指定文本（用于 GIF/RIFF 这类 ASCII 标记） */
function asciiAt(data: Uint8Array, offset: number, text: string): boolean {
  if (data.length < offset + text.length) {
    return false
  }
  for (let index = 0; index < text.length; index += 1) {
    if (data[offset + index] !== text.charCodeAt(index)) {
      return false
    }
  }
  return true
}

/** PNG：IHDR 里就是宽高，偏移固定 */
function pngFacts(data: Uint8Array): ImageFacts | undefined {
  if (data.length < 24 || !asciiAt(data, 12, 'IHDR')) {
    return undefined
  }
  const width = u32be(data, 16)
  const height = u32be(data, 20)
  return positiveFacts('image/png', width, height)
}

/**
 * JPEG：从 SOI 之后逐个跳过标记段，找到 SOFn 里的宽高。
 * 只有 SOF 段带尺寸；扫描可能遇到注释、量化表等任意长度的段。
 */
function jpegFacts(data: Uint8Array): ImageFacts | undefined {
  let offset = 2
  while (offset + 3 < data.length) {
    if (data[offset] !== 0xff) {
      return undefined
    }
    // 标记前允许有填充的 0xFF
    let marker = data[offset + 1]
    while (marker === 0xff && offset + 2 < data.length) {
      offset += 1
      marker = data[offset + 1]
    }
    offset += 2
    // TEM 与 RSTn 没有长度字段
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      continue
    }
    if (offset + 1 >= data.length) {
      return undefined
    }
    const length = (data[offset] << 8) | data[offset + 1]
    if (length < 2) {
      return undefined
    }
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      if (offset + 7 >= data.length) {
        return undefined
      }
      const height = (data[offset + 3] << 8) | data[offset + 4]
      const width = (data[offset + 5] << 8) | data[offset + 6]
      return positiveFacts('image/jpeg', width, height)
    }
    offset += length
  }
  return undefined
}

/** GIF：逻辑屏幕宽度与高度，小端 16 位 */
function gifFacts(data: Uint8Array): ImageFacts | undefined {
  if (data.length < 10 || (!asciiAt(data, 0, 'GIF87a') && !asciiAt(data, 0, 'GIF89a'))) {
    return undefined
  }
  return positiveFacts('image/gif', u16le(data, 6), u16le(data, 8))
}

/**
 * WebP：RIFF 容器里的第一个块有三种编码，尺寸字段各不相同。
 * VP8X 是扩展格式（含 alpha/动画），画布尺寸是「实际尺寸 - 1」。
 */
function webpFacts(data: Uint8Array): ImageFacts | undefined {
  if (data.length < 30 || !asciiAt(data, 0, 'RIFF') || !asciiAt(data, 8, 'WEBP')) {
    return undefined
  }
  const payload = 20
  if (asciiAt(data, 12, 'VP8X')) {
    return positiveFacts('image/webp', u24le(data, payload + 4) + 1, u24le(data, payload + 7) + 1)
  }
  if (asciiAt(data, 12, 'VP8L')) {
    if (data[payload] !== 0x2f) {
      return undefined
    }
    const bits = u32le(data, payload + 1)
    return positiveFacts('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (asciiAt(data, 12, 'VP8 ')) {
    // 帧头 3 字节 + 起始码 0x9d 0x01 0x2a，随后是 14 位的宽高
    if (data[payload + 3] !== 0x9d || data[payload + 4] !== 0x01 || data[payload + 5] !== 0x2a) {
      return undefined
    }
    return positiveFacts(
      'image/webp',
      u16le(data, payload + 6) & 0x3fff,
      u16le(data, payload + 8) & 0x3fff
    )
  }
  return undefined
}

/** 宽高都必须是正数，否则当作识别失败 */
function positiveFacts(
  mediaType: ImageMediaType,
  width: number,
  height: number
): ImageFacts | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined
  }
  return { mediaType, width, height }
}

/**
 * 识别图片格式与尺寸。只接受模型端真正支持的四种格式。
 * @param data 文件字节（可以只给前 4 KB，头部已经够了）
 * @returns 格式与尺寸；不是受支持的图片时返回 undefined
 */
export function readImageFacts(data: Uint8Array): ImageFacts | undefined {
  if (data.length < 10) {
    return undefined
  }
  if (PNG_SIGNATURE.every((byte, index) => data[index] === byte)) {
    return pngFacts(data)
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return jpegFacts(data)
  }
  if (asciiAt(data, 0, 'GIF87a') || asciiAt(data, 0, 'GIF89a')) {
    return gifFacts(data)
  }
  if (asciiAt(data, 0, 'RIFF') && asciiAt(data, 8, 'WEBP')) {
    return webpFacts(data)
  }
  return undefined
}

/** 存储对象名要用的扩展名（按字节识别出的真实格式，不按文件名） */
export function extensionOfMediaType(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
  }
}
