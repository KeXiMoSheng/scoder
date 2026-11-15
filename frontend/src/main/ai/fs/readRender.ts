/**
 * 读取窗口的纯渲染层：把解码后的文本块切成有界、带行号的窗口，
 * 再渲染成模型可见的 XML 包裹文本。
 *
 * 语义与 deepseek-harness 的 `tool-fs` 对齐：
 * - 单行超过上限即截断，且行缓冲只保留上限 + 1 个字符，
 *   因此一行没有换行的巨型文件也不会把内存撑大；
 * - 命中单次输出字节上限后不再收集内容，但仍扫描到文件末尾，
 *   以便返回精确的 totalLines 供模型续读；
 * - offset 落在文件末尾之后视为参数错误，而不是静默返回空窗口。
 */

/** 单行返回上限（字符）：压缩产物、base64 这类超长行会挤占整个上下文 */
export const READ_MAX_LINE_LENGTH = 2000

/** 单次读取的输出字节上限：命中即截断，模型用 offset 续读 */
export const READ_MAX_BYTES = 50 * 1024

/** 单次调用的行数默认值与上限（对应 harness 的 readLimit） */
export const READ_LIMIT = 2000

/** 大文件阈值：不小于该值的文件走流式扫描，避免整份内容读进主进程内存 */
export const READ_STREAM_MIN_SIZE = 10 * 1024 * 1024

/** 窗口中的一行 */
export interface FsLine {
  /** 文件内的行号（1 起） */
  number: number
  /** 不含行尾换行的行文本 */
  text: string
}

/** 一次读取窗口的解析参数 */
export interface ReadWindowRequest {
  /** 起始行号（1 起） */
  offset: number
  /** 最多返回的行数 */
  limit: number
  /** 单行字符上限 */
  maxLineLength: number
  /** 单次输出的字节上限 */
  maxBytes: number
}

/** {@link buildWindow} 的结果 */
export interface WindowResult {
  lines: FsLine[]
  /** 文件总行数（始终精确，即使输出被字节上限截断） */
  totalLines: number
  /** 是否命中输出字节上限 */
  truncatedByBytes: boolean
}

/** 渲染 {@link formatReadOutput} 的输入 */
export interface FileReadOutcome {
  /** 请求的起始行号 */
  offset: number
  lines: FsLine[]
  totalLines: number
  /** 是否命中输出字节上限 */
  truncatedByBytes: boolean
}

interface WindowAccumulator {
  lines: FsLine[]
  totalLines: number
  outputBytes: number
  truncatedByBytes: boolean
}

function newAccumulator(): WindowAccumulator {
  return { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false }
}

/** 截断超长行，保留开头便于模型判断内容类型 */
function truncateLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength
    ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`
    : line
}

/** 一行的输出字节数：行间换行符算在前一行之外 */
function lineByteSize(line: string, currentLineCount: number): number {
  return Buffer.byteLength(line, 'utf8') + (currentLineCount > 0 ? 1 : 0)
}

function consumeLine(acc: WindowAccumulator, rawLine: string, request: ReadWindowRequest): void {
  acc.totalLines += 1
  if (
    acc.truncatedByBytes ||
    acc.totalLines < request.offset ||
    acc.lines.length >= request.limit
  ) {
    return
  }

  const text = truncateLine(rawLine, request.maxLineLength)
  const bytes = lineByteSize(text, acc.lines.length)
  if (acc.outputBytes + bytes > request.maxBytes) {
    acc.truncatedByBytes = true
    return
  }
  acc.outputBytes += bytes
  acc.lines.push({ number: acc.totalLines, text })
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function finish(
  acc: WindowAccumulator,
  request: ReadWindowRequest,
  displayPath: string
): WindowResult {
  // 空文件的 offset=1 是合法请求；其余越过最后一行的 offset 一律报错
  if (
    !acc.truncatedByBytes &&
    request.offset > acc.totalLines &&
    !(acc.totalLines === 0 && request.offset === 1)
  ) {
    throw new Error(
      `offset ${request.offset} 超出文件行数（共 ${acc.totalLines} 行）：${displayPath}`
    )
  }
  return { lines: acc.lines, totalLines: acc.totalLines, truncatedByBytes: acc.truncatedByBytes }
}

/**
 * 在解码后的文本块上构建一个窗口：边扫描边切行，命中行数或字节上限即停止收集，
 * 但仍扫描到末尾以获得精确总行数。
 * @param chunks 按文件顺序解码的文本块；块边界没有意义
 * @param request 已解析的窗口参数
 * @param displayPath 报错时展示的路径
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: ReadWindowRequest,
  displayPath: string
): Promise<WindowResult> {
  const acc = newAccumulator()
  // 多留一个字符就足以证明该行超长，行缓冲因此有界
  const lineBufferCap = request.maxLineLength + 1
  let lineBuffer = ''

  function appendToLineBuffer(segment: string): void {
    if (lineBuffer.length >= lineBufferCap) {
      return
    }
    lineBuffer += segment
    if (lineBuffer.length > lineBufferCap) {
      lineBuffer = lineBuffer.slice(0, lineBufferCap)
    }
  }

  function flushLine(): void {
    consumeLine(acc, stripCarriageReturn(lineBuffer), request)
    lineBuffer = ''
  }

  for await (const chunk of chunks) {
    let startPos = 0
    let newlinePos: number
    while ((newlinePos = chunk.indexOf('\n', startPos)) !== -1) {
      appendToLineBuffer(chunk.slice(startPos, newlinePos))
      flushLine()
      startPos = newlinePos + 1
    }
    appendToLineBuffer(chunk.slice(startPos))
  }
  if (lineBuffer.length > 0) {
    flushLine()
  }
  return finish(acc, request, displayPath)
}

/**
 * 把读取结果渲染成带行号的模型文本。
 * @param displayPath 展示路径，写进 `<path>` 标签
 * @param outcome 窗口结果
 */
export function formatReadOutput(displayPath: string, outcome: FileReadOutcome): string {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1)
  let footer: string
  if (outcome.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`
  }
  const body =
    outcome.lines.length > 0
      ? `${outcome.lines.map((line) => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
      : footer
  return `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
}
