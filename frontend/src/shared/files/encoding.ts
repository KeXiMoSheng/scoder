/**
 * 文本编码标识与 VS Code 风格的编码清单。
 *
 * 主进程按 {@link TextEncodingSpec.charset} 交给 iconv-lite 编解码；
 * 渲染进程只用 id 与 label 做展示与选择。BOM 是文件的编码标记，不进入文本内容，
 * 保存时由编码 id 决定是否写出（UTF-16 的带 BOM / 不带 BOM 是两个独立选项）。
 */

/** 支持的编码 id（UTF-16 的 BOM 变体与无 BOM 变体分开，与 VS Code 一致） */
export type TextEncodingId =
  | 'utf-8'
  | 'utf-8-bom'
  | 'utf-16le'
  | 'utf-16le-bom'
  | 'utf-16be'
  | 'utf-16be-bom'
  | 'gbk'
  | 'gb18030'
  | 'big5'
  | 'shift-jis'
  | 'euc-kr'
  | 'windows-1252'
  | 'iso-8859-1'

/** BOM 种类：保存时据此写出文件头字节 */
export type TextBomKind = 'utf-8' | 'utf-16le' | 'utf-16be'

/** 一种编码的展示名、iconv 字符集与保存时的 BOM 策略 */
export interface TextEncodingSpec {
  id: TextEncodingId
  /** 状态栏与菜单里的展示名（与 VS Code 的英文编码名对齐） */
  label: string
  /** iconv-lite 的字符集名 */
  charset: string
  /** 保存时写出的 BOM；null 表示不写 */
  bom: TextBomKind | null
}

/**
 * 自动识别的候选编码：按可能性从高到低排列。
 * 第一条是打开文件时实际采用的编码，其余是 jschardet 给出的备选。
 */
export interface EncodingCandidate {
  encoding: TextEncodingId
  /** 0–1 的置信度；BOM 与合法 UTF-8 这类规则判定为 1 */
  confidence: number
}

/**
 * 编码菜单：先 Unicode，再中日韩遗留编码，最后西欧单字节。
 * 遗留编码使用兼容超集（Shift JIS → CP932、EUC-KR → CP949），
 * 这样自动识别出的字节序列可以原样写回。
 */
export const TEXT_ENCODINGS: readonly TextEncodingSpec[] = [
  { id: 'utf-8', label: 'UTF-8', charset: 'utf8', bom: null },
  { id: 'utf-8-bom', label: 'UTF-8 with BOM', charset: 'utf8', bom: 'utf-8' },
  { id: 'utf-16le', label: 'UTF-16 LE', charset: 'utf16le', bom: null },
  { id: 'utf-16le-bom', label: 'UTF-16 LE with BOM', charset: 'utf16le', bom: 'utf-16le' },
  { id: 'utf-16be', label: 'UTF-16 BE', charset: 'utf16be', bom: null },
  { id: 'utf-16be-bom', label: 'UTF-16 BE with BOM', charset: 'utf16be', bom: 'utf-16be' },
  { id: 'gbk', label: 'GBK', charset: 'gbk', bom: null },
  { id: 'gb18030', label: 'GB18030', charset: 'gb18030', bom: null },
  { id: 'big5', label: 'Big5', charset: 'big5', bom: null },
  { id: 'shift-jis', label: 'Shift JIS', charset: 'cp932', bom: null },
  { id: 'euc-kr', label: 'EUC-KR', charset: 'cp949', bom: null },
  { id: 'windows-1252', label: 'Windows 1252', charset: 'windows1252', bom: null },
  { id: 'iso-8859-1', label: 'ISO 8859-1', charset: 'iso88591', bom: null }
]

/** 默认编码：无法判定或参数非法时一律按 UTF-8 */
const UTF8_SPEC = TEXT_ENCODINGS[0]

const SPECS_BY_ID = new Map(TEXT_ENCODINGS.map((spec) => [spec.id, spec]))

/** 取编码规格；未知 id 回退 UTF-8（调用方应先用 {@link isTextEncodingId} 校验入参） */
export function encodingSpec(id: TextEncodingId): TextEncodingSpec {
  return SPECS_BY_ID.get(id) ?? UTF8_SPEC
}

/** 编码的展示名 */
export function encodingLabel(id: TextEncodingId): string {
  return encodingSpec(id).label
}

/** 是否为受支持的编码 id（IPC 入参必须经过这道校验） */
export function isTextEncodingId(value: unknown): value is TextEncodingId {
  return typeof value === 'string' && SPECS_BY_ID.has(value as TextEncodingId)
}

/** 是否 UTF-16 系列：这类文件里的 NUL 是内容字节，不能作为二进制信号 */
export function isUtf16Encoding(id: TextEncodingId | undefined): boolean {
  const spec = id === undefined ? undefined : SPECS_BY_ID.get(id)
  return spec !== undefined && spec.charset.startsWith('utf16')
}
