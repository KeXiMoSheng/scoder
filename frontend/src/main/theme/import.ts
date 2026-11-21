/**
 * 导入 VS Code 主题：
 * - 单文件：.json / .jsonc 配色主题（支持 include 继承链）
 * - 扩展包：.vsix / .zip，读取 contributes.themes 后逐套导入
 * - 解压后的扩展：直接选择扩展根目录的 package.json，也能按清单找到主题文件
 *
 * 这里只产出待持久化的 ThemeDraft，不接触 Electron / 磁盘写入策略，
 * 便于用脚本单独验证转换与解包逻辑。
 */
import { promises as fs } from 'fs'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'path'
import {
  THEME_IMPORT_LIMITS,
  type ConvertedEditorTheme,
  type ThemeImportError
} from '../../shared/theme/types'
import {
  convertThemeToMonaco,
  isThemeLike,
  loadThemeWithIncludes,
  parseThemeJsonc,
  type ThemeSource
} from '../../shared/theme/convert'
import { looksLikeZip, openVsixThemePackage } from './vsix'

/** 待落库的一套主题 */
export interface ThemeDraft {
  label: string
  sourceName: string
  editorTheme: ConvertedEditorTheme
}

/** 单个文件可能产出多套主题（.vsix），失败的主题只记错误、不阻断其他主题 */
export interface ThemeFileImportResult {
  drafts: ThemeDraft[]
  errors: ThemeImportError[]
}

/** 清单里声明的一套主题（本地文件版） */
interface ManifestThemeRef {
  label: string
  path: string
  uiTheme?: string
}

/**
 * 导入一个用户选择的文件。
 * 文件级错误直接抛给调用方；包内/清单内单套主题的失败记在 errors 里继续。
 */
export async function importThemeFile(filePath: string): Promise<ThemeFileImportResult> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) {
    throw new Error('请选择主题文件')
  }
  const ext = extname(filePath).toLowerCase()
  const sourceName = basename(filePath)

  if (ext === '.vsix' || ext === '.zip' || (await fileLooksLikeZip(filePath))) {
    if (stat.size > THEME_IMPORT_LIMITS.maxPackageFileBytes) {
      throw new Error(
        `扩展包超过 ${Math.round(THEME_IMPORT_LIMITS.maxPackageFileBytes / 1024 / 1024)} MB，已拒绝导入`
      )
    }
    return importVsix(await fs.readFile(filePath), sourceName)
  }

  if (stat.size > THEME_IMPORT_LIMITS.maxThemeFileBytes) {
    throw new Error(
      `主题文件超过 ${Math.round(THEME_IMPORT_LIMITS.maxThemeFileBytes / 1024 / 1024)} MB，已拒绝导入`
    )
  }

  const parsed = parseThemeJsonc(await fs.readFile(filePath, 'utf8'))
  if (isThemeLike(parsed)) {
    const themeSource = createFileThemeSource(dirname(filePath))
    const theme = await loadThemeWithIncludes(themeSource, resolve(filePath))
    const fallbackLabel = basename(filePath, extname(filePath))
    return {
      drafts: [createDraft(theme, fallbackLabel, sourceName)],
      errors: []
    }
  }

  const refs = readManifestThemeRefs(parsed)
  if (refs.length === 0) {
    throw new Error('文件里没有主题配色，也没有扩展的主题声明（contributes.themes）')
  }
  if (refs.length > THEME_IMPORT_LIMITS.maxThemesPerPackage) {
    throw new Error(
      `扩展声明了 ${refs.length} 套主题，超过单次导入上限 ${THEME_IMPORT_LIMITS.maxThemesPerPackage}`
    )
  }
  return importManifestThemes(dirname(filePath), refs, sourceName)
}

/** .vsix：清单里的每套主题独立转换，单套失败不影响其余主题 */
async function importVsix(buffer: Buffer, sourceName: string): Promise<ThemeFileImportResult> {
  const themePackage = openVsixThemePackage(buffer)
  return importThemesFromRefs(themePackage.refs, themePackage.source, sourceName)
}

