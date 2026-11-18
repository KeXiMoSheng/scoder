/**
 * 文件图标解析：直接使用微软 VS Code 内置 Seti（vs-seti）图标主题的字体与关联表。
 *
 * 与 VS Code 的匹配顺序保持一致：
 *   fileNames > fileExtensions（含多段后缀，最长优先） > languageIds > 默认 file。
 * 关联表与 iconDefinitions 均来自 assets/file-icons/vs-seti-icon-theme.json，
 * languageIds 所需的「文件名 → 语言」识别数据见 vscodeLanguageMap.json。
 *
 * 参考：
 * - https://code.visualstudio.com/api/extension-guides/file-icon-theme
 * - https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/themes/browser/fileIconThemeData.ts
 * - https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/services/getIconClasses.ts
 */
import themeJson from '../assets/file-icons/vs-seti-icon-theme.json'
import languageMapJson from './vscodeLanguageMap.json'

interface IconDefinition {
  fontCharacter: string
  fontColor?: string
}

interface Associations {
  file: string
  fileExtensions: Record<string, string>
  fileNames: Record<string, string>
  languageIds: Record<string, string>
}

interface IconTheme {
  iconDefinitions: Record<string, IconDefinition>
  file: string
  fileExtensions: Record<string, string>
  fileNames: Record<string, string>
  languageIds: Record<string, string>
  light: Associations
}

interface LanguageAssociation {
  extensions: string[]
  filenames: string[]
  filenamePatterns?: string[]
}

interface LanguageMap {
  languages: Record<string, LanguageAssociation>
}

// JSON 模块会被推导成精确的字面量类型，这里只取需要的结构
const THEME = themeJson as unknown as IconTheme
const LANGUAGE_MAP = languageMapJson as unknown as LanguageMap

const DEFINITIONS = THEME.iconDefinitions
const DARK: Associations = {
  file: THEME.file,
  fileExtensions: THEME.fileExtensions,
  fileNames: THEME.fileNames,
  languageIds: THEME.languageIds
}
const LIGHT = THEME.light

/** 应用主题的明暗类型，由 lib/theme.ts 写入 <html data-theme-kind> */
export type ThemeKind = 'dark' | 'light'

/** 图标命中结果；matchedKey 为命中的关联键，definition 为字体图标定义 id */
export interface FileIconMatch {
  definition: string
  character: string
  color: string | undefined
  matchedBy: 'fileName' | 'extension' | 'language' | 'default'
  matchedKey?: string
}

/** 与 VS Code getIconClasses 一致：文件名生成 name 与逐级点分后缀 */
function getFileAssociationKeys(fileName: string): { nameKeys: string[]; extensionKeys: string[] } {
  const segments = fileName.split('.')
  const extensionKeys: string[] = []
  for (let index = 1; index < segments.length; index++) {
    extensionKeys.push(segments.slice(index).join('.'))
  }
  return { nameKeys: [fileName], extensionKeys }
}

/**
 * glob 转正则：支持 VS Code 内置语言贡献里出现的 `*`、`?`。
 * 带路径分隔符的 pattern 只适用于完整路径，本项目仅拿到文件名，故忽略。
 */
function compileFilenamePattern(pattern: string): RegExp | null {
  if (pattern.includes('/')) {
    return null
  }
  let source = ''
  for (const char of pattern) {
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'i')
}

interface CompiledLanguage {
  id: string
  filenames: Set<string>
  patterns: { regex: RegExp; length: number }[]
  extensions: { value: string; length: number }[]
}

/** 预编译语言关联，按 VS Code languagesAssociations 的优先级复刻「文件名/模式/最长后缀」 */
const LANGUAGES: CompiledLanguage[] = Object.entries(LANGUAGE_MAP.languages).map(([id, assoc]) => ({
  id,
  filenames: new Set(assoc.filenames),
  patterns: (assoc.filenamePatterns ?? []).flatMap((pattern) => {
    const regex = compileFilenamePattern(pattern)
    return regex ? [{ regex, length: pattern.length }] : []
  }),
  extensions: assoc.extensions.map((value) => ({ value, length: value.length }))
}))

