import {
  app,
  shell,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MessageBoxOptions,
  type OpenDialogOptions
} from 'electron'
import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { homedir } from 'os'
import { basename, isAbsolute, join, relative, sep } from 'path'
import * as pty from 'node-pty'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { closeDatabase, getTerminalSettings, initDatabase, registerDatabaseHandlers } from './db'
import { abortAllAiRuns, registerAiHandlers } from './ai'
import { registerAppHandlers } from './app'
import { browserManager } from './browser/manager'
import { disposeAllFileStreams, registerFileStreamHandlers } from './files/stream'
import { decodeWholeText, TextStreamError } from './files/textStream'
import { BINARY_SAMPLE_BYTES, isBinarySample } from './files/encoding'
import { isTextEncodingId } from '../shared/files/encoding'
import { createSearchMatcher } from '../shared/files/types'
import { disposeAllFileWrites, registerFileWriteHandlers } from './files/write'
import { disposeAllDirectoryWatchers, registerDirectoryWatchHandlers } from './files/watch'
import { replaceFileContents, searchFileContents } from './files/search'
import { registerModelImportHandlers } from './model-import'
import { disposeAllGitStatusMonitors, registerGitStatusHandlers } from './git'
import { disposeMcp, initMcp } from './mcp'
import { registerThemeHandlers } from './theme'
import { detectPowerShell, probePowerShellVersion } from './powershell'
import { FILES_CHANNELS } from '../shared/files/events'
import { MAX_EDITOR_TEXT_BYTES } from '../shared/files/settings'
import type {
  ContentSearchMatch,
  ContentSearchResult,
  FileEntry,
  FileStat,
  ReplaceResult,
  SearchOptions,
  SearchResult
} from '../shared/files/types'
import { TERMINAL_CHANNELS } from '../shared/terminal/events'
import type {
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalShellInfo
} from '../shared/terminal/types'
import { WINDOW_CHANNELS } from '../shared/window/events'

// GB 级文本 + Monaco 的行模型与全文索引需要更大的老生代空间：
// 默认约 4GB 在 1GB 文本叠加全文特性对象时容易触发 V8 OOM
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192')

// 开发版标识：electron-vite dev 热重载模式，或 dev 通道打包产物（版本号带 -dev.<时间戳>，见 scripts/dist.mjs）
// 注意：打包后 is.dev 恒为 false，dev 通道必须靠版本号后缀区分，否则调试快捷键会被禁用
const isDevChannel = is.dev || app.getVersion().includes('-dev')

// 文件树中隐藏的噪音目录（版本库元数据与依赖缓存）
const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', '__pycache__', '.venv'])

/** 超出单字符串上限时的统一错误：必须在读取前拦住，否则 V8 会抛底层英文错误 */
function editorTextTooLargeError(): Error {
  return new Error(
    `文件超过 ${Math.round(MAX_EDITOR_TEXT_BYTES / 1024 / 1024)} MB，超出编辑器可载入上限，无法打开`
  )
}

// 二进制预览的体积上限：图片/音视频整块复制到渲染进程内存，过大时直拒
const MAX_BINARY_PREVIEW_SIZE = 50 * 1024 * 1024

// 搜索结果的硬上限（渲染进程传入的 limit 会被裁剪到该范围内）
const MAX_SEARCH_RESULTS = 500

// 搜索遍历的条目数上限：目录树异常庞大时兜底，避免长时间占用主进程
const MAX_SEARCH_VISITS = 100_000

