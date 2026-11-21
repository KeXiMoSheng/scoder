/**
 * 导入主题的持久化：一套主题一个 JSON，落在 userData/themes 下。
 *
 * 不放进 SQLite：主题数据是几十 KB 的配色表，放文件便于用户直接查看/清理，
 * 也避免 app_settings 单行 JSON 越积越大。读取时逐份校验，损坏的文件跳过而不是让启动失败。
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import {
  IMPORTED_THEME_ID_PATTERN,
  THEME_IMPORT_LIMITS,
  type ImportedTheme
} from '../../shared/theme/types'
import { sanitizeConvertedTheme } from '../../shared/theme/convert'
import type { ThemeDraft } from './import'

/** 存储文件版本：后续结构变化时用于迁移 */
const STORAGE_VERSION = 1

const STORED_FILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}\.json$/

/** userData/themes：与数据库、会话文件同级 */
function getImportedThemesDirectory(): string {
  return join(app.getPath('userData'), 'themes')
}

/** 读取全部已导入主题（按展示名排序）；目录不存在时返回空表 */
export async function listImportedThemes(): Promise<ImportedTheme[]> {
  const directory = getImportedThemesDirectory()
  let names: string[]
  try {
    names = await fs.readdir(directory)
  } catch (error) {
    if (isNotFound(error)) {
      return []
    }
    throw error
  }

  const themes: ImportedTheme[] = []
  for (const name of names) {
    if (!STORED_FILE_PATTERN.test(name)) {
      continue
    }
    const id = name.slice(0, -'.json'.length)
    try {
      const raw = await fs.readFile(join(directory, name), 'utf8')
      const theme = parseStoredTheme(JSON.parse(raw), id)
      if (theme) {
        themes.push(theme)
      }
    } catch (error) {
      // 单份文件损坏只跳过该主题：不能因为一个坏文件让主题菜单整体不可用
      console.warn(`导入主题无法读取，已跳过：${name}`, error)
    }
  }
  themes.sort((left, right) => left.label.localeCompare(right.label, 'zh-Hans-CN'))
  return themes
}

/**
 * 保存导入结果：同名主题重复导入会覆盖旧记录（id 由 label 稳定派生）。
 * @throws 超过主题数量上限
 */
export async function saveImportedThemes(drafts: readonly ThemeDraft[]): Promise<ImportedTheme[]> {
  if (drafts.length === 0) {
    return []
  }
  const directory = getImportedThemesDirectory()
  await fs.mkdir(directory, { recursive: true })

  const existing = new Set(
    (await fs.readdir(directory))
      .filter((name) => STORED_FILE_PATTERN.test(name))
      .map((name) => name)
  )

  // 同一批里同名主题只保留最后一份，避免一次导入生成多份同 id 文件
  const byId = new Map<string, ThemeDraft>()
  for (const draft of drafts) {
    byId.set(createImportedThemeId(draft.label), draft)
  }

  const newIds = [...byId.keys()].filter((id) => !existing.has(`${id}.json`))
  if (existing.size + newIds.length > THEME_IMPORT_LIMITS.maxThemes) {
    throw new Error(
      `导入主题数量将超过上限 ${THEME_IMPORT_LIMITS.maxThemes}，请先删除不再使用的主题`
    )
  }

  const importedAt = new Date().toISOString()
  const records: ImportedTheme[] = []
  for (const [id, draft] of byId) {
    const record: ImportedTheme = {
      id,
      label: draft.label,
      sourceName: draft.sourceName,
      importedAt,
      editorTheme: draft.editorTheme
    }
    const stored = { version: STORAGE_VERSION, ...record }
    await writeFileAtomic(join(directory, `${id}.json`), `${JSON.stringify(stored, null, 2)}\n`)
    records.push(record)
  }
  return records
}

/** 删除一套导入主题；文件不存在时返回 false */
export async function deleteImportedTheme(id: string): Promise<boolean> {
  if (!IMPORTED_THEME_ID_PATTERN.test(id)) {
    throw new Error('主题 id 无效')
  }
  try {
    await fs.unlink(join(getImportedThemesDirectory(), `${id}.json`))
    return true
  } catch (error) {
    if (isNotFound(error)) {
      return false
    }
    throw error
  }
}

/**
 * 由展示名派生稳定 id：ASCII 名保留可读 slug，纯中文名退化为哈希。
 * 同名主题再导入会命中同一 id 并覆盖，避免菜单里堆出多份同名项。
 */
export function createImportedThemeId(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const suffix = hashLabel(label)
  return `user-${slug ? `${slug}-` : ''}${suffix}`
}

/** FNV-1a 32 位：只用于生成 id，不做安全用途 */
function hashLabel(label: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** 逐字段校验存储文件；结构不对时返回 null 由调用方跳过 */
function parseStoredTheme(raw: unknown, id: string): ImportedTheme | null {
  if (!IMPORTED_THEME_ID_PATTERN.test(id) || typeof raw !== 'object' || raw === null) {
    return null
  }
  const record = raw as Record<string, unknown>
  const label = typeof record.label === 'string' ? record.label.trim() : ''
  const editorTheme = sanitizeConvertedTheme(record.editorTheme)
  if (label === '' || !editorTheme) {
    return null
  }
  return {
    id,
    label: label.slice(0, 120),
    sourceName: typeof record.sourceName === 'string' ? record.sourceName : '未知来源',
    importedAt:
      typeof record.importedAt === 'string' ? record.importedAt : new Date().toISOString(),
    editorTheme
  }
}

/** 先写临时文件再改名：中途崩溃不会留下半份 JSON */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(temporary, content, 'utf8')
  try {
    await fs.rename(temporary, filePath)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
