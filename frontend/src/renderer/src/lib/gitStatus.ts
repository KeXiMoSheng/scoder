/**
 * Git 状态的展示与聚合规则。
 *
 * 主进程只给出「发生变化的文件」，而文件树、编辑器页签与 AI 变更清单需要
 * 一致的字母、颜色和目录聚合结果，因此这些规则集中在这里：
 * - 文件：新增 → addedBackground，修改 → modifiedBackground，删除 → deletedBackground
 * - 目录：子孙文件只有一种状态时沿用该状态；出现两种及以上状态时统一按「已修改」
 *   （目录本身没有被删除，混合变更用修改色表达）
 */
import type { GitFileStatus } from '@shared/git/types'
import { dirname, isAtOrUnder } from './filePath'

/** 单个状态的字母、无障碍文案与文字颜色类名 */
export const GIT_STATUS_META: Record<
  GitFileStatus,
  { letter: string; label: string; className: string }
> = {
  added: { letter: 'A', label: '新增文件', className: 'text-git-added' },
  modified: { letter: 'M', label: '已修改', className: 'text-git-modified' },
  deleted: { letter: 'D', label: '已删除', className: 'text-git-deleted' }
}

/** 状态对应的文字颜色类名（文件名、目录名与行尾标记共用） */
export const GIT_STATUS_TEXT_CLASS: Record<GitFileStatus, string> = {
  added: GIT_STATUS_META.added.className,
  modified: GIT_STATUS_META.modified.className,
  deleted: GIT_STATUS_META.deleted.className
}

/** 把 AI 改动清单里的 git 记号（A/M/D）换算成文件状态 */
export function statusFromChangeCode(code: 'A' | 'M' | 'D'): GitFileStatus {
  if (code === 'A') {
    return 'added'
  }
  if (code === 'D') {
    return 'deleted'
  }
  return 'modified'
}

/** 聚合用的状态位：单一位表示目录下只有这一种变化 */
const STATUS_BITS: Record<GitFileStatus, number> = {
  added: 1,
  modified: 2,
  deleted: 4
}

/** 单一状态原样返回，两种及以上统一归为「已修改」 */
function statusFromMask(mask: number): GitFileStatus {
  if (mask === STATUS_BITS.added) {
    return 'added'
  }
  if (mask === STATUS_BITS.deleted) {
    return 'deleted'
  }
  return 'modified'
}

/**
 * 由文件状态聚合出每个上级目录的状态。
 *
 * 目录本身没有 Git 条目，状态完全来自子孙文件：
 * - 只有一个状态（全是新增 / 全是修改 / 全是删除）→ 目录沿用该状态；
 * - 同时存在多个状态 → 目录统一显示「已修改」；
 * - 没有变化 → 不返回该目录。
 * 根目录也会参与聚合，因此文件树最上层的当前目录同样会着色并显示状态标记。
 * @param rootPath 工作区根目录绝对路径（根目录本身也会得到状态）
 * @param statuses 文件绝对路径 → 状态
 * @returns 目录绝对路径 → 聚合状态；没有任何变化的目录不在结果中
 */
export function buildDirectoryGitStatuses(
  rootPath: string,
  statuses: ReadonlyMap<string, GitFileStatus>
): ReadonlyMap<string, GitFileStatus> {
  // 用位掩码累计每个目录下出现过的状态，最后按「单一状态 / 混合状态」归一
  const masks = new Map<string, number>()
  for (const [path, status] of statuses) {
    if (path === rootPath || !isAtOrUnder(path, rootPath)) {
      continue
    }
    const bit = STATUS_BITS[status]
    let directory = dirname(path)
    while (isAtOrUnder(directory, rootPath)) {
      masks.set(directory, (masks.get(directory) ?? 0) | bit)
      if (directory === rootPath) {
        break
      }
      const parent = dirname(directory)
      // 盘符根等无法再上溯的路径：避免死循环
      if (parent === directory) {
        break
      }
      directory = parent
    }
  }

  const result = new Map<string, GitFileStatus>()
  for (const [directory, mask] of masks) {
    result.set(directory, statusFromMask(mask))
  }
  return result
}
