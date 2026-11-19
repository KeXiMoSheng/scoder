import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { GIT_CHANNELS } from '../../shared/git/events'
import { getGitSettings } from '../db/git-settings'
import { readGitStatus } from './status'

/** 自动检测间隔（ms）：足以跟上保存、暂存等操作，又不会让 git 长期占 CPU */
const GIT_STATUS_INTERVAL = 2000

/**
 * Git 状态订阅（Electron IPC）：渲染进程打开一个项目时开始订阅，
 * 主进程按固定间隔运行 `git status`，只在状态真正变化时推送。
 * 渲染进程不必自己轮询，切换项目时停止订阅即可，不会为已关闭的目录继续跑 git。
 */

/** 每个窗口的订阅状态：一个窗口同时只看一个工作区 */
interface MonitorState {
  readonly sender: WebContents
  root: string
  timer: NodeJS.Timeout | null
  running: boolean
  /** 上一次推送的快照（JSON），相同就不再打扰渲染进程 */
  last: string | null
  stopped: boolean
}

const monitors = new Map<number, MonitorState>()
/** 已经挂过 destroyed 回收的窗口，避免重复注册 */
const watchedWindows = new Set<number>()

/**
 * 向渲染进程提供 Git 状态订阅：开始/立即刷新/停止，以及状态变化推送。
 * 注册一次即可，应用退出前统一回收。
 */
export function registerGitStatusHandlers(): void {
  ipcMain.handle(GIT_CHANNELS.watchStatus, (event, root: unknown): void => {
    if (typeof root !== 'string' || root.length === 0) {
      throw new Error('工作区路径无效')
    }
    const sender = event.sender
    let state = monitors.get(sender.id)
    if (state === undefined) {
      state = { sender, root, timer: null, running: false, last: null, stopped: false }
      monitors.set(sender.id, state)
      if (!watchedWindows.has(sender.id)) {
        watchedWindows.add(sender.id)
        sender.once('destroyed', () => {
          watchedWindows.delete(sender.id)
          stopMonitor(sender.id)
        })
      }
    }
    // 切换项目：沿用同一个定时器，只换目标与基线
    state.root = root
    state.last = null
    state.stopped = false
    if (state.timer === null) {
      state.timer = setInterval(() => {
        void pollOnce(state)
      }, GIT_STATUS_INTERVAL)
    }
    // 首帧立即读一次，文件树不必等下一个周期才有标记
    void pollOnce(state)
  })

  ipcMain.handle(GIT_CHANNELS.refreshStatus, (event): void => {
    const state = monitors.get(event.sender.id)
    if (state !== undefined) {
      void pollOnce(state)
    }
  })

  ipcMain.handle(GIT_CHANNELS.unwatchStatus, (event): void => {
    stopMonitor(event.sender.id)
  })
}

/** 设置变更后立即重读一次：新的 git 路径不必等到下一个周期才生效 */
export function nudgeGitStatusMonitors(): void {
  for (const state of monitors.values()) {
    state.last = null
    void pollOnce(state)
  }
}

/** 应用退出前停止全部定时器 */
export function disposeAllGitStatusMonitors(): void {
  for (const id of Array.from(monitors.keys())) {
    stopMonitor(id)
  }
}

/** 停止一个窗口的订阅：清定时器并丢弃状态，之后迟到的读取结果也被忽略 */
function stopMonitor(windowId: number): void {
  const state = monitors.get(windowId)
  if (state === undefined) {
    return
  }
  state.stopped = true
  if (state.timer !== null) {
    clearInterval(state.timer)
    state.timer = null
  }
  monitors.delete(windowId)
}

/** 读一次并只在变化时推送；同一窗口同一时刻最多一个 git 进程 */
async function pollOnce(state: MonitorState): Promise<void> {
  if (state.running || state.stopped) {
    return
  }
  state.running = true
  const root = state.root
  try {
    const snapshot = await readGitStatus(root, getGitSettings().gitPath)
    // 读取期间可能已经切换项目或停止订阅：这份结果已经过期，直接丢弃
    if (state.stopped || state.root !== root || monitors.get(state.sender.id) !== state) {
      return
    }
    const encoded = JSON.stringify(snapshot)
    if (encoded === state.last) {
      return
    }
    state.last = encoded
    if (!state.sender.isDestroyed()) {
      state.sender.send(GIT_CHANNELS.statusChanged, snapshot)
    }
  } finally {
    state.running = false
  }
}
