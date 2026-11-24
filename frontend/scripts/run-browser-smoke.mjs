/**
 * 浏览器冒烟测试的启动器：用 Electron 自带的主进程跑 .browser-smoke/browser.cjs。
 *
 * 直接用 electron 命令时，不同平台的参数差异会漏进 npm 脚本：
 * Linux 需要 ozone headless 才能在无显示器环境创建隐藏窗口，而 Windows / macOS
 * 不认这个平台参数。这里统一拼一次参数，后续只维护一份。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
/** electron 包在 Node 里默认导出可执行文件路径 */
const electron = require('electron')
/** 产物相对 frontend 目录：不依赖调用方的 cwd */
const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = ['--disable-gpu']
if (process.platform === 'linux') {
  // 无真实显示器时用 ozone headless，避免依赖 X server
  args.push('--ozone-platform=headless', '--no-sandbox')
}
args.push(join(frontendRoot, '.browser-smoke', 'browser.cjs'))

const child = spawn(electron, args, { stdio: 'inherit', env: process.env })
child.on('error', (error) => {
  console.error('启动 Electron 失败', error)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`Electron 被信号终止：${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
