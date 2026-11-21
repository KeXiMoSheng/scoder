/**
 * VS Code 主题 → Monaco 主题的转换。
 *
 * 参考并重写了 https://github.com/Nishkalkashyap/monaco-vscode-textmate-theme-converter
 * （同类实现见 vscode-theme-to-monaco-theme，MIT）：
 * - 修复原实现按正则删除注释会误伤字符串、只清理一处尾逗号的问题
 * - 按主题 type / 扩展 manifest 的 uiTheme 选择 vs / vs-dark / 高对比基础主题，
 *   不再一律使用 vs-dark
 * - 过滤非法颜色与非法的 fontStyle，避免 Monaco 收到坏值
 * - 支持 VS Code 主题的 include 继承链
 */
import type { ConvertedEditorTheme, ThemeBase, ThemeRule } from './types'

type RawRecord = Record<string, unknown>

/** 转换时的回退项：主题文件缺 type 时用扩展 manifest 的 uiTheme 判断明暗 */
export interface ThemeConvertOptions {
  uiTheme?: string
  /** 默认文本色回退，与上游 convertTheme(defaultColor) 含义一致 */
  defaultColor?: string
}

/** 单套主题的转换结果：label 来自主题 name，缺省时由调用方按文件名补 */
export interface ConvertedThemeResult {
  label: string
  editorTheme: ConvertedEditorTheme
}

/** 主题 include 的读取来源：本地文件与 .vsix 包内路径各实现一份 */
export interface ThemeSource {
  /** 以 fromKey（当前主题的读取键）为基准，把 include 的相对引用规范化为读取键 */
  resolve(reference: string, fromKey: string): string
  /** 按读取键读出主题 JSON 对象；不存在/非法时抛错 */
  read(key: string): Promise<unknown> | unknown
}

const BASE_BY_TYPE: Record<string, ThemeBase> = {
  light: 'vs',
  dark: 'vs-dark',
  hc: 'hc-black',
  'hc-black': 'hc-black',
  'hc-light': 'hc-light',
  vs: 'vs',
  'vs-dark': 'vs-dark'
}

/** #RGB / #RGBA / #RRGGBB / #RRGGBBAA，大小写均可 */
const COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

const FONT_STYLE_TOKENS = new Set(['italic', 'bold', 'underline', 'strikethrough'])

/** include 链的最大深度：足够覆盖常见的「基础主题 + 变体」两层结构 */
const MAX_INCLUDE_DEPTH = 5

/**
 * 解析主题文件：先去掉 BOM、行/块注释与尾逗号，再走标准 JSON.parse。
 * 不能用正则粗暴替换：注释与尾逗号都可能出现在字符串字面量里。
 */
export function parseThemeJsonc(text: string): unknown {
  const withoutBom = text.replace(/^\uFEFF/, '')
  const cleaned = removeTrailingCommas(stripJsonComments(withoutBom))
  try {
    return JSON.parse(cleaned)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`主题文件不是有效的 JSONC/JSON：${message}`, { cause: error })
  }
}

/** 判断解析结果是否像一份 VS Code 配色主题（而不是扩展 manifest 等 JSON） */
export function isThemeLike(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) {
    return false
  }
  return record.colors !== undefined || record.tokenColors !== undefined
}

/**
 * 按 include 链加载主题：子主题覆盖父主题的 colors，tokenColors 依次拼接。
 * 循环引用或层数过深直接抛错，避免无限递归。
 */
export async function loadThemeWithIncludes(
  source: ThemeSource,
  key: string,
  seen: Set<string> = new Set()
): Promise<unknown> {
  if (seen.has(key)) {
    throw new Error('主题 include 出现循环引用')
  }
  if (seen.size >= MAX_INCLUDE_DEPTH) {
    throw new Error(`主题 include 嵌套超过 ${MAX_INCLUDE_DEPTH} 层`)
  }
  seen.add(key)
  const theme = await source.read(key)
  const record = asRecord(theme)
  const include = typeof record?.include === 'string' ? record.include.trim() : ''
  if (include === '') {
    return theme
  }
  const parent = await loadThemeWithIncludes(source, source.resolve(include, key), seen)
  return mergeThemes(parent, theme)
}

