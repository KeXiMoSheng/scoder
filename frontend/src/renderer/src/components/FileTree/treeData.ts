/**
 * 文件树的纯数据逻辑：磁盘条目 → 节点，以及把「Git 里已删除、磁盘上已不存在」的条目补回树中。
 *
 * 与组件分开，是因为这些规则决定了树显示什么，值得脱离 React 单独验证：
 * 合并必须保留已展开子树的节点引用，删除条目必须在状态刷新时增删而不用重读磁盘。
 */
import type { FileEntry } from '@shared/files/types'
import type { GitFileStatus } from '@shared/git/types'
import { basename, dirname, isAtOrUnder } from '../../lib/filePath'
import type { FileNode } from './types'

/** 目录节点初始给空数组，使其保持可展开形态（react-arborist 以 children 是否为数组判定叶子） */
export function toFileNode(entry: FileEntry): FileNode {
  return { ...entry, children: entry.isDirectory ? [] : undefined }
}

/**
 * 目录条目与当前节点列表是否完全一致（名称、类型、顺序）：
 * 一致时保留原引用，避免保存文件等「只有内容变化」的事件引发整树重渲染。
 */
export function sameEntries(nodes: FileNode[], entries: FileEntry[]): boolean {
  if (nodes.length !== entries.length) {
    return false
  }
  for (let index = 0; index < entries.length; index++) {
    const node = nodes[index]
    const entry = entries[index]
    if (
      node.path !== entry.path ||
      node.name !== entry.name ||
      node.isDirectory !== entry.isDirectory
    ) {
      return false
    }
  }
  return true
}

/**
 * 工作区里已删除、但仓库仍记录着的条目：按「父目录 → 合成子节点」索引。
 *
 * 这些条目在磁盘上已经不存在，readDirectory 永远读不到，只能由 Git 状态补出来；
 * 目录同理（整目录删除时 git 只列文件，这里按路径补出中间目录）。
 */
export interface DeletedIndex {
  /** 目录绝对路径 → 该目录下需要补出的子节点 */
  readonly children: ReadonlyMap<string, readonly FileNode[]>
  /** 全部合成节点的路径，用于判断某个合成节点是否仍然需要 */
  readonly paths: ReadonlySet<string>
}

/** 没有已删除条目时的索引：保持引用稳定，避免无谓的重算 */
export const NO_DELETED: DeletedIndex = { children: new Map(), paths: new Set() }

/**
 * 由 Git 状态构造已删除条目的索引。
 * @param rootPath 工作区根目录绝对路径
 * @param statuses 绝对路径 → 状态
 * @returns 按父目录索引的合成节点
 */
export function buildDeletedIndex(
  rootPath: string,
  statuses: ReadonlyMap<string, GitFileStatus>
): DeletedIndex {
  const nodes = new Map<string, FileNode>()
  for (const [path, status] of statuses) {
    if (status !== 'deleted' || path === rootPath || !isAtOrUnder(path, rootPath)) {
      continue
    }
    nodes.set(path, { name: basename(path), path, isDirectory: false, gitDeleted: true })
    // 逐级补出所在目录，遇到已补过（含其祖先已补过）就停
    for (
      let parent = dirname(path);
      parent !== rootPath && isAtOrUnder(parent, rootPath);
      parent = dirname(parent)
    ) {
      if (nodes.has(parent)) {
        break
      }
      nodes.set(parent, {
        name: basename(parent),
        path: parent,
        isDirectory: true,
        children: [],
        gitDeleted: true
      })
    }
  }
  if (nodes.size === 0) {
    return NO_DELETED
  }
  const children = new Map<string, FileNode[]>()
  for (const node of nodes.values()) {
    const parentNode = nodes.get(dirname(node.path))
    if (parentNode !== undefined) {
      // 父目录也是补出来的：直接挂在它的 children 上
      parentNode.children = [...(parentNode.children ?? []), node]
      continue
    }
    const siblings = children.get(dirname(node.path)) ?? []
    siblings.push(node)
    children.set(dirname(node.path), siblings)
  }
  for (const siblings of children.values()) {
    sortFileNodes(siblings)
  }
  for (const node of nodes.values()) {
    if (node.children && node.children.length > 0) {
      sortFileNodes(node.children)
    }
  }
  return { children, paths: new Set(nodes.keys()) }
}

/**
 * 把合成节点并进一层节点。
 *
 * 两种情况必须分开处理：磁盘上已经不存在的条目直接追加；与磁盘条目同路径的
 * 合成「目录」说明该目录其实还在（只是其中的文件被删了），此时把它的子节点
 * 并进已有节点，而不是再添一个同名目录。已有节点没有 children（尚未展开）时
 * 只补出被删除的子项，展开后磁盘条目会补上其余内容。
 * @param nodes 当前层的真实节点
 * @param extra 该目录下由 Git 状态补出的节点
 * @returns 合并后的数组；没有变化时返回原引用
 */
