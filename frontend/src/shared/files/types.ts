/** 文件系统域：主进程返回、渲染进程消费的条目标结构 */

/** 目录单层条目（文件树懒加载的数据源） */
export interface FileEntry {
  /** 条目名称（不含路径） */
  name: string
  /** 绝对路径（同时作为文件树节点唯一标识） */
  path: string
  /** 是否为目录 */
  isDirectory: boolean
}

/** 文件搜索（按名称子串匹配）的结果 */
export interface SearchResult {
  /** 命中的条目（目录与文件） */
  entries: FileEntry[]
  /** 结果是否因达到上限被截断 */
  truncated: boolean
}
