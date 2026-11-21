import { convertThemeToMonaco, parseThemeJsonc } from '@shared/theme/convert'
import type { ImportedTheme } from '@shared/theme/types'
import { monaco } from './monaco'

// 自动发现 public/theme/ 下的 VS Code 原始主题（.json / JSONC），
// 首屏渲染前用共享转换器转成 Monaco 主题；同一套配色只维护一份原始文件，
// 不再需要单独提交转换后的 *-monaco.json。
// 主题 id = 文件名（去掉 .json），同时作为 localStorage 里保存的主题标识。
const themeModules = import.meta.glob('@theme/*.json', {
  eager: true,
  query: '?raw',
  import: 'default'
}) as Record<string, string>

const THEME_FILE_SUFFIX = '.json'
/** 兼容旧文件：误留的 *-monaco.json 不作为内置主题加载 */
const MONACO_SUFFIX = '-monaco.json'

export type ThemeId = string

/** 应用 UI 使用的 CSS 变量（与 assets/main.css 中的变量一一对应） */
export type CssVarName =
  | '--bg'
  | '--bg-elevated'
  | '--bg-hover'
  | '--border'
  | '--divider'
  | '--text'
  | '--text-dim'
  | '--link'
  | '--accent'
  | '--accent-hover'
  | '--accent-foreground'
  | '--selection'
  | '--error'
  | '--search-match'
  | '--search-match-border'
  | '--git-added'
  | '--git-modified'
  | '--git-deleted'

/** 主题来源：内置（public/theme）或用户导入（userData/themes） */
export type ThemeOrigin = 'builtin' | 'imported'

export interface AppTheme {
  id: ThemeId
  /** 下拉框显示名，取自文件名（内置）或导入时的主题名 */
  label: string
  /** 明暗类型：写入 color-scheme，控制原生滚动条与下拉控件的明暗 */
  kind: 'light' | 'dark'
  vars: Record<CssVarName, string>
  /** 注册到 Monaco 的完整主题数据（内置主题由 public/theme 原始 JSON 转换，导入主题由 VS Code 主题转换） */
  editorTheme: monaco.editor.IStandaloneThemeData
  /** 来源：设置页据此区分可删除的导入主题 */
  origin: ThemeOrigin
  /** 导入主题的来源文件名（.json / .vsix），内置主题为空 */
  sourceName?: string
  /** 导入时间（ISO 8601），内置主题为空 */
  importedAt?: string
}

/** 主题目录快照：React 通过 useSyncExternalStore 订阅，导入/删除后菜单立即更新 */
export interface ThemeSnapshot {
  themes: readonly AppTheme[]
  activeId: ThemeId
}

// UI 变量 → 主题 colors 段候选键：按序取第一个存在的值；全部缺失时回退到 extractVars 中的兜底值
const VAR_COLOR_KEYS: Record<CssVarName, readonly string[]> = {
  '--bg': ['editor.background'],
  '--bg-elevated': ['sideBar.background', 'editorGroupHeader.tabsBackground'],
  '--bg-hover': ['list.hoverBackground', 'list.activeSelectionBackground'],
  '--border': ['sideBar.border', 'panel.border', 'editorGroupHeader.tabsBorder'],
  // 分栏分隔线：优先取 panel.border。editorGroup.border 虽是分栏的语义键，但在 One Dark Pro 系列里
  // 与编辑器底色过于接近（#181a1f / #23252c），单独成线后不够清晰；panel.border 是主题里
  // 用来分隔面板的可见线色，四套主题都提供了该键。
  '--divider': ['panel.border', 'editorGroup.border', 'sideBar.border'],
  '--text': ['editor.foreground', 'foreground'],
  '--text-dim': ['tab.inactiveForeground', 'statusBar.foreground', 'tab.activeForeground'],
  // Markdown 预览等处的链接色：优先取主题的链接色，缺失时回退正文色
  '--link': ['textLink.foreground', 'editorLink.activeForeground'],
  '--accent': ['button.background'],
  '--accent-hover': ['button.hoverBackground'],
  '--accent-foreground': ['button.foreground'],
  '--selection': ['list.activeSelectionBackground', 'list.hoverBackground'],
  '--error': ['errorForeground', 'chat.linesRemovedForeground'],
  '--search-match': [
    'editor.findMatchBackground',
    'editor.selectionHighlightBackground',
    'editor.wordHighlightStrongBackground'
  ],
  '--search-match-border': [
    'editor.findMatchBorder',
    'editor.selectionHighlightBorder',
    'editor.wordHighlightStrongBorder'
  ],
  // Git 状态标记（文件树、编辑器页签、AI 变更清单）统一取 VSCode 的 editorGutter 色
  '--git-added': ['editorGutter.addedBackground'],
  '--git-modified': ['editorGutter.modifiedBackground'],
  '--git-deleted': ['editorGutter.deletedBackground']
}

