import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type MessageBoxOptions,
  type OpenDialogOptions
} from 'electron'
import { existsSync, promises as fs } from 'fs'
import { isAbsolute, win32 } from 'path'
import { AI_RUNTIME_CHANNELS, type AiRuntimeSettings } from '../../shared/ai/settings'
import { FILE_SETTINGS_CHANNELS, type FileSettings } from '../../shared/files/settings'
import { GIT_SETTINGS_CHANNELS, type GitSettings } from '../../shared/git/settings'
import { MODEL_CONFIG_CHANNELS } from '../../shared/model-config/events'
import type { GitVersionInfo } from '../../shared/git/types'
import type { ModelConfig, ModelConfigInput } from '../../shared/model-config/types'
import {
  POWERSHELL_DOWNLOAD_URL,
  TERMINAL_SETTINGS_CHANNELS,
  type TerminalSettings
} from '../../shared/terminal/settings'
import { WORKSPACE_CHANNELS } from '../../shared/workspace/events'
import type { EditorTabsSnapshot, RecentProject } from '../../shared/workspace/types'
import { nudgeGitStatusMonitors, probeGitVersion } from '../git'
import { probePowerShellVersion } from '../powershell'
import { getAiRuntimeSettings, saveAiRuntimeSettings } from './app-settings'
import { DbError } from './errors'
import { getFileSettings, saveFileSettings } from './file-settings'
import { getGitSettings, saveGitSettings } from './git-settings'
import { getTerminalSettings, saveTerminalSettings } from './terminal-settings'
import {
  clearRestoreProject,
  getLastProjectPath,
  getOpenTabs,
  listRecentProjects,
  recordProjectOpened,
  saveOpenTabs
} from './workspace-projects'
import {
  createModelConfig,
  deleteAllModelConfigs,
  deleteModelConfig,
  findModelConfigById,
  listModelConfigs,
  updateModelConfig
} from './model-configs'
import { getSelectedModelConfigId, saveSelectedModelConfigId } from './model-selection'

/**
 * 向渲染进程提供模型配置与应用设置的读写（白名单 IPC）。
 * 这一层只做三件事：接收参数、处理需要窗口的交互（确认框）、转发给仓储；
 * 数据规则与 SQL 都在各自的仓储文件里，便于脱离 Electron 单测。
 */
