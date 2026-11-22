/**
 * 图片对象存储：内容寻址，放在 userData 下，与会话日志分开。
 *
 * 会话日志里只留 {@link ToolImageRef}：对象名、摘要、格式与尺寸。
 * 这样一份 jsonl 不会因为贴了几张截图就涨到几十 MB，
 * 而历史重放时又能按摘要把同一张图取回来 —— 模型看到的就是当初那张图，
 * 即使工作区里的源文件后来被改了、删了。
 *
 * 对象只增不删：同一张图（同一份字节）全局只存一份，被多个会话共享。
 */
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { link, mkdir, readFile, rename, rm, writeFile, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { app } from 'electron'
import { extensionOfMediaType } from './probe'
import type { ImageMediaType, ToolImageRef } from './types'

/** 存储根目录名（位于 Electron userData 下） */
export const IMAGE_STORE_DIR_NAME = 'ai-images'

/** 对象名白名单：目录 + 两位前缀 + 摘要 + 扩展名；日志内容按不可信输入校验 */
const STORE_NAME_PATTERN = /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\.(?:png|jpg|webp|gif)$/

/** 存储根目录：延迟到首次使用才求值，避免模块加载期就依赖 app 是否就绪 */
function storeRoot(): string {
  return join(app.getPath('userData'), IMAGE_STORE_DIR_NAME)
}

/** 字节的 sha256（十六进制） */
function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 对象在磁盘上的绝对路径；对象名非法时抛错，挡住日志里被手改出来的越界路径 */
export function toolImagePath(storeName: string): string {
  if (!STORE_NAME_PATTERN.test(storeName)) {
    throw new Error(`图片对象名无效：${storeName}`)
  }
  return join(storeRoot(), storeName)
}

/** 对象名：摘要前两位做目录，避免单目录塞进上万张图 */
function storeNameOf(sha256: string, mediaType: ImageMediaType): string {
  return `objects/${sha256.slice(0, 2)}/${sha256}${extensionOfMediaType(mediaType)}`
}

/**
 * 把一张准备好的图片写进对象存储（已存在则直接复用）。
 * @param image 编码后的字节、格式与尺寸
 * @param sourcePath 源图片在工作区内的展示路径
 * @param original 源图事实：被缩小或重编码时传入
 * @returns 可以写进会话日志的图片引用
 */
export async function saveToolImage(
  image: {
    data: Uint8Array
    mediaType: ImageMediaType
    width: number
    height: number
    source?: { mediaType: ImageMediaType; width: number; height: number }
  },
  sourcePath: string
): Promise<ToolImageRef> {
  const sha256 = digest(image.data)
  const storeName = storeNameOf(sha256, image.mediaType)
  const target = toolImagePath(storeName)
  const exists = await stat(target).then(
    (info) => info.isFile() && info.size === image.data.byteLength,
    () => false
  )
  if (!exists) {
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    try {
      await writeFile(temporary, image.data, { mode: 0o600 })
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const ref: ToolImageRef = {
    storeName,
    sha256,
    mediaType: image.mediaType,
    width: image.width,
    height: image.height,
    bytes: image.data.byteLength,
    sourcePath,
    ...(image.source === undefined
      ? {}
      : {
          originalWidth: image.source.width,
          originalHeight: image.source.height,
          originalMediaType: image.source.mediaType
        })
  }
  await ensurePreviewAlias(ref)
  return ref
}

/**
 * 预览别名：`pasted/<摘要前八位>/<展示名>`，硬链接到同一个对象。
 * 内容的身份仍然是摘要（去重不受影响），但点开时编辑器页签显示可读名字，
 * 而不是一长串 sha256。
 * @param ref 已发布的图片引用
 */
async function ensurePreviewAlias(ref: ToolImageRef): Promise<void> {
  const alias = previewAliasPath(ref)
  try {
    await mkdir(dirname(alias), { recursive: true })
    try {
      await link(toolImagePath(ref.storeName), alias)
    } catch (error) {
      // 别名已存在（同一张图第二次入库）时保留原样
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } catch (error) {
    // 别名只决定页签名字，失败不该让这一轮消息失败
    console.warn('创建图片预览别名失败', error)
  }
}

/** 预览别名的绝对路径；名字由摘要与展示名共同决定，随时可从引用重算 */
function previewAliasPath(ref: ToolImageRef): string {
  return join(storeRoot(), 'pasted', ref.sha256.slice(0, 8), aliasNameOf(ref))
}

/** 别名文件名：展示名去扩展名后按真实格式补齐，并挡掉路径分隔符与控制字符 */
function aliasNameOf(ref: ToolImageRef): string {
  const slash = Math.max(ref.sourcePath.lastIndexOf('/'), ref.sourcePath.lastIndexOf('\\'))
  const leaf = ref.sourcePath.slice(slash + 1)
  const stem = leaf
    .replace(/\.[^.]+$/u, '')
    .replace(/[<>:"/\\|?*]|\p{Cc}/gu, '')
    .trim()
    .slice(0, 40)
  return `${stem.length > 0 ? stem : 'image'}${extensionOfMediaType(ref.mediaType)}`
}

/**
 * 点开一张历史图片时应该打开的文件：
 * 优先用带展示名的别名（页签可读），别名缺失时退回内容寻址的对象本体。
 * @param ref 会话日志里的图片引用
 * @returns 绝对路径；引用非法且没有别名时返回 undefined
 */
export function toolImagePreviewPath(ref: ToolImageRef): string | undefined {
  const alias = previewAliasPath(ref)
  if (existsSync(alias)) {
    return alias
  }
  try {
    return toolImagePath(ref.storeName)
  } catch {
    return undefined
  }
}

/**
 * 按引用读回图片字节并校验摘要。
 * @param ref 会话日志里的图片引用
 * @returns 校验通过的字节；对象缺失或摘要不符时返回 undefined
 */
export async function readToolImageBytes(ref: ToolImageRef): Promise<Uint8Array | undefined> {
  let path: string
  try {
    path = toolImagePath(ref.storeName)
  } catch {
    return undefined
  }
  const data = await readFile(path).catch(() => undefined)
  if (data === undefined || digest(data) !== ref.sha256) {
    return undefined
  }
  return data
}

/** 图片字节 → OpenAI 兼容接口能直接吃的 data URL */
export function imageDataUrl(data: Uint8Array, mediaType: ImageMediaType): string {
  return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
}

/**
 * 按引用读回图片并转成 data URL，供历史重放拼装请求。
 * 对象缺失或损坏时返回 undefined：历史退化成「只有文字说明」，不让整轮请求失败。
 * @param ref 会话日志里的图片引用
 */
export async function readToolImageDataUrl(ref: ToolImageRef): Promise<string | undefined> {
  const data = await readToolImageBytes(ref)
  return data === undefined ? undefined : imageDataUrl(data, ref.mediaType)
}