/** Monaco base 字段 → 明暗类型 */
const BASE_KINDS: Record<string, AppTheme['kind']> = {
  vs: 'light',
  'vs-dark': 'dark',
  'hc-black': 'dark',
  'hc-light': 'light'
}

/** 将 6 位 hex 颜色按比例混向另一颜色；解析失败时原样返回 */
function mixHex(hex: string, toward: string, ratio: number): string {
  const parse = (value: string): [number, number, number] | null => {
    const match = /^#([0-9a-f]{6})$/i.exec(value.trim())
    if (!match) {
      return null
    }
    const num = Number.parseInt(match[1], 16)
    return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff]
  }
  const from = parse(hex)
  const to = parse(toward)
  if (!from || !to) {
    return hex
  }
  const mix = (index: number): string =>
    Math.round(from[index] + (to[index] - from[index]) * ratio)
      .toString(16)
      .padStart(2, '0')
  return `#${mix(0)}${mix(1)}${mix(2)}`
}

function extractVars(
  colors: Record<string, string>,
  kind: AppTheme['kind']
): Record<CssVarName, string> {
  const pick = (name: CssVarName): string | undefined => {
    for (const key of VAR_COLOR_KEYS[name]) {
      const value = colors[key]
      if (typeof value === 'string' && value !== '') {
        return value
      }
    }
    return undefined
  }
  const bg = pick('--bg') ?? '#1e1e1e'
  const text = pick('--text') ?? '#d4d4d4'
  const accent = pick('--accent') ?? '#404754'
  const border = pick('--border') ?? bg
  return {
    '--bg': bg,
    '--bg-elevated': pick('--bg-elevated') ?? bg,
    '--bg-hover': pick('--bg-hover') ?? bg,
    '--border': border,
    // 主题完全没有面板分隔色时，至少与普通边框一致，避免分栏处出现硬编码颜色
    '--divider': pick('--divider') ?? border,
    '--text': text,
    '--text-dim': pick('--text-dim') ?? text,
    '--link': pick('--link') ?? text,
    '--accent': accent,
    // 主题未提供 hover 色时，向白（深色主题）/ 黑（浅色主题）混合少量派生
    '--accent-hover':
      pick('--accent-hover') ?? mixHex(accent, kind === 'dark' ? '#ffffff' : '#000000', 0.08),
    '--accent-foreground': pick('--accent-foreground') ?? '#ffffff',
    '--selection': pick('--selection') ?? pick('--bg-hover') ?? bg,
    '--error': pick('--error') ?? '#e05561',
    '--search-match': pick('--search-match') ?? (kind === 'dark' ? '#d19a6688' : '#ffd33d99'),
    '--search-match-border':
      pick('--search-match-border') ?? (kind === 'dark' ? '#d19a66' : '#9a6700'),
    // 主题没有 editorGutter 色时回退到 VSCode 的 Git 装饰默认色
    '--git-added': pick('--git-added') ?? '#81b88b',
    '--git-modified': pick('--git-modified') ?? '#e2c08d',
    '--git-deleted': pick('--git-deleted') ?? '#c74e39'
  }
}

function discoverBuiltinThemes(): AppTheme[] {
  const themes: AppTheme[] = []
  for (const [path, raw] of Object.entries(themeModules)) {
    const fileName = path.split('/').pop()
    if (!fileName || fileName.endsWith(MONACO_SUFFIX)) {
      continue
    }
    const id = fileName.slice(0, -THEME_FILE_SUFFIX.length)
    try {
      const converted = convertThemeToMonaco(parseThemeJsonc(raw))
      const kind = BASE_KINDS[converted.editorTheme.base] ?? 'dark'
      themes.push({
        id,
        label: id,
        kind,
        vars: extractVars(converted.editorTheme.colors, kind),
        editorTheme: converted.editorTheme as unknown as monaco.editor.IStandaloneThemeData,
        origin: 'builtin'
      })
    } catch (error) {
      // 单个内置主题损坏只跳过该主题，不能影响其他主题与启动流程
      console.warn(`内置主题解析失败，已跳过：${fileName}`, error)
    }
  }
  themes.sort((a, b) => a.id.localeCompare(b.id))
  return themes
}

/** public/theme/ 目录中发现的内置主题（按文件名排序；新增文件后无需改动代码） */
const BUILTIN_THEMES: readonly AppTheme[] = discoverBuiltinThemes()

const DEFAULT_THEME_ID = 'one-dark-pro-darker'

const STORAGE_KEY = 'scoder.theme'

