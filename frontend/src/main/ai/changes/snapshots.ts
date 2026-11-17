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
import { projectKey } from '../session/jsonl'

/** 快照根目录名：位于 Electron userData 之下 */
export const CHANGE_SNAPSHOT_DIR_NAME = 'ai-change-snapshots'

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
}
