import { monaco } from './monaco'

// 自动发现 public/theme/ 目录下的 *-monaco.json（转换工具生成的 Monaco 版数据，由 Vite 在构建/开发时展开为静态导入）：
// 主题 id = 文件名剥离 -monaco 后缀；其 colors 段与原版主题一致，同时作为应用 UI 的取色来源
// 新增主题只需把「主题名-monaco.json」放进 public/theme/ 目录，无需改动本文件
// 注意：原版 .json 为 JSONC（带注释），不参与构建，仅作为资料保留
const themeModules = import.meta.glob('@theme/*-monaco.json', { eager: true }) as Record<
  string,
  { default: ThemeFileData }
>

const MONACO_SUFFIX = '-monaco.json'

/** *-monaco.json 的数据结构（含 inherit/base/colors/rules/encodedTokensColors 字段） */
interface ThemeFileData {
  /** 编辑器基础主题 */
  base?: string
  colors?: Record<string, string>
}

export type ThemeId = string

/** 应用 UI 使用的 CSS 变量（与 assets/main.css 中的变量一一对应） */
export type CssVarName =
  | '--bg'
  | '--bg-elevated'
  | '--bg-hover'
  | '--border'
  | '--text'
  | '--text-dim'
  | '--accent'
  | '--accent-hover'
  | '--accent-foreground'
  | '--selection'
  | '--error'

export interface AppTheme {
  id: ThemeId
  /** 下拉框显示名，取自文件名 */
  label: string
  /** 明暗类型：写入 color-scheme，控制原生滚动条与下拉控件的明暗 */
  kind: 'light' | 'dark'
  vars: Record<CssVarName, string>
  /** 注册到 Monaco 的完整主题数据（来自 *-monaco.json） */
  editorTheme: monaco.editor.IStandaloneThemeData
}

// UI 变量 → 主题 colors 段候选键：按序取第一个存在的值；全部缺失时回退到 extractVars 中的兜底值
const VAR_COLOR_KEYS: Record<CssVarName, readonly string[]> = {
  '--bg': ['editor.background'],
  '--bg-elevated': ['sideBar.background', 'editorGroupHeader.tabsBackground'],
  '--bg-hover': ['list.hoverBackground', 'list.activeSelectionBackground'],
  '--border': ['sideBar.border', 'panel.border', 'editorGroupHeader.tabsBorder'],
  '--text': ['editor.foreground', 'foreground'],
  '--text-dim': ['tab.inactiveForeground', 'statusBar.foreground', 'tab.activeForeground'],
  '--accent': ['button.background'],
  '--accent-hover': ['button.hoverBackground'],
  '--accent-foreground': ['button.foreground'],
  '--selection': ['list.activeSelectionBackground', 'list.hoverBackground'],
  '--error': ['errorForeground', 'chat.linesRemovedForeground']
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
  return {
    '--bg': bg,
    '--bg-elevated': pick('--bg-elevated') ?? bg,
    '--bg-hover': pick('--bg-hover') ?? bg,
    '--border': pick('--border') ?? bg,
    '--text': text,
    '--text-dim': pick('--text-dim') ?? text,
    '--accent': accent,
    // 主题未提供 hover 色时，向白（深色主题）/ 黑（浅色主题）混合少量派生
    '--accent-hover':
      pick('--accent-hover') ?? mixHex(accent, kind === 'dark' ? '#ffffff' : '#000000', 0.08),
    '--accent-foreground': pick('--accent-foreground') ?? '#ffffff',
    '--selection': pick('--selection') ?? pick('--bg-hover') ?? bg,
    '--error': pick('--error') ?? '#e05561'
  }
}

function discoverThemes(): AppTheme[] {
  const themes: AppTheme[] = []
  for (const [path, mod] of Object.entries(themeModules)) {
    const fileName = path.split('/').pop()
    if (!fileName) {
      continue
    }
    const id = fileName.slice(0, -MONACO_SUFFIX.length)
    const kind = BASE_KINDS[mod.default.base ?? ''] ?? 'dark'
    themes.push({
      id,
      label: id,
      kind,
      vars: extractVars(mod.default.colors ?? {}, kind),
      editorTheme: mod.default as unknown as monaco.editor.IStandaloneThemeData
    })
  }
  themes.sort((a, b) => a.id.localeCompare(b.id))
  return themes
}

/** public/theme/ 目录中发现的全套主题（按文件名排序；新增文件后无需改动代码） */
export const APP_THEMES: readonly AppTheme[] = discoverThemes()

const DEFAULT_THEME_ID = 'one-dark-pro'

const STORAGE_KEY = 'scoder.theme'

const THEME_BY_ID = new Map<string, AppTheme>(APP_THEMES.map((theme) => [theme.id, theme] as const))

let activeThemeId: ThemeId = APP_THEMES[0]?.id ?? DEFAULT_THEME_ID

export function getActiveThemeId(): ThemeId {
  return activeThemeId
}

function readStoredThemeId(): ThemeId | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored !== null && THEME_BY_ID.has(stored)) {
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
    (THEME_BY_ID.has(DEFAULT_THEME_ID) ? DEFAULT_THEME_ID : (APP_THEMES[0]?.id ?? DEFAULT_THEME_ID))
  )
}

/** 启动引导（main.tsx 在首屏渲染前调用）：注册全部 Monaco 主题并应用已保存的主题 */
export function initTheme(): void {
  for (const theme of APP_THEMES) {
    monaco.editor.defineTheme(theme.id, theme.editorTheme)
  }
  applyTheme(resolveInitialThemeId())
}

/** 应用主题：写入 CSS 变量与 color-scheme、切换 Monaco 主题、持久化选择 */
export function applyTheme(id: ThemeId): void {
  const theme = THEME_BY_ID.get(id)
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
}
