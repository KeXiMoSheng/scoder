/**
 * 渲染进程侧的轻量路径工具。
 * 渲染进程不引入 Node 的 path 模块，分隔符跟随传入路径本身的风格
 * （主进程用 path.join 生成路径，Windows 下为反斜杠），保证拼接结果与主进程一致。
 */

/** 路径使用的分隔符：含反斜杠视为 Windows 风格 */
export function pathSeparator(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

/** 取路径最后一段（文件名或目录名） */
export function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index === -1 ? path : path.slice(index + 1)
}

/** 取父目录路径；根路径（如 / 或 C:\）返回自身 */
export function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (index === -1) {
    return path
  }
  if (index === 0) {
    return path.slice(0, 1)
  }
  const parent = path.slice(0, index)
  // Windows 盘符根（C:）需要补回分隔符
  if (/^[A-Za-z]:$/.test(parent)) {
    return parent + pathSeparator(path)
  }
  return parent
}

/** 在目录路径下拼接子条目名 */
export function joinPath(dir: string, name: string): string {
  const separator = pathSeparator(dir)
  return dir.endsWith(separator) ? dir + name : dir + separator + name
}

/** child 是否为 base 本身或其子路径 */
export function isAtOrUnder(child: string, base: string): boolean {
  if (child === base) {
    return true
  }
  return child.startsWith(base + pathSeparator(base))
}
