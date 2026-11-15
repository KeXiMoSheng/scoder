import { spawn } from 'node:child_process'
import type { JsonValue } from '../../../shared/ai/types'
import { detectPowerShell } from '../../powershell'
import type { ToolDefinition } from './registry'
import { optionalInteger, optionalString, requireString } from './registry'

/** 默认超时与上限：命令大多在秒级完成，留出构建/安装的余量 */
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
/** 单条流保留的最大字符数：超出时只保留末尾（报错通常收在这一段） */
const MAX_STREAM_CHARS = 20_000
/** 命令执行器随系统而变：Windows 是 PowerShell，其余是 bash */
const IS_WINDOWS = process.platform === 'win32'

/** 工具描述：必须讲清真实 shell，否则模型会照着 bash 语法发命令 */
const DESCRIPTION = IS_WINDOWS
  ? '在工作区内执行一条命令（Windows 下由 PowerShell 执行），返回 stdout、stderr 与退出码。' +
    '命令按 PowerShell 语法书写：串联用 ;，丢弃错误输出用 2>$null。' +
    '适合运行构建、测试、git 状态、ping/curl 等需要真实进程的操作；' +
    '读写文件请优先用 read/write/edit，不要用 Get-Content/Get-ChildItem 代替。' +
    '每次调用都是全新的 shell，不保留 cd 与环境变量；换目录用 workdir。长输出只保留末尾。'
  : '在工作区内执行一条 shell 命令（新开一个 bash），返回 stdout、stderr 与退出码。' +
    '适合运行构建、测试、git 状态、ping/curl 等需要真实进程的操作；' +
    '读写文件请优先用 read/write/edit，不要用 cat/ls/sed 代替。' +
    '每次调用都是全新的 shell，不保留 cd 与环境变量；换目录用 workdir。长输出只保留末尾。'

/** 一次命令执行的结果（stdout/stderr 已按上限截断） */
interface ShellRun {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** 任意一条流被截断过 */
  truncated: boolean
  timedOut: boolean
}

/**
 * bash 工具：在工作区内执行一条 shell 命令。
 *
 * 与 deepseek-harness 的 tool-bash 对齐的只是最小面：
 * 全新 shell、工作区 cwd、超时、长输出截断、退出码回灌。
 * 审批、沙箱、后台任务都没有实现，扩展点留在 execute 之前——
 * 需要时在派发前询问用户，或在 spawn 时换成受限执行器，工具签名不变。
 */
