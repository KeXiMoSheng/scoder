/** 本轮改动清单的聚合规则：主进程重放与渲染进程实时追加共用同一份实现 */
import type { ToolFileChange } from './types'

/**
 * 把一次文件改动并进本轮清单。
 * 同一文件被连续改多次时行数累加；A/M 以本轮首次为准
 * （先新建后修改的文件仍然算本轮新增）。
 * @param previous 已有记录；undefined 表示本轮第一次遇到这个文件
 * @param next 本次改动
 */
export function mergeFileChange(
  previous: ToolFileChange | undefined,
  next: ToolFileChange
): ToolFileChange {
  if (!previous) return next
  return {
    path: next.path,
    added: previous.added + next.added,
    removed: previous.removed + next.removed,
    status: previous.status
  }
}
