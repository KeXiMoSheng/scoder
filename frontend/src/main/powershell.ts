import { execFile } from 'child_process'
import { existsSync } from 'fs'

/**
 * 选一个 PowerShell 可执行文件。
 *
 * 只有用户在系统配置里显式指定了 PowerShell 7，才使用它；
 * 没配置（默认）一律回退 Windows 自带的 5.1 —— 5.1 会把 progress/error 流
 * 序列化成 CLIXML，并且默认按控制台代码页输出。
 * PS7 的安装位置五花八门（MSI、Store、zip 解压、自定义目录），不做自动探测。
 *
 * AI 的 bash 工具与内置终端共用这一处探测，两边的 PowerShell 版本保持一致。
 * @param configuredPath 设置页保存的 pwsh.exe 绝对路径；空字符串表示不使用 PS7
 */
export function detectPowerShell(configuredPath: string): string {
  if (configuredPath.length > 0 && existsSync(configuredPath)) {
    return configuredPath
  }
  return 'powershell.exe'
}

/**
 * 实际启动一次 PowerShell 并取回 `$PSVersionTable` 的版本号。
 * 设置页的「测试」按钮与终端页签的版本探测共用。
 * @param file PowerShell 可执行文件的绝对路径
 * @throws 可执行文件无法启动、执行超时或没有输出版本号
 */
export function probePowerShellVersion(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$PSVersionTable.PSVersion.ToString()'
      ],
      { timeout: 5000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(readFailure(error, stderr)))
          return
        }
        const version = stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
        if (version.length === 0) {
          reject(new Error('命令执行成功，但没有读到版本号'))
          return
        }
        resolve(version)
      }
    )
  })
}

/** 失败原因：优先用进程写进 stderr 的最后一行，否则用 execFile 自带的错误消息 */
function readFailure(error: Error, stderr: string): string {
  const detail = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#< CLIXML'))
    .pop()
  return detail ? `无法运行该 PowerShell：${detail}` : `无法运行该 PowerShell：${error.message}`
}