export function adoptSynthetic(
  nodes: FileNode[],
  extra: readonly FileNode[],
  deleted: DeletedIndex
): FileNode[] {
  if (extra.length === 0) {
    return nodes
  }
  let changed = false
  const result = nodes.slice()
  for (const node of extra) {
    const index = result.findIndex((existing) => existing.path === node.path)
    if (index === -1) {
      result.push(node)
      changed = true
      continue
    }
    if (node.children === undefined || node.children.length === 0) {
      continue
    }
    const existing = result[index]
    const prevChildren = existing.children ?? []
    const children = adoptSynthetic(prevChildren, node.children, deleted)
    if (children !== prevChildren) {
      result[index] = { ...existing, children }
      changed = true
    }
  }
  return changed ? result : nodes
}

/**
 * 把目录最新条目合并为节点数组：路径未变的节点保留原对象（含已加载的深层子项），
 * 避免刷新后已展开的目录丢失内容；新增/类型变化的条目重建节点。
 * 同时补出该目录下已被删除、磁盘上不再存在的条目。
 * 条目完全一致时返回原数组，让上游的不可变更新能提前短路。
 */
export function mergeFileNodes(
  prevNodes: FileNode[],
  entries: FileEntry[],
  deleted: DeletedIndex,
  dirPath: string
): FileNode[] {
  const extra = deleted.children.get(dirPath) ?? []
  const stale = prevNodes.some((node) => node.gitDeleted === true && !deleted.paths.has(node.path))
  if (extra.length === 0 && !stale && sameEntries(prevNodes, entries)) {
    return prevNodes
  }
  const prevByPath = new Map(prevNodes.map((node) => [node.path, node]))
  const next = entries.map((entry) => {
    const existing = prevByPath.get(entry.path)
    if (existing && existing.isDirectory === entry.isDirectory) {
      return existing
    }
    return toFileNode(entry)
  })
  const merged = adoptSynthetic(next, extra, deleted)
  sortFileNodes(merged)
  // 已经不再删除、磁盘上又没有的合成节点直接移除（文件被恢复后不再显示）
  return merged.filter((node) => node.gitDeleted !== true || deleted.paths.has(node.path))
}

/**
 * 只按 Git 状态增删合成节点，不重读磁盘：状态刷新（保存、暂存、提交）时使用。
 * @param nodes 当前层的节点
 * @param dirPath 当前层所属目录的绝对路径
 * @param deleted 已删除条目索引
 * @returns 新的节点数组；没有变化时返回原引用
 */
export function applyDeleted(
  nodes: FileNode[],
  dirPath: string,
  deleted: DeletedIndex
): FileNode[] {
  const extra = deleted.children.get(dirPath) ?? []
  let changed = false
  // 合成节点整批重建：它们不保存展开状态，重建才能跟上最新的删除清单
  const kept = nodes.filter((node) => node.gitDeleted !== true)
  if (kept.length !== nodes.length) {
    changed = true
  }
  const recursed = kept.map((node) => {
    if (!node.isDirectory || !node.children || node.children.length === 0) {
      return node
    }
    const nextChildren = applyDeleted(node.children, node.path, deleted)
    if (nextChildren === node.children) {
      return node
    }
    changed = true
    return { ...node, children: nextChildren }
  })
  const merged = adoptSynthetic(recursed, extra, deleted)
  if (merged === recursed) {
    return changed ? recursed : nodes
  }
  sortFileNodes(merged)
  return merged
}

/** 在树数据中定位目录并按最新条目替换其 children（不可变更新；未命中分支保持原引用避免整树重渲染） */
export function injectChildren(
  nodes: FileNode[],
  dirPath: string,
  entries: FileEntry[],
  deleted: DeletedIndex
): FileNode[] {
  let changed = false
  const next = nodes.map((node) => {
    if (node.path === dirPath) {
      const prevChildren = node.children ?? []
      const nextChildren = mergeFileNodes(prevChildren, entries, deleted, node.path)
      if (nextChildren === prevChildren) {
        return node
      }
      changed = true
      return { ...node, children: nextChildren }
    }
    if (!node.children || node.children.length === 0) {
      return node
    }
    const nextChildren = injectChildren(node.children, dirPath, entries, deleted)
    if (nextChildren === node.children) {
      return node
    }
    changed = true
    return { ...node, children: nextChildren }
  })
  return changed ? next : nodes
}

/** 目录在前、名称不区分大小写升序（与主进程 readDirectory 的排序一致） */
export function sortFileNodes(nodes: FileNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  for (const node of nodes) {
    if (node.children && node.children.length > 0) {
      sortFileNodes(node.children)
    }
  }
}