/** 目录在前、文件在后，同类按名称不区分大小写升序 */
function compareFileEntries(a: FileEntry, b: FileEntry): number {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/** 向渲染进程提供白名单文件系统能力：选择目录、读写文件、重命名/移动/删除条目、递归搜索 */
function registerFileSystemHandlers(): void {
  ipcMain.handle(FILES_CHANNELS.openProjectDirectory, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '选择项目目录',
      properties: ['openDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(
    FILES_CHANNELS.readDirectory,
    async (_event, dirPath: string): Promise<FileEntry[]> => {
      if (typeof dirPath !== 'string') {
        throw new Error('目录路径无效')
      }
      const dirents = await fs.readdir(dirPath, { withFileTypes: true })
      return dirents
        .filter((dirent) => !(dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)))
        .map((dirent) => ({
          name: dirent.name,
          path: join(dirPath, dirent.name),
          isDirectory: dirent.isDirectory()
        }))
        .sort(compareFileEntries)
    }
  )

  // 一次性读取文本文件（编辑器打开）：体积上限由渲染进程按配置先行判断
  ipcMain.handle(
    FILES_CHANNELS.readFile,
    async (_event, filePath: string, encoding?: unknown): Promise<string> => {
      if (typeof filePath !== 'string') {
        throw new Error('文件路径无效')
      }
      if (encoding !== undefined && !isTextEncodingId(encoding)) {
        throw new Error('文件编码无效')
      }
      // 先看大小：超过 V8 单字符串上限的文件必然读不出字符串，避免白白分配整块内存
      const info = await fs.stat(filePath)
      if (info.size > MAX_EDITOR_TEXT_BYTES) {
        throw editorTextTooLargeError()
      }
      const buffer = await fs.readFile(filePath)
      // 读取期间文件可能增长：兜底再判一次
      if (buffer.byteLength > MAX_EDITOR_TEXT_BYTES) {
        throw editorTextTooLargeError()
      }
      try {
        // 未指定编码时自动识别；BOM 作为编码标记剥离，不进入文本
        return decodeWholeText(buffer, filePath, encoding)
      } catch (error) {
        if (error instanceof TextStreamError) {
          throw new Error('二进制文件不支持在编辑器中打开', { cause: error })
        }
        throw error
      }
    }
  )

  // 文件观测：stat + 文件头 8 KB 采样；二进制文件不进编辑器，也不参与大小限制提示
  ipcMain.handle(
    FILES_CHANNELS.statFile,
    async (_event, filePath: string): Promise<FileStat | null> => {
      if (typeof filePath !== 'string') {
        throw new Error('文件路径无效')
      }
      let handle: FileHandle
      try {
        handle = await fs.open(filePath, 'r')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }
        throw error
      }
      try {
        const info = await handle.stat()
        if (!info.isFile()) {
          return null
        }
        let binary = false
        if (info.size > 0) {
          const sample = Buffer.allocUnsafe(Math.min(BINARY_SAMPLE_BYTES, info.size))
          const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
          // 与文本流共用同一套判定：BOM 声明 UTF-16 时 NUL 不算二进制信号
          binary = isBinarySample(sample.subarray(0, bytesRead))
        }
        return { size: info.size, binary, mtimeMs: info.mtimeMs }
      } finally {
        await handle.close().catch(() => undefined)
      }
    }
  )

  // 二进制预览：图片/音视频需要完整字节，超过体积上限直接拒绝（避免打爆渲染进程）
  ipcMain.handle(
    FILES_CHANNELS.readFileBytes,
    async (_event, filePath: string): Promise<Uint8Array> => {
      if (typeof filePath !== 'string') {
        throw new Error('文件路径无效')
      }
      const handle = await fs.open(filePath, 'r')
      try {
        const { size } = await handle.stat()
        if (size > MAX_BINARY_PREVIEW_SIZE) {
          throw new Error('文件超过 50 MB，暂不支持预览')
        }
        const data = new Uint8Array(size)
        await handle.read(data, 0, size, 0)
        return data
      } finally {
        await handle.close()
      }
    }
  )

  // 重命名与拖拽移动共用：把 sourcePath 移动到 targetPath（含改名）
  ipcMain.handle(
    FILES_CHANNELS.moveEntry,
    async (_event, sourcePath: string, targetPath: string): Promise<void> => {
      if (typeof sourcePath !== 'string' || typeof targetPath !== 'string') {
        throw new Error('路径无效')
      }
      if (sourcePath === targetPath) {
        return
      }
      // 禁止把目录移动到自身内部，避免产生意外层级
      if (targetPath.startsWith(sourcePath + sep)) {
        throw new Error('不能移动到自身或其子目录内')
      }
      // fs.rename 在目标存在时会静默覆盖（POSIX），显式拦截以免误删
      const targetExists = await fs.access(targetPath).then(
        () => true,
        () => false
      )
      if (targetExists) {
        throw new Error('目标位置已存在同名条目')
      }
      await fs.rename(sourcePath, targetPath)
    }
  )

  // 删除文件或目录（目录递归删除）；先经系统对话框确认，用户取消时返回 false
  ipcMain.handle(
    FILES_CHANNELS.deleteEntry,
    async (event, targetPath: string): Promise<boolean> => {
      if (typeof targetPath !== 'string' || !targetPath) {
        throw new Error('路径无效')
      }
      const isDirectory = (await fs.lstat(targetPath)).isDirectory()
      const options: MessageBoxOptions = {
        type: 'warning',
        buttons: ['取消', '删除'],
        defaultId: 0,
        cancelId: 0,
        title: '删除确认',
        message: `确定要删除${isDirectory ? '目录' : '文件'}「${basename(targetPath)}」吗？`,
        detail: isDirectory
          ? '该目录及其全部内容将被永久删除，且无法恢复。'
          : '该文件将被永久删除，且无法恢复。'
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      const result = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options)
      if (result.response !== 1) {
        return false
      }
      await fs.rm(targetPath, { recursive: true })
      return true
    }
  )

  // 在系统文件资源管理器中打开所在目录并选中条目；路径已不存在时 showItemInFolder 会静默失败，先校验再报错供渲染进程提示
  ipcMain.handle(FILES_CHANNELS.revealEntry, async (_event, targetPath: string): Promise<void> => {
    if (typeof targetPath !== 'string' || !targetPath) {
      throw new Error('路径无效')
    }
    await fs.access(targetPath)
    shell.showItemInFolder(targetPath)
  })

  ipcMain.handle(
    FILES_CHANNELS.searchFileContents,
    async (
      _event,
      rootPath: string,
      query: string,
      options: SearchOptions
    ): Promise<ContentSearchResult> => {
      if (typeof rootPath !== 'string' || !rootPath || typeof query !== 'string' || !query.trim()) {
        return { matches: [], truncated: false }
      }
      return searchFileContents(rootPath, query, options)
    }
  )

  ipcMain.handle(
    FILES_CHANNELS.replaceFileContents,
    async (
      _event,
      rootPath: string,
      query: string,
      replacement: string,
      options: SearchOptions,
      matches: ContentSearchMatch[]
    ): Promise<ReplaceResult> => {
      if (
        typeof rootPath !== 'string' ||
        typeof query !== 'string' ||
        typeof replacement !== 'string' ||
        !Array.isArray(matches)
      ) {
        throw new Error('替换参数无效')
      }
      return replaceFileContents(rootPath, query, replacement, options, matches)
    }
  )

  // 按名称子串递归搜索（目录在前、名称升序的广度优先），跳过噪音目录
  ipcMain.handle(
    FILES_CHANNELS.searchFiles,
    async (
      _event,
      rootPath: string,
      query: string,
      limit?: number,
      options?: SearchOptions
    ): Promise<SearchResult> => {
      if (typeof rootPath !== 'string' || typeof query !== 'string') {
        throw new Error('参数无效')
      }
      if (!query.trim()) {
        return { entries: [], truncated: false }
      }
      const matcher = createSearchMatcher(
        query.trim(),
        options ?? {
          caseSensitive: false,
          wholeWord: false,
          regex: false
        }
      )
      const pathQuery = query.trim().replace(/[./\\]+/gu, sep)
      const requested =
        typeof limit === 'number' && limit > 0 ? Math.floor(limit) : MAX_SEARCH_RESULTS
      const maxResults = Math.min(requested, MAX_SEARCH_RESULTS)
      const entries: FileEntry[] = []
      let visited = 0
      let truncated = false
      const pendingDirs: string[] = [rootPath]
      while (pendingDirs.length > 0 && !truncated) {
        const dirPath = pendingDirs.shift()
        if (!dirPath) {
          break
        }
        let dirents
        try {
          dirents = await fs.readdir(dirPath, { withFileTypes: true })
        } catch {
          // 无权限或目录已被删除：跳过该分支
          continue
        }
        dirents.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        for (const dirent of dirents) {
          const isDirectory = dirent.isDirectory()
          if (isDirectory && IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
            continue
          }
          visited += 1
          if (visited > MAX_SEARCH_VISITS) {
            truncated = true
            break
          }
          const fullPath = join(dirPath, dirent.name)
          const searchName = isAbsolute(pathQuery)
            ? fullPath
            : pathQuery.includes(sep)
              ? relative(rootPath, fullPath)
              : dirent.name
          matcher.lastIndex = 0
          if (matcher.test(searchName)) {
            if (entries.length >= maxResults) {
              truncated = true
              break
            }
            entries.push({ name: dirent.name, path: fullPath, isDirectory })
          }
          if (isDirectory) {
            pendingDirs.push(fullPath)
          }
        }
      }
      return { entries, truncated }
    }
  )

  // 在 dirPath 下创建空文件或空目录；名称非法或同名条目已存在时报错，返回新建条目供文件树定位
  ipcMain.handle(
    FILES_CHANNELS.createEntry,
    async (_event, dirPath: string, name: string, isDirectory: boolean): Promise<FileEntry> => {
      if (
        typeof dirPath !== 'string' ||
        typeof name !== 'string' ||
        typeof isDirectory !== 'boolean'
      ) {
        throw new Error('参数无效')
      }
      const entryName = name.trim()
      if (!entryName || entryName === '.' || entryName === '..' || /[\\/]/.test(entryName)) {
        throw new Error('名称无效')
      }
      const fullPath = join(dirPath, entryName)
      // 已存在同名条目时不覆盖，交由用户改名
      const exists = await fs.access(fullPath).then(
        () => true,
        () => false
      )
      if (exists) {
        throw new Error('同目录下已存在同名条目')
      }
      if (isDirectory) {
        await fs.mkdir(fullPath)
      } else {
        await fs.writeFile(fullPath, '', 'utf-8')
      }
      return { name: entryName, path: fullPath, isDirectory }
    }
  )
}

