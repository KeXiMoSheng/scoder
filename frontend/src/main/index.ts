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
import { homedir } from 'os'
import { basename, join, sep } from 'path'
import * as pty from 'node-pty'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { closeDatabase, initDatabase, registerDatabaseHandlers } from './db'
import { abortAllAiRuns, registerAiHandlers } from './ai'
import { FILES_CHANNELS } from '../shared/files/events'
import type { FileEntry, SearchResult } from '../shared/files/types'
import { TERMINAL_CHANNELS } from '../shared/terminal/events'
import type { TerminalDataEvent, TerminalExitEvent } from '../shared/terminal/types'
import { WINDOW_CHANNELS } from '../shared/window/events'

// 开发版标识：electron-vite dev 热重载模式，或 dev 通道打包产物（版本号带 -dev.<时间戳>，见 scripts/dist.mjs）
// 注意：打包后 is.dev 恒为 false，dev 通道必须靠版本号后缀区分，否则调试快捷键会被禁用
const isDevChannel = is.dev || app.getVersion().includes('-dev')

// 文件树中隐藏的噪音目录（版本库元数据与依赖缓存）
const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', '__pycache__', '.venv'])

// 文本预览的体积上限，超过则拒绝读取（避免超大文件卡死渲染进程）
const MAX_PREVIEW_FILE_SIZE = 5 * 1024 * 1024

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

  ipcMain.handle(FILES_CHANNELS.readFile, async (_event, filePath: string): Promise<string> => {
    if (typeof filePath !== 'string') {
      throw new Error('文件路径无效')
    }
    const buffer = await fs.readFile(filePath)
    if (buffer.byteLength > MAX_PREVIEW_FILE_SIZE) {
      throw new Error('文件超过 5 MB，暂不支持预览')
    }
    // 含 NUL 字节的按二进制处理，不做文本预览
    if (buffer.includes(0)) {
      throw new Error('二进制文件暂不支持预览')
    }
    return buffer.toString('utf-8')
  })

  ipcMain.handle(
    FILES_CHANNELS.writeFile,
    async (_event, filePath: string, content: string): Promise<void> => {
      if (typeof filePath !== 'string' || typeof content !== 'string') {
        throw new Error('参数无效')
      }
      await fs.writeFile(filePath, content, 'utf-8')
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

  // 按名称子串递归搜索（目录在前、名称升序的广度优先），跳过噪音目录
  ipcMain.handle(
    FILES_CHANNELS.searchFiles,
    async (_event, rootPath: string, query: string, limit?: number): Promise<SearchResult> => {
      if (typeof rootPath !== 'string' || typeof query !== 'string') {
        throw new Error('参数无效')
      }
      const keyword = query.trim().toLowerCase()
      if (!keyword) {
        return { entries: [], truncated: false }
      }
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
          if (dirent.name.toLowerCase().includes(keyword)) {
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

/** 按平台选择交互式 shell */
function resolveShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: [] }
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
    (event, cwd: string | null, cols: number, rows: number): number => {
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
      return id
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
  registerTerminalHandlers()
  registerWindowHandlers()
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
  // AI 通道依赖数据库（按 id 读模型配置），必须在 initDatabase 之后注册
  registerAiHandlers()

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
  for (const session of terminalSessions.values()) {
    session.process.kill()
  }
  terminalSessions.clear()
  closeDatabase()
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
