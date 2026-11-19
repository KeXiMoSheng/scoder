import { execFile } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { isAbsolute, join, relative, sep, win32 } from 'path'
import { findExecutable } from '../executable'
import type {
  GitFileStatus,
  GitStatusEntry,
  GitStatusSnapshot,
  GitVersionInfo
} from '../../shared/git/types'

/**
 * Git 命令（主进程侧）：可执行文件探测、版本测试，以及文件树用的工作区状态。
 *
 * 这里不依赖 Electron：命令执行与输出解析可以脱离窗口单独调用与验证。
 *
 * 自动监测的订阅与推送在 `git/monitor` 里（Electron IPC），
 * 本文件只负责「读一次状态」。
 */

/** `status` 的单次超时（ms）：超大仓库首次读取会慢一些，但不应无限等待 */
const GIT_STATUS_TIMEOUT = 10_000

/** 版本探测的单次超时（ms） */
const GIT_VERSION_TIMEOUT = 5000

/** 一次命令的结局：抛错也归一成结构化结果，便于用 stderr 判断「不是仓库」 */
interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 选一个 git 可执行文件。
 *
 * 默认交给 PATH 自动探测（`git`），这样装了 Git 的用户开箱可用；
 * 用户显式指定路径时优先使用，路径失效则回退自动探测，不让设置项把功能锁死。
 * @param configuredPath 设置页保存的可执行文件绝对路径；空字符串表示自动探测
 */
export function detectGit(configuredPath: string): string {
  const trimmed = configuredPath.trim()
  if (trimmed.length > 0 && existsSync(trimmed)) {
    return trimmed
  }
  return 'git'
}

/**
 * 自动探测 git 可执行文件的绝对路径，供设置页预先填入。
 *
 * 先按当前平台的 PATH 规则查找，再尝试 Git for Windows 与 POSIX 的常见安装目录；
 * 返回的路径使用当前系统的目录分隔符（Windows 为 `\`，POSIX 为 `/`）。
 * @returns 找到的绝对路径；系统里没有可用的 git 时为 null
 */
export function detectGitPath(): string | null {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA
    return findExecutable(
      ['git.exe'],
      [
        win32.join(programFiles, 'Git', 'cmd', 'git.exe'),
        win32.join(programFiles, 'Git', 'bin', 'git.exe'),
        win32.join(programFilesX86, 'Git', 'cmd', 'git.exe'),
        localAppData ? win32.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe') : null
      ]
    )
  }
  return findExecutable(['git'], ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'])
}

/**
 * 实际运行一次 `git --version` 并取回版本号。
 * 设置页的「测试」按钮使用：保存前就能确认路径可用。
 *
 * 测试用的就是填写的路径本身：填错时报错，而不是悄悄回退去测 PATH 上的 git
 * （那是文件树读取状态时的回退策略，不是测试的语义）。空字符串才测试自动探测结果。
 * @param file 设置页里填写的路径；空字符串时测试自动探测到的 git
 * @throws 可执行文件无法启动、执行超时或输出无法解析
 */
export async function probeGitVersion(file: string): Promise<GitVersionInfo> {
  const trimmed = file.trim()
  const executable = trimmed.length > 0 ? trimmed : 'git'
  const result = await runGit(executable, ['--version'], process.cwd(), GIT_VERSION_TIMEOUT)
  if (result.code !== 0) {
    throw new Error(readFailure(executable, result.stderr))
  }
  const version = /^git version\s+(.+)$/m.exec(result.stdout)?.[1]?.trim() ?? ''
  if (version.length === 0) {
    throw new Error(`命令执行成功，但没有读到版本号：${executable}`)
  }
  return { file: executable, version }
}

/**
 * 读一次工作区的 Git 状态。
 *
 * 工作区可以只是仓库的一个子目录：所有路径都换算成相对该工作区根的路径，
 * 工作区之外的变化被丢弃，文件树因此永远只标记自己显示得到的条目。
 * @param root 工作区根目录绝对路径
 * @param configuredPath 设置页保存的 git 路径；空字符串表示自动探测
 * @returns 状态快照；读取失败体现在 `error` 字段，不抛错
 */
