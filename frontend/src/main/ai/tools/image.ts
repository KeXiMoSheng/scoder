/**
 * read_image 工具：把工作区里的一张图片直接交给模型看。
 *
 * 与 read 的分工：read 只处理文本，二进制文件一律拒绝；图片走这条独立通道，
 * 因为「看一眼」和「读内容」在模型端是两种不同的输入。
 *
 * 流程：解析路径（工作区边界由 fs.resolve 保证）→ 读字节 → 读文件头识别格式与尺寸
 * → 按限额缩小/重编码 → 落进内容寻址的图片存储 → 返回说明文字 + 图片引用。
 * 图片本身由循环在工具结果之后作为一条图片消息发给模型（见 agentLoop.writeToolResult），
 * 工具本身只负责把它准备好。
 */
import { MAX_SOURCE_BYTES, formatBytes, prepareImageForModel } from '../images/prepare'
import { readImageFacts } from '../images/probe'
import { saveToolImage } from '../images/store'
import type { ToolImageRef } from '../images/types'
import { requireString, type ToolDefinition } from './registry'

/**
 * 给模型看的图片说明：路径、格式、实际发送的尺寸与体积。
 * 被缩小过时点名原图尺寸与换算倍数 —— 模型据坐标去改文件（例如 CSS 里的元素位置）
 * 时需要把图上的坐标映射回原图。
 */
function formatImageEnvelope(sourcePath: string, image: ToolImageRef): string {
  const parts = [
    `${image.mediaType} 图片，${image.width}×${image.height} px，${formatBytes(image.bytes)}`
  ]
  if (image.originalWidth !== undefined && image.originalHeight !== undefined) {
    const scaled = image.originalWidth !== image.width || image.originalHeight !== image.height
    if (scaled) {
      const x = (image.originalWidth / image.width).toFixed(2)
      const y = (image.originalHeight / image.height).toFixed(2)
      parts.push(
        x === y
          ? `已从 ${image.originalWidth}×${image.originalHeight} 缩小；在原图上定位特征时把坐标乘以 ${x}`
          : `已从 ${image.originalWidth}×${image.originalHeight} 缩小；在原图上定位特征时 x 坐标乘以 ${x}、y 坐标乘以 ${y}`
      )
    }
    if (image.originalMediaType !== undefined && image.originalMediaType !== image.mediaType) {
      parts.push(`原格式 ${image.originalMediaType}，为控制体积已重新编码`)
    }
  }
  return `<path>${sourcePath}</path>
<type>image</type>
<content>
${parts.join('；')}
</content>`
}

/**
 * 注册 read_image。
 * 工具声明了 requiresVision：模型不可看图时不会出现在工具列表里（见 capabilities.ts），
 * 直接调用也会在执行期被拒绝 —— 两道门禁缺一不可，否则文本模型会白调一次。
 */
export function createReadImageTool(): ToolDefinition {
  return {
    name: 'read_image',
    description:
      '读取工作区内的 PNG/JPEG/WebP/GIF 图片并直接查看图片本身。' +
      `单张源文件上限 ${formatBytes(MAX_SOURCE_BYTES)}，大图会自动缩小后发送。` +
      '要看图片内容时用这个工具，不要用 bash 或图像库自己解码、生成缩略图。',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '图片路径，相对于工作区根；也可以给工作区内的绝对路径。'
        }
      },
      required: ['file_path'],
      additionalProperties: false
    },
    requiresVision: true,
    async execute(args, ctx) {
      if (!ctx.supportsVision) {
        throw new Error('当前模型不支持图片输入，无法查看图片；请换用能看图的模型后再读')
      }
      const filePath = requireString(args, 'file_path')
      const target = await ctx.fs.resolve(filePath, ctx.cwd)
      const info = await ctx.fs.stat(target)
      if (!info) {
        throw new Error(`文件不存在：${filePath}`)
      }
      if (info.type !== 'file') {
        throw new Error(`不是文件：${filePath}`)
      }
      if (info.size > MAX_SOURCE_BYTES) {
        throw new Error(
          `图片 ${filePath} 有 ${formatBytes(info.size)}，超过单张 ${formatBytes(MAX_SOURCE_BYTES)} 的上限；请先缩小后再读`
        )
      }
      const data = await ctx.fs.readBytes(target, MAX_SOURCE_BYTES)
      // 格式以字节为准：扩展名写错（.png 里其实是 JPEG）时按真实格式处理
      const facts = readImageFacts(data)
      if (!facts) {
        throw new Error(
          `不是受支持的图片格式（PNG/JPEG/WebP/GIF）：${target.displayPath}；如果它其实是文本，用 read`
        )
      }
      const prepared = prepareImageForModel(data, facts)
      const image = await saveToolImage(prepared, target.displayPath)
      return { text: formatImageEnvelope(target.displayPath, image), image }
    },
    presentCall(args) {
      const path = typeof args.file_path === 'string' ? args.file_path : undefined
      return {
        kind: 'image',
        title: '查看图片',
        ...(path !== undefined && path.length > 0 ? { path } : {})
      }
    },
    presentResult(_args, outcome) {
      const image = outcome.image
      if (!image) {
        return undefined
      }
      return {
        kind: 'image',
        title: '查看图片',
        path: image.sourcePath,
        image: {
          mediaType: image.mediaType,
          width: image.width,
          height: image.height,
          bytes: image.bytes
        }
      }
    }
  }
}
