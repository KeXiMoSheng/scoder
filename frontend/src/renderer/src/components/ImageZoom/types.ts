/** ImageZoom 组件的对外类型定义 */

/** 图片尺寸（原图像素） */
export interface ImageSize {
  width: number
  height: number
}

export interface ImageZoomProps {
  /** 图片地址：文件预览用 Blob URL，后续也可直接传 http(s) 地址 */
  src: string
  /** 无障碍替代文本 */
  alt: string
  /** 解码成功后回传原图尺寸（供状态栏展示） */
  onLoad?: (size: ImageSize) => void
  /** 解码失败：由调用方切换到兜底提示 */
  onError?: () => void
  /** 追加到根容器的类名（默认撑满父级的剩余空间） */
  className?: string
}
