import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronViteBin = path.join(rootDir, 'node_modules/electron-vite/bin/electron-vite.js')

// --no-sandbox 是给 Chromium 的开关，electron-vite 的 CLI 选项名是驼峰的 --noSandbox，
// 写错会被 cac 当成「--sandbox 取反」直接报 Unknown option（Linux 下以 root 开发时才需要禁用沙箱）
const args = [electronViteBin, 'dev', '--noSandbox']

// Linux 桌面（GNOME Wayland 会话）下 Electron 默认选原生 Wayland 后端，虚拟机显卡的 GPU 通道初始化失败时
// ready-to-show 永不触发（窗口 show:false 于是永远不显示），表现为「dev server 正常但看不到窗口」；
// 这里显式指定 X11 后端走 XWayland。--ozone-platform 是 Linux 专用开关，其他平台不能传
const isWaylandDesktop =
  process.platform === 'linux' &&
  (Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland')
if (isWaylandDesktop) {
  // '--' 之后的参数由 electron-vite 透传给 electron 可执行文件
  args.push('--', '--ozone-platform=x11')
}

const child = spawn(process.execPath, args, { cwd: rootDir, stdio: 'inherit' })
child.on('close', (code) => process.exit(code ?? 1))