/** 解压后的扩展：按 manifest 中的相对路径读取本地主题文件 */
async function importManifestThemes(
  extensionDir: string,
  refs: ManifestThemeRef[],
  sourceName: string
): Promise<ThemeFileImportResult> {
  const source = createFileThemeSource(extensionDir)
  const drafts: ThemeDraft[] = []
  const errors: ThemeImportError[] = []
  for (const ref of refs) {
    const themePath = resolve(extensionDir, ref.path)
    if (!isInside(extensionDir, themePath)) {
      errors.push({ file: sourceName, message: `主题路径越界：${ref.path}` })
      continue
    }
    try {
      const theme = await loadThemeWithIncludes(source, themePath)
      drafts.push(createDraft(theme, ref.label, sourceName, ref.uiTheme, ref.label))
    } catch (error) {
      errors.push({ file: sourceName, message: `${ref.path}: ${errorMessage(error)}` })
    }
  }
  return { drafts, errors }
}

/** 公共循环：.vsix 与本地 manifest 都按「引用 + 读取来源」逐套转换 */
async function importThemesFromRefs(
  refs: readonly { label: string; key: string; uiTheme?: string }[],
  source: ThemeSource,
  sourceName: string
): Promise<ThemeFileImportResult> {
  const drafts: ThemeDraft[] = []
  const errors: ThemeImportError[] = []
  for (const ref of refs) {
    try {
      const theme = await loadThemeWithIncludes(source, ref.key)
      drafts.push(createDraft(theme, ref.label, sourceName, ref.uiTheme, ref.label))
    } catch (error) {
      errors.push({ file: sourceName, message: `${ref.key}: ${errorMessage(error)}` })
    }
  }
  return { drafts, errors }
}

/** 本地主题来源：include 只允许落在扩展目录内，避免清单带出目录外文件 */
function createFileThemeSource(rootDir: string): ThemeSource {
  return {
    resolve: (reference: string, fromKey: string): string => resolve(dirname(fromKey), reference),
    read: async (key: string): Promise<unknown> => {
      if (!isInside(rootDir, key)) {
        throw new Error(`主题 include 指向扩展目录之外：${key}`)
      }
      const stat = await fs.stat(key)
      if (!stat.isFile()) {
        throw new Error(`主题 include 指向的不是文件：${key}`)
      }
      if (stat.size > THEME_IMPORT_LIMITS.maxThemeFileBytes) {
        throw new Error(`主题 include 文件超过大小上限：${key}`)
      }
      return parseThemeJsonc(await fs.readFile(key, 'utf8'))
    }
  }
}

/**
 * 组合成待落库记录：preferredLabel（扩展清单里的展示名）优先，
 * 其次是主题自带的 name，最后回退到文件名。
 */
function createDraft(
  theme: unknown,
  fallbackLabel: string,
  sourceName: string,
  uiTheme?: string,
  preferredLabel?: string
): ThemeDraft {
  const converted = convertThemeToMonaco(theme, { uiTheme })
  const label = (preferredLabel || converted.label || fallbackLabel || '未命名主题')
    .trim()
    .slice(0, 120)
  return {
    label: label || '未命名主题',
    sourceName,
    editorTheme: converted.editorTheme
  }
}

/** 扩展 package.json 里的 contributes.themes（VS Code 允许 path 省略 ./ 前缀） */
function readManifestThemeRefs(manifest: unknown): ManifestThemeRef[] {
  const record = asRecord(manifest)
  const contributes = asRecord(record?.contributes)
  const themes = Array.isArray(contributes?.themes) ? contributes.themes : []
  const refs: ManifestThemeRef[] = []
  for (const item of themes) {
    const definition = asRecord(item)
    const themePath = typeof definition?.path === 'string' ? definition.path.trim() : ''
    if (themePath === '') {
      continue
    }
    const label =
      typeof definition?.label === 'string' && definition.label.trim() !== ''
        ? definition.label.trim()
        : basename(themePath, extname(themePath))
    const uiTheme = typeof definition?.uiTheme === 'string' ? definition.uiTheme : undefined
    refs.push({ label, path: themePath, uiTheme })
  }
  return refs
}

/** 文件头识别 ZIP：避免用户把 .vsix 改名成 .json 后误报 JSON 解析错误 */
async function fileLooksLikeZip(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, 'r')
  try {
    const sample = Buffer.alloc(4)
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
    return bytesRead === sample.length && looksLikeZip(sample)
  } finally {
    await handle.close()
  }
}

/** target 是否等于 root 或位于 root 之下（不做符号链接解析） */
function isInside(root: string, target: string): boolean {
  const relativePath = relative(root, target)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}
