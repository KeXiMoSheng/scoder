import { watch } from 'fs'
import type { FSWatcher } from 'fs'
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { basename, dirname } from 'path'
import { FILES_CHANNELS } from '../../shared/files/events'
import type { DirectoriesChangedEvent, FilesChangedEvent } from '../../shared/files/types'

/**
 * 磁盘监听（IPC 侧）：渲染进程把「文件树已加载的目录」与「编辑器已打开的文件」同步给主进程，
 * 主进程按目录合并挂原生 fs.watch，再把变化分派回两侧：
 * - 目录条目增删/改名 → 推 directoriesChanged，供文件树重读该目录；
 * - 打开文件的内容修改/原子替换 → 推 filesChanged，供编辑器判定外部修改。
 *
 * 只 watch 已加载目录与打开文件的父目录，而不是递归整个项目：
 * - 未展开目录在展开时自然读到最新内容，无需监听；
 * - 避免为 node_modules 等噪音目录建大量 inotify 句柄（文件树本就不显示它们）。
 */

/** 变更推送的去抖间隔（ms）：保存、批量 git 操作会连续产生多个事件，合并成一次刷新 */
const CHANGE_DEBOUNCE = 100

/** 单窗口 watcher 上限：超出说明目录树异常庞大，宁可停止新增也不耗尽 inotify 配额 */
const MAX_WATCHED_DIRECTORIES = 2000

/** 单个窗口的监听状态：两路关注集合共享同一批目录 watcher（窗口销毁时整体回收） */
interface WindowWatchState {
  windowId: number
  sender: WebContents
  /** 文件树已加载目录：其条目 rename 事件要推给文件树 */
  treeDirs: Set<string>
  /** 编辑器已打开（已缓存）的文件：内容变化或条目被替换时推送文件级事件 */
  filePaths: Set<string>
  /** 实际挂了 watcher 的目录（treeDirs 与 filePaths 父目录的并集）→ watcher */
  watchers: Map<string, FSWatcher>
  /** 去抖窗口内待推送的文件树目录 */
  pendingTreeDirs: Set<string>
  /** 去抖窗口内待推送的打开文件 */
  pendingFiles: Set<string>
  timer: NodeJS.Timeout | null
}

const windowStates = new Map<number, WindowWatchState>()

/** 校验并过滤渲染进程传入的路径数组（不做可信假设） */
function normalizePaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('参数无效')
  }
  return value.filter((path): path is string => typeof path === 'string' && path.length > 0)
}

/** 把某个目录下的关注对象标记为待推送（目录删除/监听失效时保守通知，交由渲染进程重读判定） */
function markDirectoryChanged(state: WindowWatchState, dirPath: string): void {
  if (state.treeDirs.has(dirPath)) {
    state.pendingTreeDirs.add(dirPath)
  }
  for (const filePath of state.filePaths) {
    if (dirname(filePath) === dirPath) {
      state.pendingFiles.add(filePath)
    }
  }
  scheduleChangePush(state)
}

/** 关闭单个目录的 watcher（已不存在时静默返回） */
function closeWatcher(state: WindowWatchState, dirPath: string): void {
  const watcher = state.watchers.get(dirPath)
  if (!watcher) {
    return
  }
  state.watchers.delete(dirPath)
  watcher.close()
}

/** 回收窗口的全部 watcher 与待推送状态 */
function disposeWindowState(state: WindowWatchState): void {
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
  state.pendingTreeDirs.clear()
  state.pendingFiles.clear()
  state.treeDirs.clear()
  state.filePaths.clear()
  // 先清空表再关闭：close 回调据此区分「主动关闭」与「监听自行失效」，避免误推送
  const watchers = Array.from(state.watchers.values())
  state.watchers.clear()
  for (const watcher of watchers) {
    watcher.close()
  }
  windowStates.delete(state.windowId)
}

/** 取（或首次创建）窗口的监听状态，并挂上销毁回收 */
function getWindowState(sender: WebContents): WindowWatchState {
  const existing = windowStates.get(sender.id)
  if (existing) {
    return existing
  }
  const state: WindowWatchState = {
    windowId: sender.id,
    sender,
    treeDirs: new Set(),
    filePaths: new Set(),
    watchers: new Map(),
    pendingTreeDirs: new Set(),
    pendingFiles: new Set(),
    timer: null
  }
  windowStates.set(sender.id, state)
  sender.once('destroyed', () => disposeWindowState(state))
  return state
}

