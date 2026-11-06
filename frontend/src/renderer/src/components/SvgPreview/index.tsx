import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import type { SvgPreviewProps } from './types'

/**
 * SVG 源码预览：把源码包成 Blob URL 交给 <img> 渲染。
 * 不使用 dangerouslySetInnerHTML 内联：<img> 中的 SVG 不会执行脚本、也不会加载外部资源，
 * 打开来源不明的仓库文件同样安全。
 */
export default function SvgPreview({ content, className }: SvgPreviewProps): React.JSX.Element {
  // 内容变化时重建对象 URL
  const url = useMemo(
    () => URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' })),
    [content]
  )
  // 解析失败的 URL：按 URL 归属，内容变化后自动恢复成图片
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  // 当前仍在使用的对象 URL（供延迟释放时判断是否已被重新挂载复用）
  const activeUrlRef = useRef<string | null>(null)

  useEffect(() => {
    activeUrlRef.current = url
    return () => {
      activeUrlRef.current = null
      // 延迟到下一轮事件循环再释放：StrictMode 开发模式会在挂载后立即「卸载 → 重新挂载」，
      // 若在这里同步 revoke，重新挂载的 <img> 会因 URL 已失效而加载失败（表现为「SVG 解析失败」）；
      // 期间若同一 URL 又被挂载回来（ref 指回它），就跳过释放。
      window.setTimeout(() => {
        if (activeUrlRef.current !== url) {
          URL.revokeObjectURL(url)
        }
      }, 0)
    }
  }, [url])

  const blank = content.trim() === ''

  return (
    <div
      className={cn(
        'flex min-h-0 items-center justify-center overflow-auto bg-base p-6',
        className
      )}
    >
      {blank ? null : failedUrl === url ? (
        <p className="m-0 max-w-[420px] text-center leading-[1.6] text-dim">
          SVG 解析失败，请检查标签是否闭合或语法是否正确
        </p>
      ) : (
        // 默认按 SVG 声明的原始尺寸显示，只在超出预览区时才等比缩小
        <img
          src={url}
          alt="SVG 预览"
          draggable={false}
          className="max-h-full max-w-full object-contain"
          onError={() => setFailedUrl(url)}
        />
      )}
    </div>
  )
}