/** 终端会话：pty 进程实例及其所属窗口（webContents.id） */
interface TerminalSession {
  process: pty.IPty
  windowId: number
}

// 活动终端会话表（id 单调递增；窗口销毁或应用退出时回收其全部会话，避免孤儿 shell）
const terminalSessions = new Map<number, TerminalSession>()
let nextTerminalId = 1

/** 按平台选择交互式 shell：Windows 上配置了 PowerShell 7 就用 pwsh，否则回退 5.1 */
function resolveShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const { powershellPath } = getTerminalSettings()
    return { file: detectPowerShell(powershellPath), args: ['-NoLogo'] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: [] }
}

/** shell 版本探测结果按可执行文件缓存：同一路径只跑一次进程 */
const shellVersionCache = new Map<string, Promise<string | null>>()

/**
 * 取 shell 的名称与版本，供终端页签显示。
 * 探测失败只影响页签文案，不影响终端本身。
 */
async function describeShell(file: string): Promise<TerminalShellInfo> {
  const name = basename(file).replace(/\.exe$/i, '')
  if (process.platform !== 'win32') {
    // 非 Windows 的 shell 版本对用户没有意义，页签只显示名称
    return { name, version: null }
  }
  return { name, version: await powerShellVersion(file) }
}

/** 跑一次 `$PSVersionTable` 取版本；并发调用共享同一个 Promise */
function powerShellVersion(file: string): Promise<string | null> {
  const cached = shellVersionCache.get(file)
  if (cached !== undefined) {
    return cached
  }
  // 探测失败只影响页签文案，不向调用方抛错
  const pending = probePowerShellVersion(file).catch(() => null)
  shellVersionCache.set(file, pending)
  return pending
}

