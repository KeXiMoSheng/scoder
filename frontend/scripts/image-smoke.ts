/**
 * 图片探测冒烟测试：验证 read_image 的格式识别与尺寸解析。
 *
 * 与 test:theme / test:mcp 同样的理由：项目没有前端测试运行器，
 * 用 rolldown 把纯函数模块打成 CJS 后直接跑（见 package.json 的 test:image）。
 * probe.ts 刻意不依赖 Electron，所以能在普通 node 里跑；
 * 缩放与重编码依赖 nativeImage，只能在应用里验证。
 */

import { extensionOfMediaType, readImageFacts } from '../src/main/ai/images/probe'

/** 断言失败即退出 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exit(1)
  }
  console.log(`✓ ${message}`)
}

/** 用数字数组拼字节，测试里比 Buffer 直观 */
function bytes(values: readonly number[]): Uint8Array {
  return new Uint8Array(values)
}

/** 拼接多段字节 */
function concat(...chunks: readonly (readonly number[])[]): Uint8Array {
  return new Uint8Array(chunks.flat())
}

/** 大端 32 位 */
function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

/** 大端 16 位 */
function u16be(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff]
}

/** 小端 16 位 */
function u16le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff]
}

/** 小端 24 位 */
function u24le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]
}

/** 小端 32 位 */
function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

/** ASCII 文本拆成字节 */
function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0))
}

/** PNG 头部：签名 + IHDR + 宽高 */
function png(width: number, height: number): Uint8Array {
  return bytes(
    concat(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      [0, 0, 0, 13],
      ascii('IHDR'),
      u32be(width),
      u32be(height),
      [8, 6, 0, 0, 0]
    )
  )
}

/** GIF 头部：版本 + 逻辑屏幕宽高 */
function gif(width: number, height: number): Uint8Array {
  return bytes(concat(ascii('GIF89a'), u16le(width), u16le(height), [0, 0, 0]))
}

/** JPEG：APP0 段（应被跳过）之后是 SOF0 */
function jpeg(width: number, height: number): Uint8Array {
  return bytes(
    concat(
      // SOI
      [0xff, 0xd8],
      // APP0：长度 4，2 字节负载
      [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46],
      // 注释段：长度 3，1 字节负载
      [0xff, 0xfe, 0x00, 0x03, 0x41],
      // SOF0：长度 11，精度 8，宽高，1 个分量
      [0xff, 0xc0],
      u16be(11),
      [8],
      u16be(height),
      u16be(width),
      [1, 1, 0x11, 0],
      // EOI
      [0xff, 0xd9]
    )
  )
}

/** WebP 扩展格式（VP8X）：画布尺寸是实际尺寸减一 */
function webpExtended(width: number, height: number): Uint8Array {
  const payload = concat([0x10, 0, 0, 0], u24le(width - 1), u24le(height - 1))
  return bytes(
    concat(
      ascii('RIFF'),
      u32le(payload.length + 4),
      ascii('WEBP'),
      ascii('VP8X'),
      u32le(payload.length),
      [...payload],
      [0, 0] // 填充：真实文件里还有后续块
    )
  )
}

/** WebP 无损格式（VP8L）：14 位宽高打包在一个 32 位小端整数里 */
function webpLossless(width: number, height: number): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14)
  const payload = concat([0x2f], u32le(bits), [0, 0, 0, 0])
  return bytes(
    concat(
      ascii('RIFF'),
      u32le(payload.length + 4),
      ascii('WEBP'),
      ascii('VP8L'),
      u32le(payload.length),
      [...payload],
      [0, 0]
    )
  )
}

/** WebP 有损格式（VP8 ）：帧头 + 起始码 + 14 位宽高 */
function webpLossy(width: number, height: number): Uint8Array {
  const payload = concat(
    [0x00, 0x00, 0x00],
    [0x9d, 0x01, 0x2a],
    u16le(width),
    u16le(height),
    [0, 0]
  )
  return bytes(
    concat(
      ascii('RIFF'),
      u32le(payload.length + 4),
      ascii('WEBP'),
      ascii('VP8 '),
      u32le(payload.length),
      [...payload],
      [0, 0]
    )
  )
}

// —— PNG ——
const pngFacts = readImageFacts(png(1280, 720))
assert(pngFacts?.mediaType === 'image/png', 'PNG 识别为 image/png')
assert(pngFacts?.width === 1280 && pngFacts?.height === 720, 'PNG 尺寸来自 IHDR')

// —— GIF ——
const gifFacts = readImageFacts(gif(320, 200))
assert(gifFacts?.mediaType === 'image/gif', 'GIF 识别为 image/gif')
assert(gifFacts?.width === 320 && gifFacts?.height === 200, 'GIF 尺寸来自逻辑屏幕描述符')

// —— JPEG ——
const jpegFacts = readImageFacts(jpeg(1920, 1080))
assert(jpegFacts?.mediaType === 'image/jpeg', 'JPEG 识别为 image/jpeg')
assert(
  jpegFacts?.width === 1920 && jpegFacts?.height === 1080,
  'JPEG 跳过 APP0/注释段后从 SOF0 取尺寸'
)

// —— WebP 三种编码 ——
const vp8xFacts = readImageFacts(webpExtended(800, 600))
assert(vp8xFacts?.width === 800 && vp8xFacts?.height === 600, 'WebP VP8X 画布尺寸 +1 还原')
const vp8lFacts = readImageFacts(webpLossless(1024, 768))
assert(vp8lFacts?.width === 1024 && vp8lFacts?.height === 768, 'WebP VP8L 位域解出宽高')
const vp8Facts = readImageFacts(webpLossy(640, 480))
assert(vp8Facts?.width === 640 && vp8Facts?.height === 480, 'WebP VP8 有损帧头解出宽高')

// —— 拒绝非法输入 ——
assert(readImageFacts(bytes(ascii('hello world, not an image'))) === undefined, '文本被拒绝')
assert(readImageFacts(bytes([])) === undefined, '空字节被拒绝')
assert(readImageFacts(png(1280, 720).slice(0, 16)) === undefined, '截断的 PNG 被拒绝')
assert(readImageFacts(jpeg(100, 100).slice(0, 10)) === undefined, '截断的 JPEG 被拒绝')
// PNG 签名正确但 IHDR 不是第一个块：按「不是受支持的图片」处理，不猜
assert(
  readImageFacts(bytes(concat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ascii('XXXX')))) ===
    undefined,
  '缺少 IHDR 的 PNG 被拒绝'
)
// 尺寸为 0 的图片没有意义
assert(readImageFacts(png(0, 720)) === undefined, '宽度为 0 的 PNG 被拒绝')

// —— 存储对象名用真实格式的扩展名 ——
assert(extensionOfMediaType('image/webp') === '.webp', '存储对象用识别出的真实格式命名')
assert(extensionOfMediaType('image/jpeg') === '.jpg', 'JPEG 统一落成 .jpg')

console.log('\n图片探测冒烟测试全部通过')
