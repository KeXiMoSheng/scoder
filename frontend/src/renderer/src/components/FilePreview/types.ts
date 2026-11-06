/** FilePreview 组件的对外类型定义 */

import type { OpenedFile } from '../../hooks/useOpenedFiles'
import type { FilePreviewKind } from '../../lib/filePreview'

/** 浏览器可自带控件的三类富预览（其余类型提示不支持预览） */
export type MediaPreviewKind = Exclude<FilePreviewKind, 'binary'>

export interface FilePreviewProps {
  /** 当前激活的预览文件（由标签栏切换，调用方以路径作 key 保证切换时重建） */
  file: OpenedFile
}

/** 预览内容加载状态：不支持预览 / 读取中 / 已就绪 / 失败 */
export type PreviewLoadState =
  | { status: 'unsupported' }
  | { status: 'loading' }
  | { status: 'ready'; data: Uint8Array<ArrayBuffer> }
  | { status: 'error'; message: string }

/** 底部状态栏详情的写入口（尺寸、时长等由具体预览子视图回填） */
export type PreviewDetailSetter = (detail: string) => void

export interface MediaViewProps {
  /** 图片 / 音频 / 视频 */
  kind: MediaPreviewKind
  /** 文件名（图片 alt 与无障碍标签） */
  name: string
  /** 构造 Blob 的 MIME，决定浏览器用哪个解码器 */
  mime: string
  /** 文件原始字节 */
  data: Uint8Array<ArrayBuffer>
  setDetail: PreviewDetailSetter
}