/** 去抖窗口结束后把合并后的目录与文件集合分别推给渲染进程 */
function flushPendingChanges(state: WindowWatchState): void {
  state.timer = null
  const dirs = Array.from(state.pendingTreeDirs)
  const files = Array.from(state.pendingFiles)
  state.pendingTreeDirs.clear()
  state.pendingFiles.clear()
  if (state.sender.isDestroyed()) {
    return
  }
  if (dirs.length > 0) {
    const payload: DirectoriesChangedEvent = { dirs }
    state.sender.send(FILES_CHANNELS.directoriesChanged, payload)
  }
  if (files.length > 0) {
    const payload: FilesChangedEvent = { paths: files }
    state.sender.send(FILES_CHANNELS.filesChanged, payload)
  }
}

/** 记录变更并按窗口去抖推送 */
function scheduleChangePush(state: WindowWatchState): void {
  if (state.timer) {
    return
  }
  state.timer = setTimeout(() => flushPendingChanges(state), CHANGE_DEBOUNCE)
}

/**
 * 分派一次目录事件：watcher 只监听目录本身，filename 是目录内的条目名。
 * filename 为 null（平台不提供名字）时对打开文件保守广播，由渲染进程用 stat 基线自行判定。
 */
function handleWatcherEvent(
  state: WindowWatchState,
  dirPath: string,
  eventType: 'rename' | 'change',
  filename: string | null
): void {
  // 条目增删/改名：文件树重读该目录即可拿到准确结果；change 是内容修改，不影响树结构
  if (eventType === 'rename' && state.treeDirs.has(dirPath)) {
    state.pendingTreeDirs.add(dirPath)
  }
  // 打开文件：只认直接子项（watcher 不递归）
  for (const filePath of state.filePaths) {
    if (dirname(filePath) !== dirPath) {
      continue
    }
    if (filename !== null && filename !== basename(filePath)) {
      continue
    }
    state.pendingFiles.add(filePath)
  }
  if (state.pendingTreeDirs.size > 0 || state.pendingFiles.size > 0) {
    scheduleChangePush(state)
  }
}

/** 给单个目录挂原生 watcher；目录树的 rename 与打开文件的变化都由它分派 */
function openWatcher(state: WindowWatchState, dirPath: string): void {
  if (state.watchers.has(dirPath) || state.watchers.size >= MAX_WATCHED_DIRECTORIES) {
    return
  }
  let watcher: FSWatcher
  try {
    watcher = watch(dirPath, { persistent: true }, (eventType, filename) => {
      handleWatcherEvent(state, dirPath, eventType, filename === null ? null : filename.toString())
    })
  } catch {
    // 目录已不存在或无权限：展开时会重新读取，期间不监听
    return
  }
  // 目录被删除时 watcher 可能自行关闭（如 Linux inotify 的 IN_IGNORED）：
  // 从表中移除并保守通知一次，同名目录重建后可重新挂上
  watcher.on('close', () => {
    if (state.watchers.get(dirPath) !== watcher) {
      return
    }
    state.watchers.delete(dirPath)
    markDirectoryChanged(state, dirPath)
  })
  watcher.on('error', () => {
    closeWatcher(state, dirPath)
    // 保守通知：渲染进程重读失败后会清掉该目录的加载记录，由父目录刷新剔除节点
    markDirectoryChanged(state, dirPath)
  })
  state.watchers.set(dirPath, watcher)
}

/** 重建 watcher 集合：目录来源为「树已加载目录 + 打开文件的父目录」的并集 */
function syncWatchers(state: WindowWatchState): void {
  const watchDirs = new Set(state.treeDirs)
  for (const filePath of state.filePaths) {
    watchDirs.add(dirname(filePath))
  }
  for (const existing of Array.from(state.watchers.keys())) {
    if (!watchDirs.has(existing)) {
      closeWatcher(state, existing)
    }
  }
  for (const dirPath of watchDirs) {
    openWatcher(state, dirPath)
  }
}

/** 向渲染进程提供磁盘监听能力：同步关注集合，并在变化时推送目录/文件事件 */
export function registerDirectoryWatchHandlers(): void {
  ipcMain.handle(FILES_CHANNELS.setWatchedDirectories, (event, dirs: unknown): void => {
    const state = getWindowState(event.sender)
    state.treeDirs = new Set(normalizePaths(dirs))
    syncWatchers(state)
  })

  ipcMain.handle(FILES_CHANNELS.setWatchedFiles, (event, paths: unknown): void => {
    const state = getWindowState(event.sender)
    state.filePaths = new Set(normalizePaths(paths))
    syncWatchers(state)
  })

  // 只清文件树目录：打开文件的监听由编辑器的关注集合独立管理
  ipcMain.handle(FILES_CHANNELS.clearWatchedDirectories, (event): void => {
    const state = windowStates.get(event.sender.id)
    if (!state) {
      return
    }
    state.treeDirs.clear()
    syncWatchers(state)
  })
}

/** 应用退出前关闭全部 watcher，释放 inotify 句柄 */
export function disposeAllDirectoryWatchers(): void {
  for (const state of Array.from(windowStates.values())) {
    disposeWindowState(state)
  }
}