export function registerDatabaseHandlers(): void {
  ipcMain.handle(MODEL_CONFIG_CHANNELS.list, (): ModelConfig[] => listModelConfigs())

  ipcMain.handle(MODEL_CONFIG_CHANNELS.create, (_event, input: ModelConfigInput): ModelConfig =>
    createModelConfig(input)
  )

  ipcMain.handle(
    MODEL_CONFIG_CHANNELS.update,
    (_event, id: number, input: ModelConfigInput): ModelConfig => updateModelConfig(id, input)
  )

  ipcMain.handle(MODEL_CONFIG_CHANNELS.delete, async (event, id: number): Promise<boolean> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return confirmAndDelete(window, id)
  })

  ipcMain.handle(MODEL_CONFIG_CHANNELS.deleteAll, async (event): Promise<boolean> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return confirmAndDeleteAll(window)
  })

  // 对话框选中的模型：全局偏好，与最近项目一样落在 app_settings
  ipcMain.handle(MODEL_CONFIG_CHANNELS.getSelected, (): number | null => getSelectedModelConfigId())
  ipcMain.handle(MODEL_CONFIG_CHANNELS.saveSelected, (_event, id: number): number =>
    saveSelectedModelConfigId(id)
  )

  // AI 运行参数：设置页读写，主进程在每轮对话开始时重新读取
  ipcMain.handle(AI_RUNTIME_CHANNELS.get, (): AiRuntimeSettings => getAiRuntimeSettings())
  ipcMain.handle(AI_RUNTIME_CHANNELS.save, (_event, input: AiRuntimeSettings): AiRuntimeSettings =>
    saveAiRuntimeSettings(input)
  )

  // 文件限制：设置页读写，主进程在每次打开文本流时重新读取
  ipcMain.handle(FILE_SETTINGS_CHANNELS.get, (): FileSettings => getFileSettings())
  ipcMain.handle(FILE_SETTINGS_CHANNELS.save, (_event, input: FileSettings): FileSettings =>
    saveFileSettings(input)
  )

  // 终端设置：PowerShell 7 路径由用户显式指定，没配置就使用系统自带的 5.1
  ipcMain.handle(TERMINAL_SETTINGS_CHANNELS.get, (): TerminalSettings => getTerminalSettings())
  ipcMain.handle(
    TERMINAL_SETTINGS_CHANNELS.save,
    (_event, input: TerminalSettings): TerminalSettings => saveTerminalSettings(input)
  )

  // 选择 pwsh.exe：只负责弹框取路径，是否保存由设置页决定
  ipcMain.handle(TERMINAL_SETTINGS_CHANNELS.browse, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '选择 PowerShell 7（pwsh.exe）',
      properties: ['openFile'],
      filters: [{ name: 'PowerShell 7', extensions: ['exe'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // 测试：实际启动一次进程并读版本号，保存前就能发现路径失效
  ipcMain.handle(TERMINAL_SETTINGS_CHANNELS.test, (_event, filePath: string): Promise<string> => {
    requirePowerShellPath(filePath)
    return probePowerShellVersion(filePath.trim())
  })

  ipcMain.handle(TERMINAL_SETTINGS_CHANNELS.openDownload, async (): Promise<void> => {
    await shell.openExternal(POWERSHELL_DOWNLOAD_URL)
  })

  registerGitSettingsHandlers()

  registerWorkspaceHandlers()
}

/**
 * Git 设置：文件树的状态标记用同一个可执行文件。
 * 保存后立即让运行中的订阅用新路径重读一次，不必等下一个轮询周期。
 */
function registerGitSettingsHandlers(): void {
  ipcMain.handle(GIT_SETTINGS_CHANNELS.get, (): GitSettings => getGitSettings())
  ipcMain.handle(GIT_SETTINGS_CHANNELS.save, (_event, input: GitSettings): GitSettings => {
    const saved = saveGitSettings(input)
    nudgeGitStatusMonitors()
    return saved
  })

  // 选择 git 可执行文件：只负责弹框取路径，是否保存由设置页决定
  ipcMain.handle(GIT_SETTINGS_CHANNELS.browse, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '选择 git 可执行文件',
      properties: ['openFile'],
      // Windows 的 git 是 .exe；macOS / Linux 的可执行文件没有扩展名，不加过滤器
      ...(process.platform === 'win32' ? { filters: [{ name: 'Git', extensions: ['exe'] }] } : {})
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // 测试：真的执行一次 `git --version`，保存前就能发现路径失效
  ipcMain.handle(
    GIT_SETTINGS_CHANNELS.test,
    (_event, filePath: string): Promise<GitVersionInfo> => {
      requireGitPath(filePath)
      return probeGitVersion(filePath.trim())
    }
  )
}

/** 测试前先校验路径形状与存在性，避免 execFile 只报一个 ENOENT；空字符串表示测试自动探测 */
function requireGitPath(filePath: string): void {
  const trimmed = typeof filePath === 'string' ? filePath.trim() : ''
  if (trimmed.length === 0) {
    return
  }
  if (!isAbsolute(trimmed)) {
    throw new DbError('Git 路径必须是可执行文件的绝对路径', 'INVALID_ARGUMENT')
  }
  if (!existsSync(trimmed)) {
    throw new DbError('找不到该文件，请确认路径是否正确', 'INVALID_ARGUMENT')
  }
}

/** 测试前先校验路径形状与存在性，避免 execFile 只报一个 ENOENT */
function requirePowerShellPath(filePath: string): void {
  const trimmed = typeof filePath === 'string' ? filePath.trim() : ''
  if (!win32.isAbsolute(trimmed) || !/\.exe$/i.test(trimmed)) {
    throw new DbError('PowerShell 路径必须是 .exe 文件的绝对路径', 'INVALID_ARGUMENT')
  }
  if (!existsSync(trimmed)) {
    throw new DbError('找不到该文件，请确认路径是否正确', 'INVALID_ARGUMENT')
  }
}

/**
 * 工作区最近项目 / 启动恢复通道。
 * getLastProject 会校验目录仍然存在：项目被删除或移动时返回 null，
 * 避免启动去打开一个不存在的目录。
 */
function registerWorkspaceHandlers(): void {
  ipcMain.handle(WORKSPACE_CHANNELS.listRecent, (): RecentProject[] => listRecentProjects())

  ipcMain.handle(WORKSPACE_CHANNELS.recordOpened, (_event, path: string): void => {
    recordProjectOpened(path)
  })

  ipcMain.handle(WORKSPACE_CHANNELS.clearRestore, (_event, path: string): void => {
    clearRestoreProject(path)
  })

  ipcMain.handle(
    WORKSPACE_CHANNELS.saveOpenTabs,
    (_event, path: string, snapshot: EditorTabsSnapshot): void => {
      saveOpenTabs(path, snapshot)
    }
  )

  ipcMain.handle(
    WORKSPACE_CHANNELS.getOpenTabs,
    (_event, path: string): EditorTabsSnapshot | null => getOpenTabs(path)
  )

  ipcMain.handle(WORKSPACE_CHANNELS.getLastProject, async (): Promise<string | null> => {
    const path = getLastProjectPath()
    if (!path) {
      return null
    }
    try {
      // 目录必须存在且仍可读，否则放弃本次自动恢复
      const stat = await fs.stat(path)
      return stat.isDirectory() ? path : null
    } catch {
      return null
    }
  })
}

/** 删除前弹系统对话框确认，用户取消时返回 false */
async function confirmAndDelete(window: BrowserWindow | null, id: number): Promise<boolean> {
  // 先读一次：记录不存在时直接抛错，避免弹出无意义的确认框
  const config = findModelConfigById(id)
  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: ['取消', '删除'],
    defaultId: 0,
    cancelId: 0,
    title: '删除确认',
    message: `确定要删除模型「${config.displayName}」吗？`,
    detail: '删除后无法恢复，与之相关的本地数据不会一并删除。'
  }
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  if (result.response !== 1) {
    return false
  }
  deleteModelConfig(id)
  return true
}

/** 删除全部前弹系统对话框确认（带上总条数），用户取消时返回 false */
async function confirmAndDeleteAll(window: BrowserWindow | null): Promise<boolean> {
  const total = listModelConfigs().length
  if (total === 0) {
    return true
  }
  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: ['取消', '全部删除'],
    defaultId: 0,
    cancelId: 0,
    title: '删除确认',
    message: `确定要删除全部 ${total} 个模型配置吗？`,
    detail: '删除后无法恢复，与之相关的本地数据不会一并删除。'
  }
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  if (result.response !== 1) {
    return false
  }
  deleteAllModelConfigs()
  return true
}
