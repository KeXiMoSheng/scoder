/**
 * 文件预览类型识别：按扩展名决定标签页是进文本编辑器还是走二进制预览。
 * 只收录浏览器（Chromium）能直接解码的格式；其余二进制（PDF、压缩包、可执行文件等）
 * 归为 binary，由预览页签提示不支持预览，避免被当作文本打开出现乱码。
 */

/** 预览类型：image/audio/video 走富预览，binary 只提示不支持预览 */
export type FilePreviewKind = 'image' | 'audio' | 'video' | 'binary'

/** 扩展名 → 预览类型与 MIME（MIME 决定 Blob 被浏览器如何解码） */
interface PreviewSpec {
  kind: FilePreviewKind
  mime: string
}

/** 二进制兜底类型：无法预览，预览页签直接提示不支持 */
const OCTET_STREAM: PreviewSpec = { kind: 'binary', mime: 'application/octet-stream' }

const PREVIEW_BY_EXTENSION: Record<string, PreviewSpec> = {
  // 图片
  png: { kind: 'image', mime: 'image/png' },
  apng: { kind: 'image', mime: 'image/apng' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  jpe: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  avif: { kind: 'image', mime: 'image/avif' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  ico: { kind: 'image', mime: 'image/x-icon' },
  // 音频
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  oga: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/ogg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  weba: { kind: 'audio', mime: 'audio/webm' },
  // 视频
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  ogv: { kind: 'video', mime: 'video/ogg' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  avi: { kind: 'video', mime: 'video/x-msvideo' },
  // 文档：不做内置渲染，打开后只提示不支持预览
  pdf: OCTET_STREAM,
  // 其它二进制：压缩包、可执行文件、字体、Office 文档等
  zip: OCTET_STREAM,
  jar: OCTET_STREAM,
  war: OCTET_STREAM,
  ear: OCTET_STREAM,
  apk: OCTET_STREAM,
  ipa: OCTET_STREAM,
  '7z': OCTET_STREAM,
  rar: OCTET_STREAM,
  tar: OCTET_STREAM,
  tgz: OCTET_STREAM,
  gz: OCTET_STREAM,
  bz2: OCTET_STREAM,
  xz: OCTET_STREAM,
  zst: OCTET_STREAM,
  iso: OCTET_STREAM,
  dmg: OCTET_STREAM,
  exe: OCTET_STREAM,
  msi: OCTET_STREAM,
  dll: OCTET_STREAM,
  so: OCTET_STREAM,
  dylib: OCTET_STREAM,
  o: OCTET_STREAM,
  a: OCTET_STREAM,
  lib: OCTET_STREAM,
  bin: OCTET_STREAM,
  dat: OCTET_STREAM,
  db: OCTET_STREAM,
  sqlite: OCTET_STREAM,
  sqlite3: OCTET_STREAM,
  wasm: OCTET_STREAM,
  class: OCTET_STREAM,
  pyc: OCTET_STREAM,
  pyo: OCTET_STREAM,
  whl: OCTET_STREAM,
  doc: OCTET_STREAM,
  docx: OCTET_STREAM,
  xls: OCTET_STREAM,
  xlsx: OCTET_STREAM,
  ppt: OCTET_STREAM,
  pptx: OCTET_STREAM,
  odt: OCTET_STREAM,
  ods: OCTET_STREAM,
  odp: OCTET_STREAM,
  ttf: OCTET_STREAM,
  otf: OCTET_STREAM,
  woff: OCTET_STREAM,
  woff2: OCTET_STREAM,
  eot: OCTET_STREAM,
  psd: OCTET_STREAM,
  ai: OCTET_STREAM,
  sketch: OCTET_STREAM,
  fig: OCTET_STREAM,
  blend: OCTET_STREAM,
  glb: OCTET_STREAM,
  heic: OCTET_STREAM,
  heif: OCTET_STREAM
}

/** 取小写扩展名（无扩展名时返回空串） */
function extensionOf(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex > 0 ? fileName.slice(dotIndex + 1).toLowerCase() : ''
}

/** 预览规格；未收录的扩展名返回 null（按文本编辑打开） */
function previewSpecOf(fileName: string): PreviewSpec | null {
  return PREVIEW_BY_EXTENSION[extensionOf(fileName)] ?? null
}

/** 文件应使用的预览类型；null 表示交给文本编辑器 */
export function previewKindOf(fileName: string): FilePreviewKind | null {
  return previewSpecOf(fileName)?.kind ?? null
}

/** 文件对应的 MIME 类型（用于构造 Blob 与展示）；未收录时为 application/octet-stream */
export function previewMimeOf(fileName: string): string {
  return previewSpecOf(fileName)?.mime ?? 'application/octet-stream'
}

/** 是否需要以预览页签（而非文本编辑器）打开 */
export function isPreviewFile(fileName: string): boolean {
  return previewSpecOf(fileName) !== null
}
