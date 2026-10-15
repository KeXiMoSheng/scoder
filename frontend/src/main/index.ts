import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

// 开发版标识：electron-vite dev 热重载模式，或 dev 通道打包产物（版本号带 -dev.<时间戳>，见 scripts/dist.mjs）
// 注意：打包后 is.dev 恒为 false，dev 通道必须靠版本号后缀区分，否则调试快捷键会被禁用
const isDevChannel = is.dev || app.getVersion().includes('-dev')

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 显式声明开发者工具开关（默认即为 true）：开发版保留，正式版关闭
      devTools: isDevChannel
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

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
