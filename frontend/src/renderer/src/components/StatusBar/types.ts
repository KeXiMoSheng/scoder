/** StatusBar 组件的对外类型定义 */

import type { EncodingCandidate, TextEncodingId } from '@shared/files/encoding'

export interface StatusBarProps {
  /** 当前激活文本文件的编码；null 表示没有可切换的文件（无标签或二进制预览） */
  encoding: TextEncodingId | null
  /** 自动识别的候选编码（按可能性降序，第一条为最可能）；空数组表示没有建议 */
  candidates: readonly EncodingCandidate[]
  /** 选择某个编码：按该编码重新读取当前文件，后续保存也使用它 */
  onChange: (encoding: TextEncodingId) => void
}