/** 导入主题 → 应用主题：与内置主题共用取色与明暗判定逻辑 */
function toAppTheme(record: ImportedTheme): AppTheme {
  const kind = BASE_KINDS[record.editorTheme.base] ?? 'dark'
  return {
    id: record.id,
    label: record.label,
    kind,
    vars: extractVars(record.editorTheme.colors ?? {}, kind),
    editorTheme: record.editorTheme as unknown as monaco.editor.IStandaloneThemeData,
    origin: 'imported',
    sourceName: record.sourceName,
    importedAt: record.importedAt
  }
}

let importedThemes: readonly AppTheme[] = []
let allThemes: readonly AppTheme[] = BUILTIN_THEMES
let themeById = new Map<string, AppTheme>(allThemes.map((theme) => [theme.id, theme] as const))

let activeThemeId: ThemeId = allThemes[0]?.id ?? DEFAULT_THEME_ID

let snapshot: ThemeSnapshot = { themes: allThemes, activeId: activeThemeId }
const themeListeners = new Set<() => void>()

/** 订阅主题目录变化（导入/删除/切换都会通知） */
export function subscribeThemes(listener: () => void): () => void {
  themeListeners.add(listener)
  return () => {
    themeListeners.delete(listener)
  }
}

/** 当前快照：themes 引用只在目录变化时替换，满足 useSyncExternalStore 的稳定快照要求 */
export function getThemeSnapshot(): ThemeSnapshot {
  return snapshot
}

function publishThemes(): void {
  snapshot = { themes: allThemes, activeId: activeThemeId }
  for (const listener of themeListeners) {
    listener()
  }
}

export function getActiveThemeId(): ThemeId {
  return activeThemeId
}

/**
 * 用主进程读到的导入主题重建目录：注册到 Monaco 并让菜单立即反映。
 * 启动引导与设置页导入/删除后都走这里，保证两处看到同一份清单。
 */
export function registerImportedThemes(records: readonly ImportedTheme[]): void {
  importedThemes = records.map(toAppTheme)
  for (const theme of importedThemes) {
    try {
      monaco.editor.defineTheme(theme.id, theme.editorTheme)
    } catch (error) {
      // 单套主题数据异常不应影响其他主题与内置主题
      console.warn(`注册导入主题失败：${theme.label}`, error)
    }
  }
  allThemes = [...BUILTIN_THEMES, ...importedThemes]
  themeById = new Map(allThemes.map((theme) => [theme.id, theme] as const))
  // 当前主题被删除时回退到内置默认主题；当前主题是导入主题时重放一次，应用可能更新过的配色
  if (!themeById.has(activeThemeId)) {
    applyTheme(resolveInitialThemeId())
    return
  }
  if (importedThemes.some((theme) => theme.id === activeThemeId)) {
    applyTheme(activeThemeId)
    return
  }
  publishThemes()
}

/** 从主进程重新读取导入主题（设置页导入/删除后调用） */
export async function syncImportedThemes(): Promise<void> {
  const records = await window.api.listImportedThemes()
  registerImportedThemes(records)
}

function readStoredThemeId(): ThemeId | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored !== null && themeById.has(stored)) {
      return stored
    }
  } catch {
    // localStorage 不可用时按未保存处理
  }
  return null
}

/** 默认主题文件被移除时回退到排序后的第一个主题 */
function resolveInitialThemeId(): ThemeId {
  return (
    readStoredThemeId() ??
    (themeById.has(DEFAULT_THEME_ID) ? DEFAULT_THEME_ID : (allThemes[0]?.id ?? DEFAULT_THEME_ID))
  )
}

/**
 * 启动引导（main.tsx 在首屏渲染前调用）：
 * 先注册内置主题，再从 userData/themes 读取导入主题，最后应用已保存的主题。
 * 导入主题读取失败不应影响启动，回退到内置主题即可。
 */
export async function initThemes(): Promise<void> {
  for (const theme of BUILTIN_THEMES) {
    monaco.editor.defineTheme(theme.id, theme.editorTheme)
  }
  try {
    await syncImportedThemes()
  } catch (error) {
    console.warn('读取导入主题失败，本次启动只加载内置主题', error)
  }
  applyTheme(resolveInitialThemeId())
}

/** 应用主题：写入 CSS 变量与 color-scheme、切换 Monaco 主题、持久化选择并通知订阅者 */
export function applyTheme(id: ThemeId): void {
  const theme = themeById.get(id)
  if (!theme) {
    return
  }
  const root = document.documentElement
  for (const [name, value] of Object.entries(theme.vars)) {
    root.style.setProperty(name, value)
  }
  root.style.colorScheme = theme.kind
  root.dataset.theme = theme.id
  // 供 Tailwind 的 dark: 变体判断当前主题明暗（见 assets/main.css）
  root.dataset.themeKind = theme.kind
  monaco.editor.setTheme(theme.id)
  activeThemeId = theme.id
  try {
    window.localStorage.setItem(STORAGE_KEY, theme.id)
  } catch {
    // 持久化失败不影响本次应用
  }
  publishThemes()
}
