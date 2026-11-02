/**
 * 卡片展示用的行级 diff。
 *
 * 用 diff 包的 structuredPatch（与 deepseek-harness 同一实现）算出带上下文的
 * 变更块，并给每行标好 context / del / add —— 渲染进程只负责上色。
 * 同时输出未经裁剪的增删行数，供"本轮改动清单"使用。
 */
import { structuredPatch } from 'diff'
import type { JsonValue, ToolFileChange, ToolHunk, ToolHunkLine } from '../../../shared/ai/types'

/** 每个变更块前后保留的上下文行数 */
const CONTEXT = 3

/** 单块展示上限：整文件写入不能把卡片和日志撑爆 */
const MAX_HUNK_LINES = 40
const MAX_HUNK_CHARS = 4000

/** 单张卡片最多展示的变更块数 */
const MAX_HUNKS = 10

/** 一次变更的展示数据：变更块 + 准确的增删行数 */
export interface DiffStat {
  hunks: ToolHunk[]
  /** 新增行数（完整统计，不受展示裁剪影响） */
  added: number
  /** 减少行数（完整统计） */
  removed: number
}

/**
 * 计算 before → after 的变更块与行数统计。
 * @param before 变更前文本（LF 基准）
 * @param after 变更后文本（LF 基准）
 * @param context 每块前后的上下文行数
 */
export function diffStat(before: string, after: string, context = CONTEXT): DiffStat {
  // 统一到 LF：CRLF 文本不该让每一行都显示成改动（调用阶段拿到的是模型原文，可能带 \r\n）
  const oldText = before.replace(/\r\n/g, '\n')
  const newText = after.replace(/\r\n/g, '\n')
  if (oldText === newText) {
    return { hunks: [], added: 0, removed: 0 }
  }
  const patch = structuredPatch('', '', oldText, newText, undefined, undefined, { context })
  const hunks: ToolHunk[] = []
  let added = 0
  let removed = 0
  for (const hunk of patch.hunks) {
    const lines: ToolHunkLine[] = []
    for (const raw of hunk.lines) {
      // 补丁的"\ No newline at end of file"是元信息，不属于文件内容
      if (raw.startsWith('\\')) continue
      const text = raw.slice(1)
      if (raw.startsWith('+')) {
        lines.push({ kind: 'add', text })
        added += 1
      } else if (raw.startsWith('-')) {
        lines.push({ kind: 'del', text })
        removed += 1
      } else {
        lines.push({ kind: 'context', text })
      }
    }
    if (lines.length > 0) hunks.push(clipHunk({ lines }))
  }
  if (hunks.length <= MAX_HUNKS) {
    return { hunks, added, removed }
  }
  return {
    hunks: [
      ...hunks.slice(0, MAX_HUNKS),
      // 如实告诉读者还有未展开的改动，避免误以为只改了几处
      {
        lines: [
          { kind: 'context', text: `…（共 ${hunks.length} 处改动，仅展开前 ${MAX_HUNKS} 处）` }
        ]
      }
    ],
    added,
    removed
  }
}

/** 把单块裁到可展示的规模，卡片与日志都不会因整文件写入膨胀 */
export function clipHunk(hunk: ToolHunk): ToolHunk {
  const kept: ToolHunkLine[] = []
  let chars = 0
  for (const line of hunk.lines) {
    // 行数与字符数双重约束：超长行（压缩产物、base64）同样要挡住
    if (kept.length >= MAX_HUNK_LINES || chars + line.text.length > MAX_HUNK_CHARS) break
    kept.push(line)
    chars += line.text.length
  }
  if (kept.length < hunk.lines.length) {
    kept.push({ kind: 'context', text: `…（已省略 ${hunk.lines.length - kept.length} 行）` })
  }
  return { lines: kept }
}

/**
 * 从结果载荷里取回变更块。
 * 旧日志、缺字段或格式不合法时返回空数组：重放历史不该因此抛错。
 */
export function hunksFromMeta(meta: JsonValue | undefined): ToolHunk[] {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return []
  const value = (meta as { [key: string]: JsonValue }).hunks
  if (!Array.isArray(value)) return []
  return value.filter(isHunk) as unknown as ToolHunk[]
}

/** 判定一个值是否是合法的变更块 */
function isHunk(value: JsonValue): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const lines = (value as { [key: string]: JsonValue }).lines
  return Array.isArray(lines) && lines.every(isHunkLine)
}

/** 判定一个值是否是合法的 diff 行 */
function isHunkLine(value: JsonValue): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { kind, text } = value as { [key: string]: JsonValue }
  return (kind === 'context' || kind === 'del' || kind === 'add') && typeof text === 'string'
}

/**
 * 从结果载荷里还原改动统计。
 * path 与行数取自写出时算好的 meta；status 由 meta.operation 推导
 * （create → A，其余 → M）。
 * @returns 字段不合法时返回 undefined，让调用方跳过这条清单项
 */
export function changeFromMeta(meta: JsonValue | undefined): ToolFileChange | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { path, added, removed, operation } = meta as { [key: string]: JsonValue }
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (typeof added !== 'number' || typeof removed !== 'number') return undefined
  return { path, added, removed, status: operation === 'create' ? 'A' : 'M' }
}
