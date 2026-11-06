import { useEffect, useState } from 'react'
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

/** 图片 / 音频 / 视频：原始字节包成 Blob URL，交给浏览器原生控件解码与播放 */
function MediaView({ kind, name, mime, data, setDetail }: MediaViewProps): React.JSX.Element {
  // 组件按文件重建（调用方以路径作 key），初始化时创建一次对象 URL 即可
  const [url] = useState(() => URL.createObjectURL(new Blob([data], { type: mime })))
  const [failed, setFailed] = useState(false)

  useEffect(() => () => URL.revokeObjectURL(url), [url])

  if (failed) {
    return (
      <p className="m-0 max-w-[360px] text-center leading-[1.6] text-dim">
        当前运行环境无法解码该{KIND_LABELS[kind]}（{mime}）
      </p>
    )
  }

  if (kind === 'image') {
    return (
      <img
        src={url}
        alt={name}
        className="max-h-full max-w-full object-contain"
        draggable={false}
        onLoad={(event) => {
          const image = event.currentTarget
          setDetail(`${image.naturalWidth} × ${image.naturalHeight}`)
        }}
        onError={() => setFailed(true)}
      />
    )
  }

  if (kind === 'audio') {
    return (
      <audio
        src={url}
        controls
        className="w-full max-w-[560px]"
        onLoadedMetadata={(event) => {
          setDetail(formatDuration(event.currentTarget.duration))
        }}
        onError={() => setFailed(true)}
      />
    )
  }

  return (
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
  )
}

/**
 * 二进制文件预览页签：图片/音视频交给浏览器原生控件；
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
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
            <MediaView
              kind={kind}
              name={file.name}
              mime={mime}
              data={state.data}
              setDetail={setDetail}
            />
          </div>
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
