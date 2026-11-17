/**
 * AI 改动的 diff 基线快照。
 *
 * 每轮对话第一次写入/编辑某个文件时，把“改动前内容”存成一份快照：
 * - 不写进会话 jsonl：整份文件内容会把日志撑大，且打开会话时会被整份读进内存；
 * - 按 项目 / 会话 / 轮次 / 路径哈希 分层存放，重开会话或重启应用后仍可查看当轮 diff；
 * - 文件内容为 LF 换行，与 AI 文件服务的 diff 基准一致。
 */
import { createHash } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { AiFileReview } from '../../../shared/ai/types'
import { projectKey } from '../session/jsonl'

/** 快照根目录名：位于 Electron userData 之下 */
export const CHANGE_SNAPSHOT_DIR_NAME = 'ai-change-snapshots'

/** 会话审查进度文件名：与各轮的基线快照放在同一会话目录下 */
const REVIEWS_FILE = 'reviews.json'

/** 改动基线快照仓库 */
export class ChangeSnapshotStore {
  /**
   * @param resolveRoot 快照根目录解析器；首次使用时才求值，
   *   避免模块加载阶段就依赖 Electron 的 app 是否可用
   */
  constructor(private readonly resolveRoot: () => string) {}

  /**
   * 保存一份改动基线。
   * @param before 改动前内容；null（新建文件或读取失败）没有可保存的快照
   * @returns 是否真的写出了快照
   */
  async saveBaseline(
    cwd: string,
    sessionId: string,
    turn: number,
    path: string,
    before: string | null
  ): Promise<boolean> {
    if (before === null) {
      return false
    }
    const file = this.fileFor(cwd, sessionId, turn, path)
    await mkdir(dirname(file), { recursive: true })
    // 统一 LF：渲染进程读到的当前文件也会归一化到 LF，CRLF 文件不能因此每行都显示成改动
    await writeFile(file, before.replace(/\r\n/g, '\n'), 'utf8')
    return true
  }

  /** 读取一份改动基线；不存在或读失败时返回 null */
  async readBaseline(
    cwd: string,
    sessionId: string,
    turn: number,
    path: string
  ): Promise<string | null> {
    try {
      return await readFile(this.fileFor(cwd, sessionId, turn, path), 'utf8')
    } catch {
      return null
    }
  }

  /** 读取一个会话的全部文件审查进度；文件不存在或损坏时返回空数组 */
  async readReviews(cwd: string, sessionId: string): Promise<AiFileReview[]> {
    try {
      const text = await readFile(this.reviewsFile(cwd, sessionId), 'utf8')
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return []
      }
      return Object.values(parsed).filter(isAiFileReview)
    } catch {
      return []
    }
  }

  /** 读取一个文件的审查进度；没有记录时返回 null */
  async readReview(cwd: string, sessionId: string, path: string): Promise<AiFileReview | null> {
    const reviews = await this.readReviews(cwd, sessionId)
    return reviews.find((review) => review.path === path) ?? null
  }

  /** 覆盖一个文件的审查进度（整个会话共用一个 reviews.json） */
  async saveReview(cwd: string, sessionId: string, review: AiFileReview): Promise<void> {
    const reviews = await this.readReviews(cwd, sessionId)
    const byPath = new Map(reviews.map((entry) => [entry.path, entry]))
    byPath.set(review.path, review)
    const file = this.reviewsFile(cwd, sessionId)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(Object.fromEntries(byPath), null, 2), 'utf8')
  }

  /** 删除一个会话的全部快照（会话日志被删除时调用，避免快照目录残留） */
  async removeSession(cwd: string, sessionId: string): Promise<void> {
    await rm(join(this.resolveRoot(), projectKey(cwd), sessionId), {
      recursive: true,
      force: true
    })
  }

  /**
   * 快照路径：轮次做目录、文件路径做哈希文件名。
   * 路径可能包含 `..`、盘符或超长中文，直接当文件名不可靠，哈希后长度固定。
   */
  private fileFor(cwd: string, sessionId: string, turn: number, path: string): string {
    const digest = createHash('sha256').update(path, 'utf8').digest('hex')
    return join(this.resolveRoot(), projectKey(cwd), sessionId, String(turn), `${digest}.before`)
  }

  /** 审查进度文件路径 */
  private reviewsFile(cwd: string, sessionId: string): string {
    return join(this.resolveRoot(), projectKey(cwd), sessionId, REVIEWS_FILE)
  }
}

/** 判定一个值是否是合法的审查进度记录 */
function isAiFileReview(value: unknown): value is AiFileReview {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const { path, accepted, rejected, remaining, updatedAt } = value as Record<string, unknown>
  return (
    typeof path === 'string' &&
    typeof accepted === 'number' &&
    Number.isInteger(accepted) &&
    accepted >= 0 &&
    typeof rejected === 'number' &&
    Number.isInteger(rejected) &&
    rejected >= 0 &&
    typeof remaining === 'number' &&
    Number.isInteger(remaining) &&
    remaining >= 0 &&
    typeof updatedAt === 'number'
  )
}
