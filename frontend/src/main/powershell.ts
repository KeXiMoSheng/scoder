import { existsSync } from 'fs'
import { win32 } from 'path'

/**
 * 选一个 PowerShell 可执行文件。
 *
 * 系统装了 PowerShell 7 就用它（Program Files 的默认落点，或 PATH 上的 pwsh.exe），
 * 没有才回退 Windows 自带的 5.1 —— 5.1 会把 progress/error 流序列化成 CLIXML，
 * 并且默认按控制台代码页输出。
 *
 * AI 的 bash 工具与内置终端共用这一处探测，两边的 PowerShell 版本保持一致。
 */
export function detectPowerShell(): string {
  for (const candidate of [systemPowerShell(), ...pwshOnPath()]) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return 'powershell.exe'
}

/** 系统安装的 PowerShell 7：MSI 的默认落点 */
function systemPowerShell(): string {
  return win32.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
}

/** PATH 里逐项找 pwsh.exe：Store 安装与手工解压通常只登记在 PATH 上 */
function pwshOnPath(): string[] {
  return (process.env.PATH ?? '')
    .split(';')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry.length > 0)
    .map((entry) => win32.join(entry, 'pwsh.exe'))
}