/** 结束某个窗口创建的全部终端会话 */
function disposeWindowTerminals(windowId: number): void {
  for (const [id, session] of terminalSessions) {
    if (session.windowId === windowId) {
      session.process.kill()
      terminalSessions.delete(id)
    }
  }
}

/** 向渲染进程提供终端能力：创建/写入/调整/销毁 pty 会话，并转发输出与退出事件 */
function registerTerminalHandlers(): void {
  // 每个窗口只注册一次 destroyed 监听（会话表按窗口 id 归属）
  const watchedWindowIds = new Set<number>()

  ipcMain.handle(
    TERMINAL_CHANNELS.create,
    async (
      event,
      cwd: string | null,
      cols: number,
      rows: number
    ): Promise<TerminalCreateResult> => {
      if (
        (cwd !== null && typeof cwd !== 'string') ||
        typeof cols !== 'number' ||
        typeof rows !== 'number'
      ) {
        throw new Error('参数无效')
      }
      const { file, args } = resolveShell()
      const id = nextTerminalId
      nextTerminalId += 1
      const proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: Math.max(1, Math.floor(cols)),
        rows: Math.max(1, Math.floor(rows)),
        cwd: cwd ?? homedir(),
        env: process.env
      })
      const sender = event.sender
      terminalSessions.set(id, { process: proc, windowId: sender.id })
      if (!watchedWindowIds.has(sender.id)) {
        watchedWindowIds.add(sender.id)
        sender.once('destroyed', () => {
          watchedWindowIds.delete(sender.id)
          disposeWindowTerminals(sender.id)
        })
      }
      proc.onData((data) => {
        if (sender.isDestroyed()) {
          return
        }
        const payload: TerminalDataEvent = { id, data }
        sender.send(TERMINAL_CHANNELS.data, payload)
      })
      proc.onExit(({ exitCode }) => {
        terminalSessions.delete(id)
        if (sender.isDestroyed()) {
          return
        }
        const payload: TerminalExitEvent = { id, exitCode }
        sender.send(TERMINAL_CHANNELS.exit, payload)
      })
      // 版本探测放在 spawn 之后：终端先起来，页签文字随后补上
      return { id, shell: await describeShell(file) }
    }
  )

  // 缺少会话的写入/调整（如销毁竞态）静默忽略，不打断渲染进程
  ipcMain.on(TERMINAL_CHANNELS.write, (_event, id: number, data: string): void => {
    if (typeof id !== 'number' || typeof data !== 'string') {
      return
    }
    terminalSessions.get(id)?.process.write(data)
  })

  ipcMain.on(TERMINAL_CHANNELS.resize, (_event, id: number, cols: number, rows: number): void => {
    if (typeof id !== 'number' || typeof cols !== 'number' || typeof rows !== 'number') {
      return
    }
    const session = terminalSessions.get(id)
    if (!session || cols < 1 || rows < 1) {
      return
    }
    session.process.resize(Math.floor(cols), Math.floor(rows))
  })

  ipcMain.handle(TERMINAL_CHANNELS.dispose, (_event, id: number): void => {
    const session = terminalSessions.get(id)
    if (!session) {
      return
    }
    terminalSessions.delete(id)
    session.process.kill()
  })
}

