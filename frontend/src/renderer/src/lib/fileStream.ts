/**
 * 流式灌入 Monaco 的辅助工具。
 * 大文件不能拼成一个字符串再 createModel（会撞 V8 单字符串上限），
 * 因此按块规范化行尾后追加到空 model：Monaco 内部用 PieceTree 存文本，
 * 不要求整体字符串。
 */

import { monaco } from './monaco'

/**
 * 流式文本的行尾规范化：把 CRLF 统一成 LF 再插入 model，
 * 并处理被块边界切开的 \r\n（块尾孤立的 \r 留到下一块判断）。
 */
export class LineEndingNormalizer {
  private carry = ''
  private sawCrlf = false

  /** 原文是否为 CRLF 风格（第一块到达后用于设定 model 的目标行尾） */
  get crlf(): boolean {
    return this.sawCrlf
  }

  /** 规范化一块文本 */
  normalize(chunk: string): string {
    let text = this.carry + chunk
    this.carry = ''
    if (text.endsWith('\r')) {
      this.carry = '\r'
      text = text.slice(0, -1)
    }
    if (!this.sawCrlf && text.includes('\r\n')) {
      this.sawCrlf = true
    }
    return text.replace(/\r\n/g, '\n')
  }

  /** 收尾：把遗留的孤立 \r 原样输出 */
  flush(): string {
    const rest = this.carry
    this.carry = ''
    return rest
  }
}

/** 把一段文本追加到 model 末尾（不经过撤销栈，适合加载阶段批量灌入） */
export function appendModelText(model: monaco.editor.ITextModel, text: string): void {
  if (text.length === 0) {
    return
  }
  const lineNumber = model.getLineCount()
  const column = model.getLineMaxColumn(lineNumber)
  model.applyEdits([{ range: new monaco.Range(lineNumber, column, lineNumber, column), text }])
}