/** 父主题打底、子主题覆盖；colors 合并，tokenColors 拼接（VS Code 的 include 语义） */
export function mergeThemes(parent: unknown, child: unknown): unknown {
  const parentRecord = asRecord(parent) ?? {}
  const childRecord = asRecord(child) ?? {}
  const parentColors = asRecord(parentRecord.colors) ?? {}
  const childColors = asRecord(childRecord.colors) ?? {}
  const parentTokenColors = Array.isArray(parentRecord.tokenColors) ? parentRecord.tokenColors : []
  const childTokenColors = Array.isArray(childRecord.tokenColors) ? childRecord.tokenColors : []
  return {
    ...parentRecord,
    ...childRecord,
    type: childRecord.type ?? parentRecord.type,
    name: childRecord.name ?? parentRecord.name,
    colors: { ...parentColors, ...childColors },
    tokenColors: [...parentTokenColors, ...childTokenColors]
  }
}

/**
 * 把一个 VS Code 主题对象转换成 Monaco 的 IStandaloneThemeData。
 * tokenColors 的 scope 支持字符串（可含逗号分隔的多条）与数组两种写法；
 * 无 scope 的条目作为全局默认样式，最终生成一条 token 为空的兜底规则。
 */
export function convertThemeToMonaco(
  theme: unknown,
  options: ThemeConvertOptions = {}
): ConvertedThemeResult {
  const record = asRecord(theme)
  if (!record) {
    throw new Error('主题内容必须是 JSON 对象')
  }
  if (!isThemeLike(record)) {
    throw new Error('文件中没有 colors / tokenColors，不是 VS Code 配色主题')
  }

  const colors = sanitizeColors(record.colors)
  const rules: ThemeRule[] = []
  let globalForeground: string | undefined
  let globalBackground: string | undefined
  let globalFontStyle: string | undefined

  const tokenColors = Array.isArray(record.tokenColors) ? record.tokenColors : []
  for (const entry of tokenColors) {
    const colorEntry = asRecord(entry)
    if (!colorEntry) {
      continue
    }
    const settings = asRecord(colorEntry.settings) ?? {}
    const foreground = normalizeColor(settings.foreground)
    const background = normalizeColor(settings.background)
    const fontStyle = normalizeFontStyle(settings.fontStyle)
    const scopes = readScopes(colorEntry.scope)

    if (scopes.length === 0) {
      // 无 scope 的条目即全局默认值：后出现的覆盖先出现的
      globalForeground = foreground ?? globalForeground
      globalBackground = background ?? globalBackground
      globalFontStyle = fontStyle ?? globalFontStyle
      continue
    }

    for (const token of scopes) {
      const rule: ThemeRule = { token }
      if (foreground) {
        rule.foreground = foreground
      }
      if (background) {
        rule.background = background
      }
      if (fontStyle) {
        rule.fontStyle = fontStyle
      }
      rules.push(rule)
    }
  }

  const defaultForeground =
    normalizeColor(colors['editor.foreground']) ??
    globalForeground ??
    normalizeColor(options.defaultColor) ??
    '#ffffff'
  // token 的默认背景不取 editor.background：编辑器本身已经铺底，
  // 默认规则再铺一层背景会让 diff 视图等特殊区域覆盖掉自己的底色
  const defaultBackground = globalBackground
  const defaultRule: ThemeRule = { token: '', foreground: defaultForeground }
  if (defaultBackground) {
    defaultRule.background = defaultBackground
  }
  if (globalFontStyle) {
    defaultRule.fontStyle = globalFontStyle
  }
  rules.push(defaultRule)

  const name = typeof record.name === 'string' ? record.name.trim() : ''
  return {
    label: name,
    editorTheme: {
      inherit: false,
      base: resolveBase(record.type, options.uiTheme),
      colors,
      rules,
      encodedTokensColors: []
    }
  }
}

/** 读取已持久化主题时做一次结构校验：存储文件损坏时返回 null，由调用方跳过 */
export function sanitizeConvertedTheme(value: unknown): ConvertedEditorTheme | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const base = typeof record.base === 'string' ? BASE_BY_TYPE[record.base.toLowerCase()] : undefined
  if (!base) {
    return null
  }
  const rules = sanitizeRules(record.rules)
  const colors = sanitizeColors(record.colors)
  if (rules.length === 0) {
    rules.push({
      token: '',
      foreground: normalizeColor(colors['editor.foreground']) ?? '#ffffff'
    })
  }
  return {
    inherit: false,
    base,
    colors,
    rules,
    encodedTokensColors: []
  }
}