export function createBashTool(): ToolDefinition {
  return {
    name: 'bash',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: IS_WINDOWS
            ? '要执行的命令（PowerShell 语法），例如 ping -n 4 baidu.com 或 npm run typecheck。'
            : '要执行的命令（bash 语法），例如 ping -c 4 baidu.com 或 npm run typecheck。'
        },
        description: {
          type: 'string',
          description: '一句话说明这条命令做什么（展示在界面上），例如“查看 git 状态”。'
        },
        workdir: {
          type: 'string',
          description: '工作目录，默认工作区根；必须是工作区内的既有目录。'
        },
        timeout_ms: {
          type: 'number',
          description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}。`
        }
      },
      required: ['command'],
      additionalProperties: false
    },
    async execute(args, ctx) {
      const command = requireString(args, 'command')
      const workdirInput = optionalString(args, 'workdir')
      // 目录同样走 fs.resolve：越出工作区会直接报错，不需要工具自己判断
      const workdir =
        workdirInput === undefined ? ctx.cwd : (await ctx.fs.resolve(workdirInput, ctx.cwd)).key
      const timeoutMs = optionalInteger(args, 'timeout_ms', DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
      const run = await runCommand(command, workdir, timeoutMs, ctx.signal)

      if (run.timedOut) {
        throw new Error(
          `命令超时（超过 ${timeoutMs}ms）：${firstLine(command)}\n\n${formatOutput(run)}`
        )
      }
      // 非零退出码是「报告」而不是「工具失败」：一个脚本里某一步失败时，
      // 前面的输出往往仍然有用，交给模型看 stdout 与末尾的 [exit code: N] 判断。
      return {
        text: formatOutput(run),
        meta: {
          command,
          exitCode: run.code,
          ...(run.signal ? { signal: run.signal } : {}),
          ...(run.truncated ? { truncated: true } : {})
        }
      }
    },
    presentCall(args) {
      const command = optionalStringValue(args, 'command')
      return command === undefined
        ? { kind: 'generic', title: '执行命令' }
        : { kind: 'generic', title: firstLine(command) }
    },
    presentResult(args, outcome) {
      const command = optionalStringValue(args, 'command')
      const exitCode = readExitCode(outcome.meta)
      return {
        kind: 'generic',
        title: command === undefined ? '执行命令' : firstLine(command),
        body: outcome.text,
        ...(exitCode === undefined ? {} : { exitCode })
      }
    }
  }
}

/**
 * 执行命令并收集输出。
 * 超时或用户中止都会杀掉整个进程组：shell 拉起的子进程不能留在后台。
 * @param command 交给 shell 的命令原文
 * @param cwd 工作目录（已解析到工作区内）
 * @param timeoutMs 超时毫秒数
 * @param signal 用户中止信号：工具必须转发，否则停止按钮会等到命令自己结束
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<ShellRun> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }

    const shell = resolveShell(command)
    const child = spawn(shell.file, shell.args, {
      cwd,
      env: {
        ...process.env,
        // 关闭颜色转义：界面只展示纯文本
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        TERM: 'dumb'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX 下自成进程组，中止时可以连同子进程一起杀掉
      detached: process.platform !== 'win32',
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false

    const kill = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return
      }
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL')
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        // 进程已经退出或进程组不存在：无需再杀
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    const onAbort = (): void => kill()
    signal.addEventListener('abort', onAbort, { once: true })

    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const appended = appendCapped(stdout, chunk.toString('utf8'))
      stdout = appended.text
      truncated = truncated || appended.truncated
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const appended = appendCapped(stderr, chunk.toString('utf8'))
      stderr = appended.text
      truncated = truncated || appended.truncated
    })

    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    })

    child.on('close', (code, childSignal) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (signal.aborted) {
        // 用户中止不是工具失败：交给循环按 aborted 收尾
        reject(abortReason(signal))
        return
      }
      resolve({ code, signal: childSignal, stdout, stderr, truncated, timedOut })
    })
  })
}

/**
 * 按平台拼出执行器与参数。
 * Windows 下用 PowerShell 的 -EncodedCommand：脚本按 UTF-16LE 转 Base64 传入，
 * 绕开 Windows 命令行与 PowerShell 两层的引号解析，命令里的引号、空格、换行都原样保留。
 * 脚本头部把输出编码改成 UTF-8（stdout 是管道，这里是重定向场景，不会碰控制台代码页），
 * Node 才能正确解码中文；末尾把原生命令的退出码带出来，否则 PowerShell 默认一律返回 0。
 * @param command 模型给出的命令原文
 */
function resolveShell(command: string): { file: string; args: string[] } {
  if (!IS_WINDOWS) {
    return { file: '/bin/bash', args: ['-c', command] }
  }
  const script = [
    // 模块首次分析的进度通知在管道下无处渲染，只会以 CLIXML 写进 stderr
    "$ProgressPreference = 'SilentlyContinue'",
    // 两个编码变量都要设：Console 管 cmdlet 输出，OutputEncoding 管管道与原生命令的交换
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$global:LASTEXITCODE = 0',
    command,
    'exit $global:LASTEXITCODE'
  ].join('\n')
  return {
    file: detectPowerShell(),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ]
  }
}

/** 追加一段输出：超出上限时丢掉开头，只保留末尾 */
function appendCapped(current: string, chunk: string): { text: string; truncated: boolean } {
  const next = current + chunk
  if (next.length <= MAX_STREAM_CHARS) {
    return { text: next, truncated: false }
  }
  return { text: next.slice(next.length - MAX_STREAM_CHARS), truncated: true }
}

/**
 * 整理成模型可读的文本：
 * 首行是命令本身，随后是两条流的正文，最后是退出码标记。
 */
function formatOutput(run: ShellRun): string {
  const parts: string[] = []
  if (run.truncated) {
    parts.push(`…(输出过长，仅保留末尾 ${MAX_STREAM_CHARS} 字符)`)
  }
  const stdout = stripAnsi(run.stdout).trimEnd()
  // CLIXML 只来自 Windows 的 PowerShell；bash 的 stderr 原样保留，免得误伤正文
  const stderr = (IS_WINDOWS ? stripClixml(stripAnsi(run.stderr)) : stripAnsi(run.stderr)).trimEnd()
  if (stdout.length > 0) {
    parts.push(`stdout:\n${stdout}`)
  }
  if (stderr.length > 0) {
    parts.push(`stderr:\n${stderr}`)
  }
  if (run.code === null && run.signal !== null) {
    parts.push(`[signal: ${run.signal}]`)
  } else {
    parts.push(`[exit code: ${run.code ?? 'null'}]`)
  }
  return parts.join('\n\n')
}

/** 去掉常见的 ANSI 颜色/光标转义，界面与模型都只看纯文本 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI 转义本来就带控制字符
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** PowerShell 的 CLIXML 噪音：stderr 被重定向时 progress/error 流会被序列化 */
const CLIXML_MARKER = '#< CLIXML'
/** progress 记录整段丢弃：模块首次分析、Write-Progress 在管道下都没有展示价值 */
const CLIXML_PROGRESS = /<Obj S="progress"[\s\S]*?<\/Obj>/g
/** error 记录里的正文：剥掉 XML 外壳后模型才读得懂 */
const CLIXML_ERROR_TEXT = /<S S="Error">([\s\S]*?)<\/S>/g
const CLIXML_OBJS_TAG = /<\/?Objs\b[^>]*>/g

/**
 * 剥离 PowerShell 的 CLIXML stderr。
 *
 * PowerShell 5.1 在 stderr 不是控制台时会把 progress/error 流序列化成
 * `#< CLIXML` + `<Objs>` 的 XML（每个新进程都带一条「正在准备首次使用模块」），
 * 直接回灌等于把几十行 XML 当成命令输出。这里只保留 error 记录的文本；
 * 认不出结构时原样返回，避免吞掉真正的报错。
 */
function stripClixml(text: string): string {
  if (!text.includes(CLIXML_MARKER)) {
    return text
  }
  const start = text.indexOf('<Objs')
  const end = text.lastIndexOf('</Objs>')
  if (start < 0 || end < start) {
    return text
  }
  // XML 之外是 shell 直接写进 stderr 的内容，原样保留
  const outside = `${text.slice(0, start)}\n${text.slice(end + '</Objs>'.length)}`
    .replace(CLIXML_MARKER, '')
    .trim()
  const body = text.slice(start, end + '</Objs>'.length).replace(CLIXML_PROGRESS, '')
  const messages = Array.from(body.matchAll(CLIXML_ERROR_TEXT), (match) =>
    // 只去尾部的换行，保留 `+ CategoryInfo` 这类行的缩进
    decodeClixmlText(match[1]).trimEnd()
  ).filter((message) => message.trim().length > 0)
  let inside = messages.join('\n')
  if (inside.length === 0) {
    // 没有 error 记录就只剩空壳，丢掉；还有别的记录则保守保留原文
    inside = body.replace(CLIXML_OBJS_TAG, '').trim().length > 0 ? body : ''
  }
  return [inside, outside]
    .filter((part) => part.length > 0)
    .join('\n')
    .trim()
}

/** CLIXML 文本节点：控制字符被写成 _x000D_ 形式，XML 实体也要还原 */
function decodeClixmlText(value: string): string {
  return value
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 中止原因：优先复用 signal 自带的原因 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('用户中止了这一轮对话')
}

/** 行式摘要只放一行：命令可能带换行 */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim()
  return line.length > 0 ? line : '命令'
}

/** 卡片只需要展示用的字符串，读不到就算了，不让展示逻辑抛错 */
function optionalStringValue(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** 从工具 meta 里取退出码：只有数字才认，卡片据此显示 exit N */
function readExitCode(meta: JsonValue | undefined): number | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return undefined
  }
  const value = meta.exitCode
  return typeof value === 'number' ? value : undefined
}
