/**
 * 设置面板里“多行文本 ↔ 结构化值”的转换。
 * 表单用文本编辑参数、环境变量与请求头；主进程只接受结构化值，
 * 所以解析放在共享层，渲染进程提交前就能给出可读错误。
 */

/** 一行以 # 开头视为注释；参数里确实需要 # 开头时无法表达，这属于已知取舍 */
const COMMENT_PREFIX = '#'

/** 键名允许的字符：覆盖环境变量与 HTTP 头（如 X-Api-Key） */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/**
 * 把多行文本解析成参数数组：跳过空行与注释行，去掉行尾空白。
 * @param text 每行一个参数的文本
 * @returns 参数数组；空文本得到空数组
 */
export function parseLineList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0 && !line.trimStart().startsWith(COMMENT_PREFIX))
}

/**
 * 把参数数组还原成多行文本。
 * @param values 参数数组
 * @returns 每行一个参数的文本
 */
export function formatLineList(values: readonly string[]): string {
  return values.join('\n')
}

/** 键值文本的解析结果 */
export interface KeyValueParseResult {
  /** 解析出的键值；error 非空时内容不可用 */
  values: Record<string, string>
  /** 首个非法行的可读说明；全部合法时为 null */
  error: string | null
}

/**
 * 把 `KEY=VALUE` 多行文本解析成对象。
 * 空行与注释行跳过；注释会作为说明出现在表单里，重新格式化时丢弃。
 * @param text 每行一条 KEY=VALUE 的文本
 * @returns 解析结果；存在非法行时 values 为空对象
 */
export function parseKeyValueLines(text: string): KeyValueParseResult {
  const values: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\s+$/, '')
    if (line.length === 0 || line.trimStart().startsWith(COMMENT_PREFIX)) {
      continue
    }
    const separator = line.indexOf('=')
    if (separator <= 0) {
      return { values: {}, error: `第 ${index + 1} 行不是 KEY=VALUE 形式` }
    }
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1)
    if (!KEY_PATTERN.test(key)) {
      return { values: {}, error: `第 ${index + 1} 行的键名「${key}」包含非法字符` }
    }
    if (Object.hasOwn(values, key)) {
      return { values: {}, error: `第 ${index + 1} 行的键名「${key}」重复` }
    }
    values[key] = value
  }
  return { values, error: null }
}

/**
 * 把键值对象还原成多行文本，键按升序排列保证同样内容总是同样文本。
 * @param values 键值对象
 * @returns 每行一条 KEY=VALUE 的文本
 */
export function formatKeyValueLines(values: Record<string, string>): string {
  return Object.keys(values)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}=${values[key]}`)
    .join('\n')
}
