import { useEffect, useState } from 'react'
import ImageZoom from '../ImageZoom'
import { previewKindOf, previewMimeOf } from '../../lib/filePreview'
import type { FilePreviewKind } from '../../lib/filePreview'
import { extractErrorMessage } from '../../lib/errorMessage'
import type { FilePreviewProps, MediaViewProps, PreviewLoadState } from './types'

/** 预览类型在状态栏上的中文名 */
const KIND_LABELS: Record<FilePreviewKind, string> = {
  image: '图片',
  audio: '音频',
  video: '视频',
  binary: '二进制文件'
}

/** 人类可读的文件体积（B / KB / MB / GB） */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

/** 时长（秒）格式化为 m:ss；无效值返回空串 */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return ''
  }
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 图片 / 音频 / 视频：原始字节包成 Blob URL 后交给对应的查看器解码与播放 */
function MediaView({ kind, name, mime, data, setDetail }: MediaViewProps): React.JSX.Element {
  // 对象 URL 必须在 effect 里创建、由该 effect 的清理函数撤销：
  // 开发态的 StrictMode 会「挂载 → 卸载 → 再挂载」，若在渲染期（useState 初始化器）创建，
  // 这次卸载的清理会立刻撤销**正在播放**的 URL——图片多半已解码完看不出问题，
  // 音视频则播到已缓冲的几秒后卡死在 waiting（Blob 数据已释放，后续字节读不出来）。
  // 换成「渲染期创建 + 延迟释放」（参见 SvgPreview）也能绕过，但每次挂载都要多留一份整块字节，
  // 音视频动辄几十 MB，不划算，因此这里显式关掉针对同步 setState 的检查。
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    // 组件按文件重建（调用方以路径作 key），data/mime 在一次挂载期间不变，URL 只建一次
    const objectUrl = URL.createObjectURL(new Blob([data], { type: mime }))
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 见上方注释：URL 只能由 effect 产出
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [data, mime])

  if (failed) {
    return (
      <p className="m-auto max-w-[360px] p-6 text-center leading-[1.6] text-dim">
        当前运行环境无法解码该{KIND_LABELS[kind]}（{mime}）
      </p>
    )
  }

  // 对象 URL 在首帧渲染后由 effect 建好，这一帧先占位，避免尺寸/时长回填前界面跳动
  if (url === null) {
    return <div className="min-h-0 flex-1" />
  }

  if (kind === 'image') {
    // 图片交给可缩放的查看器：滚轮缩放、拖动平移、双击复位，尺寸回填到状态栏
    return (
      <ImageZoom
        src={url}
        alt={name}
        onLoad={(size) => setDetail(`${size.width} × ${size.height}`)}
        onError={() => setFailed(true)}
      />
    )
  }

  if (kind === 'audio') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <audio
          src={url}
          controls
          className="w-full max-w-[560px]"
          onLoadedMetadata={(event) => {
            setDetail(formatDuration(event.currentTarget.duration))
          }}
          onError={() => setFailed(true)}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <video
        src={url}
        controls
        className="max-h-full max-w-full rounded-sm bg-black"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget
          const duration = formatDuration(video.duration)
          setDetail(
            [`${video.videoWidth} × ${video.videoHeight}`, duration].filter(Boolean).join(' · ')
          )
        }}
        onError={() => setFailed(true)}
      />
    </div>
  )
}

/**
 * 二进制文件预览页签：图片走可缩放的查看器，音视频交给浏览器原生控件；
 * 其它二进制（PDF、压缩包、可执行文件等）不做预览，只提示不支持。
 * 文本文件不经过这里（由 CodeEditor 打开）。
 */
export default function FilePreview({ file }: FilePreviewProps): React.JSX.Element {
  const kind = previewKindOf(file.name) ?? 'binary'
  const mime = previewMimeOf(file.name)
  const [state, setState] = useState<PreviewLoadState>(() =>
    kind === 'binary' ? { status: 'unsupported' } : { status: 'loading' }
  )
  // 尺寸/时长等由具体子视图回填，展示在底部状态栏
  const [detail, setDetail] = useState<string | null>(null)

  useEffect(() => {
    // 不支持预览的二进制不读内容，与旧行为一致直接提示
    if (kind === 'binary') {
      return
    }
    let cancelled = false
    window.api.readFileBytes(file.path).then(
      (data) => {
        if (!cancelled) {
          setState({ status: 'ready', data })
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: extractErrorMessage(reason) })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [file.path, kind])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {state.status === 'unsupported' ? (
          <p className="m-auto max-w-[420px] p-6 text-center leading-[1.6] text-dim">
            二进制文件暂不支持预览
          </p>
        ) : null}
        {state.status === 'loading' ? <p className="m-auto text-dim">正在读取文件…</p> : null}
        {state.status === 'error' ? (
          <p className="m-auto max-w-[420px] p-6 text-center leading-[1.6] text-dim">
            {state.message}
          </p>
        ) : null}
        {state.status === 'ready' && kind !== 'binary' ? (
          <MediaView
            kind={kind}
            name={file.name}
            mime={mime}
            data={state.data}
            setDetail={setDetail}
          />
        ) : null}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-2 overflow-hidden border-t border-line bg-elevated px-3 text-[11px] text-dim">
        <span className="shrink-0">{KIND_LABELS[kind]}</span>
        {state.status === 'ready' ? (
          <span className="shrink-0">· {formatFileSize(state.data.length)}</span>
        ) : null}
        {detail ? <span className="truncate">· {detail}</span> : null}
        <span className="ml-auto shrink-0 truncate" title={file.path}>
          {mime}
        </span>
      </div>
    </div>
  )
}
