import { accessSync, constants, statSync } from 'fs'
import { posix, win32 } from 'path'

/**
 * 可执行文件探测：按当前平台的 PATH 规则查找，必要时再尝试常见安装目录。
 *
 * 这里刻意使用 `path.win32` / `path.posix` 而不是宿主默认的 `path`：
 * Windows 的 PATH 用 `;` 分隔、目录用 `\`，POSIX 用 `:` 与 `/`，
 * 两者不能混用，否则探测结果的目录分隔符会出错。
 */

const isWindows = process.platform === 'win32'

/** 当前平台的路径规则 */
const pathApi = isWindows ? win32 : posix

/** 去掉 PATH 项两侧可能存在的引号（Windows 用户常写成 "C:\Program Files\Git\cmd"） */
function unquote(entry: string): string {
  const trimmed = entry.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** 候选路径是否是可执行文件：Windows 看文件是否存在，POSIX 还需有执行权限 */
function isExecutable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) {
      return false
    }
    if (!isWindows) {
      accessSync(candidate, constants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

/**
 * 在 PATH 中查找可执行文件；找不到时再按顺序尝试额外的常见安装路径。
 * @param names 可执行文件名（Windows 需带 `.exe`）
 * @param extraPaths 常见安装路径（绝对路径；null 表示该平台没有这一项）
 * @returns 找到的绝对路径（使用当前系统的目录分隔符），否则 null
 */
export function findExecutable(
  names: readonly string[],
  extraPaths: readonly (string | null)[] = []
): string | null {
  const directories = (process.env.PATH ?? '').split(pathApi.delimiter)
  for (const entry of directories) {
    const directory = unquote(entry)
    // 相对路径依赖进程工作目录，且容易误命中；探测只接受绝对路径
    if (directory.length === 0 || !pathApi.isAbsolute(directory)) {
      continue
    }
    for (const name of names) {
      const candidate = pathApi.join(directory, name)
      if (isExecutable(candidate)) {
        return candidate
      }
    }
  }
  for (const candidate of extraPaths) {
    if (candidate !== null && pathApi.isAbsolute(candidate) && isExecutable(candidate)) {
      return candidate
    }
  }
  return null
}