/** VS Code 的 getAssociationByPath：精确文件名 > 最长 filenamePattern > 最长后缀 */
function detectLanguageId(fileName: string): string | undefined {
  let filenameMatch: string | undefined
  let patternMatch: { id: string; length: number } | undefined
  let extensionMatch: { id: string; length: number } | undefined

  for (const language of LANGUAGES) {
    if (language.filenames.has(fileName)) {
      filenameMatch = language.id
      break
    }
    for (const pattern of language.patterns) {
      if (
        pattern.regex.test(fileName) &&
        (!patternMatch || pattern.length >= patternMatch.length)
      ) {
        patternMatch = { id: language.id, length: pattern.length }
      }
    }
    for (const extension of language.extensions) {
      if (
        fileName.endsWith(`.${extension.value}`) &&
        (!extensionMatch || extension.length >= extensionMatch.length)
      ) {
        extensionMatch = { id: language.id, length: extension.length }
      }
    }
  }

  return filenameMatch ?? patternMatch?.id ?? extensionMatch?.id
}

/** 按 VS Code 优先级匹配图标定义 id。
 * VS Code 会把 light 的关联生成 `.vs ...` 选择器覆盖基础选择器；
 * 因此浅色主题下优先取 light 的定义，light 未定义时回落到基础（暗色）定义。
 */
function resolveDefinitionId(
  fileName: string,
  kind: ThemeKind
): { id: string; matchedBy: FileIconMatch['matchedBy']; matchedKey?: string } {
  const base = kind === 'light' ? LIGHT : null
  const { nameKeys, extensionKeys } = getFileAssociationKeys(fileName)

  // 先按 VS Code 的关联优先级找键，再决定该键用哪套定义：
  // 文件名的优先级高于后缀，后缀高于语言，不能用 light 的后缀抢掉基础的文件名。
  type TableName = 'fileNames' | 'fileExtensions' | 'languageIds'
  const candidates: { table: TableName; key: string; matchedBy: FileIconMatch['matchedBy'] }[] = []
  for (const key of nameKeys) {
    if (key in DARK.fileNames) {
      candidates.push({ table: 'fileNames', key, matchedBy: 'fileName' })
    }
  }
  for (const key of extensionKeys) {
    if (key in DARK.fileExtensions) {
      candidates.push({ table: 'fileExtensions', key, matchedBy: 'extension' })
    }
  }
  const languageId = detectLanguageId(fileName)
  if (languageId && languageId in DARK.languageIds) {
    candidates.push({ table: 'languageIds', key: languageId, matchedBy: 'language' })
  }

  for (const { table, key, matchedBy } of candidates) {
    const id = base?.[table]?.[key] ?? DARK[table][key]
    if (id in DEFINITIONS) {
      return { id, matchedBy, matchedKey: key }
    }
  }

  const defaultId = base?.file ?? DARK.file
  return { id: defaultId, matchedBy: 'default' }
}

/** 把主题里的 "\\E051" 转成可渲染的 Unicode 字符 */
function toFontCharacter(escape: string): string {
  return String.fromCodePoint(Number.parseInt(escape.slice(1), 16))
}

/** 按文件名解析 VS Code Seti 字体图标；kind 由当前应用主题明暗决定 */
export function resolveFileIcon(fileName: string, kind: ThemeKind = 'dark'): FileIconMatch {
  const lowerName = fileName.toLowerCase()
  const { id, matchedBy, matchedKey } = resolveDefinitionId(lowerName, kind)
  const definition = DEFINITIONS[id]
  return {
    definition: id,
    character: definition ? toFontCharacter(definition.fontCharacter) : '',
    color: definition?.fontColor,
    matchedBy,
    matchedKey
  }
}
