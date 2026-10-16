/** 主进程与渲染进程共享的类型定义 */

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

/** 经 preload contextBridge 暴露给渲染进程的文件系统能力（白名单方法） */
export interface ScoderAPI {
  /** 弹出系统目录选择框；用户取消时返回 null */
  openProjectDirectory: () => Promise<string | null>
  /** 读取目录单层内容（目录在前、名称升序），供文件树懒加载 */
  readDirectory: (dirPath: string) => Promise<FileEntry[]>
  /** 读取文本文件内容；二进制或超大文件会抛错 */
  readFile: (filePath: string) => Promise<string>
  /** 将文本写入文件（utf-8 覆盖写入），供编辑器保存 */
  writeFile: (filePath: string, content: string) => Promise<void>
  /** 重命名/拖拽移动文件或目录到目标绝对路径；目标已存在时报错 */
  moveEntry: (sourcePath: string, targetPath: string) => Promise<void>
  /** 删除文件或目录（目录递归删除）；弹出确认框，用户取消时返回 false */
  deleteEntry: (targetPath: string) => Promise<boolean>
  /** 以 rootPath 为根递归搜索名称包含关键词的条目（跳过噪音目录），最多返回 limit 条 */
  searchFiles: (rootPath: string, query: string, limit?: number) => Promise<SearchResult>
}