export async function readGitStatus(
  root: string,
  configuredPath: string
): Promise<GitStatusSnapshot> {
  const executable = detectGit(configuredPath)
  const top = await runGit(executable, ['rev-parse', '--show-toplevel'], root, GIT_STATUS_TIMEOUT)
  if (top.code !== 0) {
    // 不是仓库是正常结果：文件树不显示任何标记，而不是报错
    if (/not a git repository/i.test(top.stderr)) {
      return { root, isRepo: false, entries: [] }
    }
    return { root, isRepo: false, entries: [], error: readFailure(executable, top.stderr) }
  }
  const repositoryRoot = top.stdout.trim()
  if (repositoryRoot.length === 0) {
    return { root, isRepo: false, entries: [], error: 'git rev-parse 未返回仓库根目录' }
  }
  const status = await runGit(
    executable,
    [
      '-c',
      'core.quotepath=false',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      '--',
      '.'
    ],
    root,
    GIT_STATUS_TIMEOUT
  )
  if (status.code !== 0) {
    return { root, isRepo: true, entries: [], error: readFailure(executable, status.stderr) }
  }
  return {
    root,
    isRepo: true,
    // 工作区可能是符号链接，git 报出的却是真实路径：按真实路径换算，条目才对得上
    entries: parseStatus(status.stdout, repositoryRoot, canonicalPath(root))
  }
}

/**
 * 把 porcelain v1 的 `-z` 输出换算成相对工作区根的条目。
 *
 * 记录以 NUL 分隔；重命名/复制记录后面紧跟一条「原路径」记录，需要一并跳过。
 * @param output `git status --porcelain=v1 -z` 的原始输出
 * @param repositoryRoot 仓库根目录绝对路径
 * @param workspaceRoot 工作区根目录绝对路径
 * @returns 按路径排序的条目；工作区之外的路径被丢弃
 */
export function parseStatus(
  output: string,
  repositoryRoot: string,
  workspaceRoot: string
): GitStatusEntry[] {
  const entries = new Map<string, GitFileStatus>()
  const records = output.split('\0')
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record === undefined || record.length < 4) {
      continue
    }
    const stages = record.slice(0, 2)
    // 重命名/复制的来源路径是下一条记录，不代表新的变更
    if (stages.startsWith('R') || stages.startsWith('C')) {
      index++
    }
    const absolute = isAbsolute(record.slice(3))
      ? record.slice(3)
      : join(repositoryRoot, record.slice(3))
    const relativePath = relative(workspaceRoot, absolute)
    // 工作区之外的路径（工作区只是仓库子目录时会出现）不参与展示
    if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      continue
    }
    entries.set(relativePath.split(sep).join('/'), toFileStatus(stages))
  }
  return [...entries]
    .map(([path, status]) => ({ path, status }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

/** 把两位状态码归并成文件树展示的三种状态 */
function toFileStatus(stages: string): GitFileStatus {
  const [index, worktree] = stages
  // 未跟踪：仓库里全新的文件
  if (index === '?') {
    return 'added'
  }
  // 冲突（UU / AA / DD 等）：文件还在，需要人工处理，按修改展示
  if (
    index === 'U' ||
    worktree === 'U' ||
    (index === 'A' && worktree === 'A') ||
    (index === 'D' && worktree === 'D')
  ) {
    return 'modified'
  }
  // 未暂存的删除与已暂存的删除都表示工作区里已经没有这个文件
  if (index === 'D' || worktree === 'D') {
    return 'deleted'
  }
  if (index === 'A' || index === 'R' || index === 'C') {
    return 'added'
  }
  return 'modified'
}

/** 单次命令的输出上限：仓库很大时 porcelain 列表也会很长，超限按失败处理 */
const GIT_MAX_BUFFER = 8 * 1024 * 1024

/** 需要从继承环境里清掉的仓库选择变量：文件树读的是用户打开的项目，不是宿主进程碰巧所在的仓库 */
const GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT'
]

/** 运行一次 git，把「无法启动」也归一成带 stderr 的结果 */
function runGit(file: string, args: string[], cwd: string, timeout: number): Promise<GitRunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: GIT_MAX_BUFFER, env: gitEnvironment() },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        const code = typeof error.code === 'number' ? error.code : 1
        // 命令根本启动不了时 stderr 为空，把系统错误原文带上，否则用户只看到「失败」
        resolve({ code, stdout, stderr: stderr.length > 0 ? stderr : error.message })
      }
    )
  })
}

/** 清掉继承的仓库选择变量，并禁止交互式提示 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of GIT_ENV_KEYS) {
    delete env[key]
  }
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.LC_ALL = 'C'
  return env
}

/** 失败原因：优先用 git 自己写进 stderr 的最后一行 */
function readFailure(file: string, stderr: string): string {
  const detail = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop()
  return detail ? `无法运行 ${file}：${detail}` : `无法运行 ${file}`
}

/** 解析为真实路径；路径不可读时原样返回，让后续步骤给出具体的失败原因 */
function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}
