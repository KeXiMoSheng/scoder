/**
 * 图片能力的数据模型：只在本进程内流转，渲染进程不需要看到图片字节。
 *
 * 与会话日志的关系：`tool/result` 事件只保存 {@link ToolImageRef} 这份引用
 * （内容寻址的对象名 + 元信息），图片字节落在 userData 的独立目录里。
 * 这样会话 jsonl 不会因为贴了一张截图就膨胀，历史重放时再按引用读回字节。
 */

/** 允许读取与发送的图片格式：与 OpenAI 兼容接口的图片输入一致 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** 从字节里识别出的图片事实 */
export interface ImageFacts {
  mediaType: ImageMediaType
  /** 编码后的宽（像素） */
  width: number
  /** 编码后的高（像素） */
  height: number
}

/**
 * 一张已经落盘、可以直接放进模型请求的图片。
 * 只记相对存储根的对象名，不记绝对路径：日志可以被导出到别的机器上打开。
 */
export interface ToolImageRef {
  /** 存储对象名，形如 objects/ab/<sha256>.png */
  storeName: string
  /** 对象字节的 sha256（十六进制） */
  sha256: string
  mediaType: ImageMediaType
  /** 实际发出去的尺寸（被缩小过时是缩小后的值） */
  width: number
  height: number
  bytes: number
  /** 源图片在工作区内的展示路径（相对工作区根），供卡片跳转与提示 */
  sourcePath: string
  /** 原图尺寸：只有被缩小/重编码过时才有 */
  originalWidth?: number
  originalHeight?: number
  /** 原图格式：只有被重编码成别的格式时才有 */
  originalMediaType?: ImageMediaType
}
