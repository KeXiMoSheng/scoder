/**
 * 会话级的"已读"观测表：先读后改策略的状态。
 *
 * 与 deepseek-harness 的 fs-observation-policy 同构，但不引入依赖注入与事件总线：
 * 记录与查询都是普通方法调用。状态只活在主进程内存、按会话隔离——
 * 换会话或重启进程后模型必须重新 read，才能拿到可以安全覆盖的版本基准。
 */
import type { FsTarget, FsWriteIntent } from './service'

/** 一次权威观测：present 带版本令牌，absent 表示确认不存在 */
export type FsObservation = { kind: 'present'; version: string } | { kind: 'absent' }

export class ObservationStore {
  /** sessionId → target.key → 观测 */
  private readonly bySession = new Map<string, Map<string, FsObservation>>()

  /** 记录一次观测：read 成功、以及 write/edit 落盘之后 */
  record(sessionId: string, target: FsTarget, observation: FsObservation): void {
    let seen = this.bySession.get(sessionId)
    if (!seen) {
      seen = new Map()
      this.bySession.set(sessionId, seen)
    }
    seen.set(target.key, observation)
  }

  /**
   * 写入意图：没读过或确认不存在时只允许新建；
   * 读过时用读到的版本做 CAS，挡住"读到之后文件又被改过"。
   * 这样未读过的已有文件不会被整文件覆盖。
   */
  writeIntent(sessionId: string, target: FsTarget): FsWriteIntent {
    const prior = this.bySession.get(sessionId)?.get(target.key)
    return prior?.kind === 'present'
      ? { kind: 'replaceIfVersion', version: prior.version }
      : { kind: 'createIfAbsent' }
  }

  /**
   * 编辑守卫：编辑必须基于一次成功的 read。
   * 未观测时直接拒绝——这是"先读后改"真正生效的地方。
   */
  editIntent(sessionId: string, target: FsTarget): { version: string } {
    const prior = this.bySession.get(sessionId)?.get(target.key)
    if (prior === undefined) {
      throw new Error(`编辑前必须先 read 确认内容：${target.displayPath}`)
    }
    if (prior.kind === 'absent') {
      throw new Error(`文件不存在：${target.displayPath}`)
    }
    return { version: prior.version }
  }

  /** 丢弃某个会话的观测（会话关闭时调用） */
  forget(sessionId: string): void {
    this.bySession.delete(sessionId)
  }
}
