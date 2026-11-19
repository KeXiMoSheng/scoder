import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitFileStatus, GitStatusSnapshot } from '@shared/git/types'
import { joinPath } from '../lib/filePath'

/** 工作区 Git 状态的可读形态：绝对路径 → 状态 */
export interface GitStatusState {
  /** 工作区是否处在 Git 仓库里；false 时文件树不展示任何标记 */
  isRepo: boolean
  /** 变化的文件，按文件树节点的绝对路径索引 */
  statuses: ReadonlyMap<string, GitFileStatus>
  /** 读取失败的原因（例如找不到 git），仅用于诊断 */
  error: string | null
}

/** 空状态：没有订阅或工作区不是仓库时使用，保持引用稳定 */
const EMPTY: GitStatusState = { isRepo: false, statuses: new Map(), error: null }

/**
 * 把主进程给出的相对路径拼成与文件树节点一致的绝对路径。
 * 逐段拼接而不是直接替换分隔符：Windows 下工作区根用反斜杠，
 * 而 git 用 `/` 分隔，逐段 join 才能得到与 readDirectory 相同的键。
 * @param root 工作区根目录绝对路径
 * @param relativePath 相对工作区根的 `/` 分隔路径
 * @returns 节点的绝对路径
 */
function absolutePath(root: string, relativePath: string): string {
  return relativePath.split('/').reduce((path, segment) => joinPath(path, segment), root)
}

/**
 * 把一次快照换算成按节点绝对路径索引的状态。
 * @param root 工作区根目录绝对路径
 * @param snapshot 主进程推送的快照
 * @returns 绝对路径 → 状态
 */
export function statusMapOf(
  root: string,
  snapshot: GitStatusSnapshot
): ReadonlyMap<string, GitFileStatus> {
  const statuses = new Map<string, GitFileStatus>()
  for (const entry of snapshot.entries) {
    statuses.set(absolutePath(root, entry.path), entry.status)
  }
  return statuses
}

/**
 * 订阅一个工作区的 Git 状态。
 *
 * 订阅期间主进程按固定间隔自动检测，只把变化推回来；切换或关闭项目时解除订阅，
 * 主进程不会为已经不可见的目录继续运行 git。
 * @param rootPath 工作区根目录绝对路径；null 表示没有打开项目
 * @param onStatuses 每次推送后的回调：文件树在这里一次性地把「已删除」条目补进树，
 *   不必再用 effect 把渲染数据写回状态
 * @returns 是否仓库、按节点绝对路径索引的状态，以及读取失败原因
 */
export function useGitStatus(
  rootPath: string | null,
  onStatuses?: (statuses: ReadonlyMap<string, GitFileStatus>) => void
): GitStatusState {
  // 快照连同它对应的根目录一起保存：切换项目后旧快照不会短暂地标记到新项目上
  const [received, setReceived] = useState<{ root: string; snapshot: GitStatusSnapshot } | null>(
    null
  )
  const callbackRef = useRef(onStatuses)
  useEffect(() => {
    callbackRef.current = onStatuses
  }, [onStatuses])

  useEffect(() => {
    if (rootPath === null) {
      return
    }
    let active = true
    const unsubscribe = window.api.onGitStatusChanged((event) => {
      // 切换项目后旧项目的推送可能迟到，按根目录丢弃
      if (!active || event.root !== rootPath) {
        return
      }
      setReceived({ root: rootPath, snapshot: event })
      // 从外部系统收到变化：在这里更新由它派生的树数据，而不是在 effect 里回写
      callbackRef.current?.(event.isRepo ? statusMapOf(rootPath, event) : new Map())
    })
    void window.api.watchGitStatus(rootPath).catch(() => undefined)
    return () => {
      active = false
      unsubscribe()
      void window.api.unwatchGitStatus().catch(() => undefined)
    }
  }, [rootPath])

  return useMemo(() => {
    if (rootPath === null || received === null || received.root !== rootPath) {
      return EMPTY
    }
    const { snapshot } = received
    if (!snapshot.isRepo) {
      return EMPTY
    }
    return {
      isRepo: true,
      statuses: statusMapOf(rootPath, snapshot),
      error: snapshot.error ?? null
    }
  }, [rootPath, received])
}
