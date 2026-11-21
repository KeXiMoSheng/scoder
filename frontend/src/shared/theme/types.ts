/**
 * 导入主题（VS Code 主题文件 / .vsix 主题扩展包）的数据结构。
 * 主进程负责解析与转换，渲染进程只消费这里的结构并注册到 Monaco。
 */

/** Monaco 支持的编辑器内置基础主题 */
export type ThemeBase = 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'

/** Monaco 的 token 着色规则（与 IStandaloneThemeData.rules 一致） */
export interface ThemeRule {
  token: string
  foreground?: string
  background?: string
  fontStyle?: string
}

/** 由 VS Code 主题转换出的 Monaco 主题数据 */
export interface ConvertedEditorTheme {
  inherit: false
  base: ThemeBase
  colors: Record<string, string>
  rules: ThemeRule[]
  encodedTokensColors: []
}

/** 用户导入并持久化到 userData/themes 的一套主题 */
export interface ImportedTheme {
  /** 稳定 id：同名主题重复导入会覆盖同一份记录 */
  id: string
  /** 菜单展示名 */
  label: string
  /** 来源文件名（.json / .vsix），设置页用于说明出处 */
  sourceName: string
  /** 导入时间（ISO 8601） */
  importedAt: string
  editorTheme: ConvertedEditorTheme
}

/** 单个文件导入失败的原因（不阻断同批次其他文件） */
export interface ThemeImportError {
  file: string
  message: string
}

/** 一次导入操作的结果；用户取消选择时 canceled 为 true */
export interface ThemeImportResult {
  canceled: boolean
  themes: ImportedTheme[]
  errors: ThemeImportError[]
}

/** 导入限制：避免误选大文件或超大扩展包占满内存/磁盘 */
export const THEME_IMPORT_LIMITS = {
  /** 单个主题 JSON 文件上限（主题文件通常 < 1 MB） */
  maxThemeFileBytes: 10 * 1024 * 1024,
  /** 单个 .vsix 扩展包上限 */
  maxPackageFileBytes: 50 * 1024 * 1024,
  /** 解压后总大小上限（防压缩炸弹） */
  maxUncompressedBytes: 200 * 1024 * 1024,
  /** 已导入主题数量上限 */
  maxThemes: 100,
  /** 单个扩展包内最多导入的主题数 */
  maxThemesPerPackage: 40
} as const

/** 导入主题 id 的合法格式：写入文件名前必须校验，避免路径穿越 */
export const IMPORTED_THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/