/** Monaco 只接受十六进制颜色；非法值直接丢弃，避免注册主题时抛错或染色异常 */
function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return COLOR_PATTERN.test(trimmed) ? trimmed : undefined
}

/** 过滤颜色表：键保留原样，值必须是合法配色 */
function sanitizeColors(value: unknown): Record<string, string> {
  const record = asRecord(value)
  const colors: Record<string, string> = {}
  if (!record) {
    return colors
  }
  for (const [name, raw] of Object.entries(record)) {
    const color = normalizeColor(raw)
    if (color) {
      colors[name] = color
    }
  }
  return colors
}

/** 只保留 Monaco 支持的四个字体样式关键字 */
function normalizeFontStyle(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const tokens = value
    .trim()
    .split(/\s+/)
    .filter((token) => FONT_STYLE_TOKENS.has(token))
  return tokens.length > 0 ? [...new Set(tokens)].join(' ') : undefined
}

/** scope 支持 "a, b" 与 ["a", "b"]，统一裁剪并去空 */
function readScopes(value: unknown): string[] {
  const raw = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : []
  const scopes: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue
    }
    const scope = item.trim()
    if (scope !== '') {
      scopes.push(scope)
    }
  }
  return scopes
}

/** 按主题 type（优先）与扩展 manifest 的 uiTheme 选择基础主题 */
function resolveBase(type: unknown, uiTheme?: string): ThemeBase {
  if (typeof type === 'string') {
    const base = BASE_BY_TYPE[type.toLowerCase()]
    if (base) {
      return base
    }
  }
  if (typeof uiTheme === 'string') {
    const base = BASE_BY_TYPE[uiTheme.toLowerCase()]
    if (base) {
      return base
    }
  }
  return 'vs-dark'
}

/** 校验并清洗 token 规则（只用于读取已持久化的主题） */
function sanitizeRules(value: unknown): ThemeRule[] {
  const rules: ThemeRule[] = []
  if (!Array.isArray(value)) {
    return rules
  }
  for (const item of value) {
    const record = asRecord(item)
    if (!record) {
      continue
    }
    const token = typeof record.token === 'string' ? record.token : ''
    const foreground = normalizeColor(record.foreground)
    const background = normalizeColor(record.background)
    const fontStyle = normalizeFontStyle(record.fontStyle)
    // 空 token 且没有任何样式时这条规则没有意义，跳过
    if (foreground === undefined && background === undefined && fontStyle === undefined) {
      continue
    }
    const rule: ThemeRule = { token }
    if (foreground) {
      rule.foreground = foreground
    }
    if (background) {
      rule.background = background
    }
    if (fontStyle) {
      rule.fontStyle = fontStyle
    }
    rules.push(rule)
  }
  return rules
}

/** 非数组的对象才按记录处理 */
function asRecord(value: unknown): RawRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as RawRecord
}

/** 去掉 // 与 /* *\/ 注释；字符串内的 // 原样保留，块注释里的换行保留以维持行号 */
function stripJsonComments(input: string): string {
  let output = ''
  let index = 0
  let inString = false
  while (index < input.length) {
    const char = input[index]
    const next = input[index + 1]
    if (inString) {
      output += char
      if (char === '\\') {
        output += next ?? ''
        index += 2
        continue
      }
      if (char === '"') {
        inString = false
      }
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      while (index < input.length && input[index] !== '\n' && input[index] !== '\r') {
        index += 1
      }
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) {
        if (input[index] === '\n') {
          output += '\n'
        }
        index += 1
      }
      index += 2
      continue
    }
    output += char
    index += 1
  }
  return output
}

/** 去掉对象/数组末尾的逗号（仅跳过字符串之外的逗号） */
function removeTrailingCommas(input: string): string {
  let output = ''
  let index = 0
  let inString = false
  while (index < input.length) {
    const char = input[index]
    if (inString) {
      output += char
      if (char === '\\') {
        output += input[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === '"') {
        inString = false
      }
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      index += 1
      continue
    }
    if (char === ',') {
      let lookahead = index + 1
      while (lookahead < input.length && /\s/.test(input[lookahead])) {
        lookahead += 1
      }
      if (input[lookahead] === '}' || input[lookahead] === ']') {
        index += 1
        continue
      }
    }
    output += char
    index += 1
  }
  return output
}