/** 向渲染进程提供无边框窗口的控制能力：最小化、最大化/还原、关闭，并回查最大化状态 */
function registerWindowHandlers(): void {
  // 控制类操作无需回执，走单向 send；目标窗口从事件发送者反查，天然隔离多窗口
  ipcMain.on(WINDOW_CHANNELS.minimize, (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on(WINDOW_CHANNELS.toggleMaximize, (event): void => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return
    }
    if (window.isMaximized()) {
      window.unmaximize()
    } else {
      window.maximize()
    }
  })

  ipcMain.on(WINDOW_CHANNELS.close, (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle(WINDOW_CHANNELS.isMaximized, (event): boolean => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    // 最小尺寸：保证文件树、编辑器与右侧 AI 边栏各自的最小宽度之和放得下
    minWidth: 640,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    // 去掉原生窗口边框（含顶部标题栏与系统最小化/最大化/关闭按钮）
    // 注意：frameless 后需在前端自绘标题栏并用 IPC 实现拖动/窗口控制，否则无法移动和关闭窗口
    frame: false,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 显式声明开发者工具开关（默认即为 true）：开发版保留，正式版关闭
      devTools: isDevChannel
    }
  })

  mainWindow.on('ready-to-show', () => {
    // 启动即铺满工作区（保留系统栏）；先最大化再显示，避免窗口先以默认尺寸闪现
    mainWindow.maximize()
    mainWindow.show()
  })

  // 主窗口关闭时销毁隐藏的 AI 浏览器窗口：否则它们会挡住 window-all-closed，应用退不干净
  mainWindow.on('closed', () => {
    browserManager.disposeAll()
  })

  // 无边框窗口的标题栏按钮需要跟随最大化/还原切换图标，状态变化时主动推送给渲染进程
  const pushMaximizeState = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(WINDOW_CHANNELS.maximizeChange, mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', pushMaximizeState)
  mainWindow.on('unmaximize', pushMaximizeState)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.scoder.app')

  // 禁用原生应用菜单：Alt 不再弹出系统原生菜单栏（配合下方 autoHideMenuBar，彻底隐藏菜单）
  Menu.setApplicationMenu(null)

  registerFileSystemHandlers()
  // 目录监听：渲染进程同步已加载目录，主进程在条目变化时推送，供文件树自动刷新
  registerDirectoryWatchHandlers()
  // Git 状态：文件树打开项目后按固定间隔自动检测，只在变化时推送
  registerGitStatusHandlers()
  // 文本流：大文件按块读取并增量灌入编辑器，句柄由主进程按窗口回收
  registerFileStreamHandlers()
  // 写入流：超大文本按块保存到临时文件，完成后原子替换目标
  registerFileWriteHandlers()
  registerTerminalHandlers()
  registerWindowHandlers()
  // 应用信息（版本号 / 仓库跳转）不依赖数据库，窗口创建前注册即可
  registerAppHandlers()
  // 导入主题：读写 userData/themes，不依赖数据库
  registerThemeHandlers()
  // 本地库在窗口创建前初始化：设置页首帧即可读取已保存的模型配置
  // 打开/迁移失败时给出可见错误并退出：继续运行只会让设置页与 AI 都报“尚未就绪”
  try {
    initDatabase()
  } catch (error) {
    dialog.showErrorBox('数据库初始化失败', error instanceof Error ? error.message : String(error))
    app.quit()
    return
  }
  registerDatabaseHandlers()
  // 一键导入模型：网络请求 + 批量落库，依赖 initDatabase 打开的库
  registerModelImportHandlers()
  // AI 通道依赖数据库（按 id 读模型配置），必须在 initDatabase 之后注册
  registerAiHandlers()
  // MCP：注册设置面板通道，并按已保存的配置挂载连接（工具注册进共享注册表）
  initMcp()

  // 快捷键策略（dev 通道自行接管，避免打包后 watchWindowShortcuts 按生产策略屏蔽调试快捷键）：
  // - 开发版：F12 或 Ctrl+Shift+I（macOS 为 Cmd+Alt+I）切换开发者工具
  // - 正式版：沿用 electron-toolkit 默认行为，禁用 CommandOrControl + R 与开发者工具快捷键
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    if (!isDevChannel) {
      optimizer.watchWindowShortcuts(window)
      return
    }

    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') {
        return
      }
      const toggleDevTools =
        input.code === 'F12' ||
        (input.control && input.shift && input.code === 'KeyI') ||
        (input.meta && input.alt && input.code === 'KeyI')
      if (!toggleDevTools) {
        return
      }

      if (window.webContents.isDevToolsOpened()) {
        window.webContents.closeDevTools()
      } else {
        window.webContents.openDevTools({ mode: 'undocked' })
      }
      event.preventDefault()
    })
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 应用退出前结束所有终端会话（pty 子进程不会随主进程自动退出）
app.on('before-quit', () => {
  abortAllAiRuns()
  browserManager.disposeAll()
  disposeAllFileStreams()
  disposeAllFileWrites()
  disposeAllDirectoryWatchers()
  disposeAllGitStatusMonitors()
  for (const session of terminalSessions.values()) {
    session.process.kill()
  }
  terminalSessions.clear()
  closeDatabase()
})

/**
 * MCP 关闭的等待上限（毫秒）。
 * stdio 服务端是子进程：不关闭就退出会留下孤儿进程，所以要等；但清理卡住时不能不让用户退出。
 */
const MCP_QUIT_TIMEOUT_MS = 3_000

/** 是否已经进入“等 MCP 收尾”的退出流程：防止 preventDefault 与再次 quit 互相触发 */
let quittingAfterMcpDispose = false

// MCP 连接的关闭是异步的（关闭传输、等子进程退出），before-quit 里拿不到 await：
// 先拦下这次退出，清理完再重新退出一次。第二次进入时标志位已置，直接放行。
app.on('before-quit', (event) => {
  if (quittingAfterMcpDispose) {
    return
  }
  quittingAfterMcpDispose = true
  event.preventDefault()
  const fallback = setTimeout(() => app.quit(), MCP_QUIT_TIMEOUT_MS)
  fallback.unref()
  void disposeMcp()
    .catch((error: unknown) => {
      console.warn('关闭 MCP 连接失败', error)
    })
    .finally(() => {
      clearTimeout(fallback)
      app.quit()
    })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
