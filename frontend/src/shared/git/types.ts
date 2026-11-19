/**
 * Git 域：主进程返回、渲染进程消费的数据结构。
 *
 * 文件树只关心「相对工作区根的一个文件发生了什么」，因此路径统一为
 * `/` 分隔的相对路径，跨平台由主进程转换一次，渲染进程不再处理分隔符。
 */

/** 文件相对 Git 工作区的状态 */
export type GitFileStatus = 'added' | 'modified' | 'deleted'

/** 一个发生变化的文件 */
export interface GitStatusEntry {
  /** 相对工作区根的 `/` 分隔路径；不会为空 */
  path: string
  /** 变更类型 */
  status: GitFileStatus
}

/**
 * 一次 Git 状态读取的结果。
 * `root` 随每次推送带回，渲染进程据此丢弃切换项目后迟到的旧结果。
 */
export interface GitStatusSnapshot {
  /** 这次结果对应的工作区根目录绝对路径 */
  root: string
  /** 工作区是否处在 Git 仓库里；false 时 entries 为空，文件树不展示任何标记 */
  isRepo: boolean
  /** 变化的文件（已排序） */
  entries: GitStatusEntry[]
  /** 读取失败的原因（例如找不到 git）；仅用于诊断，不影响条目的展示 */
  error?: string
}

/** `git --version` 的探测结果 */
export interface GitVersionInfo {
  /** 实际执行的可执行文件（用户指定的路径或 PATH 上的 git） */
  file: string
  /** 解析出的版本号，例如 `2.43.0` */
  version: string
}
