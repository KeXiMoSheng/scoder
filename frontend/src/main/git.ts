/**
 * Git 能力的对外出口。
 *
 * - `git/status`：git 命令与状态解析（不依赖 Electron，可单独验证）
 * - `git/monitor`：按固定间隔自动检测并推送状态的窗口订阅
 */
export { detectGit, parseStatus, probeGitVersion, readGitStatus } from './git/status'
export {
  disposeAllGitStatusMonitors,
  nudgeGitStatusMonitors,
  registerGitStatusHandlers
} from './git/monitor'
