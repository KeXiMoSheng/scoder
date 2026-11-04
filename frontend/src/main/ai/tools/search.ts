import { spawn } from 'child_process'
import { createRequire } from 'module'
import { isAbsolute, relative, sep } from 'path'
import type { ToolContext, ToolDefinition } from './registry'
import { optionalString, requireString, sectionText } from './registry'

/** 单次 glob 返回的路径上限 */
const GLOB_MAX_RESULTS = 200
/** 单次 grep 返回的匹配行上限 */
const GREP_MAX_MATCHES = 100
/** grep 单行预览长度 */
const GREP_MAX_LINE_LENGTH = 300
/** 单次 ripgrep 原始输出上限：超过就整次失败，绝不解析半截结果 */
const RAW_OUTPUT_MAX_BYTES = 20 * 1024 * 1024
/** 单次搜索的协作式时限：注册表到点中止信号，信号再转成杀掉 rg 子进程 */
const SEARCH_TIMEOUT_MS = 30000
/** 版本库元数据目录：任何搜索都不进入 */
const VCS_DIRECTORY_NAMES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']
/**
 * 默认剪掉的噪音目录：依赖缓存与编译产物。
 * 省略 path 时按目录名剪枝；显式传 path 视为调用方自己缩小了范围，这时不再剪枝。
 */
const NOISE_DIRECTORY_NAMES = [
  'node_modules',
  'dist',
  'out',
  'build',
  'bin',
  'target',
  'obj',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache'
]

/** 一条 grep 匹配：文件路径、1 起行号、行内容（未截断） */
interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

/** 一次 ripgrep 运行结果 */
interface RipgrepRun {
  /** 完整 stdout */
  stdout: string
  /** rg 退出码 1：搜索成功但零结果 */
  noMatches: boolean
}

const requireFromHere = createRequire(__filename)

let ripgrepPath: string | undefined

/**
 * 定位随依赖安装的 ripgrep 二进制。
 * 不直接 import @vscode/ripgrep：它是纯 ESM，主进程打成 CJS 后无法 require；
 * 这里改走平台子包解析，顺便拿到可执行文件路径。
 * Electron 打包后 __filename 位于 app.asar 内，而二进制必须从 app.asar.unpacked 执行，
 * 所以把路径里的 app.asar 换成 app.asar.unpacked（electron-builder 的 asarUnpack 会解出同一份文件）。
 * @returns 可直接 spawn 的 ripgrep 绝对路径
 */
function resolveRipgrepPath(): string {
  if (ripgrepPath !== undefined) return ripgrepPath
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const platformPackage = `@vscode/ripgrep-${process.platform}-${process.arch}`
  let resolved: string
  try {
    resolved = requireFromHere.resolve(`${platformPackage}/bin/${binary}`)
  } catch (error) {
    throw new Error(
      `找不到 ripgrep 二进制（${platformPackage}）：请确认依赖已安装且随安装包分发了对应平台的二进制`,
      { cause: error }
    )
  }
  ripgrepPath = resolved.replace(/app\.asar(?=[\\/])/u, 'app.asar.unpacked')
  return ripgrepPath
}

/**
 * 运行一次 ripgrep。
 * 输出超过上限、退出码异常、用户中止都会变成明确的错误，不返回部分结果；
 * 退出码 1 是“零结果”，按成功处理。
 * @param ctx 工具上下文（工作目录与中止信号）
 * @param args ripgrep 参数（不含二进制本身）
 * @returns 完整 stdout 与零结果标记
 */
function runRipgrep(ctx: ToolContext, args: string[]): Promise<RipgrepRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveRipgrepPath(), ['--no-config', ...args], {
      cwd: ctx.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    let overflow = false
    let settled = false

    const onAbort = (): void => {
      child.kill()
    }
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      ctx.signal.removeEventListener('abort', onAbort)
      action()
    }

    ctx.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > RAW_OUTPUT_MAX_BYTES) {
        overflow = true
        child.kill()
        return
      }
      stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      settle(() => reject(new Error(`无法启动 ripgrep：${error.message}`, { cause: error })))
    })
    child.on('close', (code) => {
      settle(() => {
        if (ctx.signal.aborted) {
          reject(new Error('搜索已中止'))
          return
        }
        if (overflow) {
          reject(
            new Error(
              `搜索结果超过 ${RAW_OUTPUT_MAX_BYTES / 1024 / 1024} MB，请用 path 或更精确的模式缩小范围`
            )
          )
          return
        }
        if (code === 0 || code === 1) {
          resolve({ stdout: Buffer.concat(stdout).toString('utf8'), noMatches: code === 1 })
          return
        }
        reject(
          new Error(`ripgrep 搜索失败（退出码 ${String(code)}）：${stderr.trim() || '无错误输出'}`)
        )
      })
    })
  })
}

/**
 * 构造两个搜索工具共用的参数：不读 ignore 文件、包含隐藏文件、排除版本库元数据。
 * glob 与 grep 必须看到同一套文件，否则会出现“glob 找得到、grep 搜不到”的假象，
 * 因此两边共用这里；噪音目录只在未指定 path 时剪枝。
 * @param pruneNoise 是否按目录名剪掉依赖缓存与编译产物
 * @returns 附加参数列表
 */
function buildCommonArgs(pruneNoise: boolean): string[] {
  const args = ['--no-ignore', '--hidden']
  for (const name of VCS_DIRECTORY_NAMES) {
    args.push(`--glob=!**/${name}`, `--glob=!**/${name}/**`)
  }
  if (pruneNoise) {
    for (const name of NOISE_DIRECTORY_NAMES) {
      args.push(`--glob=!**/${name}`, `--glob=!**/${name}/**`)
    }
  }
  return args
}

/** 是否按目录名剪掉依赖缓存与编译产物：只有把起点锁定到具体目录/文件时才不剪 */
function shouldPruneNoise(start: string | undefined): boolean {
  return start === undefined || start === '.' || start === './'
}

/** 把 ripgrep 给出的路径统一成相对工作区根、使用 / 分隔的展示路径 */
function toWorkspaceRelative(path: string, root: string): string {
  const display = isAbsolute(path) ? relative(root, path) : path
  return display.length === 0 ? '.' : display.split(sep).join('/')
}

/**
 * 超过上限时按顶层目录轮转取样：先保证每个顶层目录各取一条，再轮流取第二条。
 * 直接截断会让某个子项目霸占全部名额，宽模式下的结果就只剩一个角落。
 * @param paths 完整结果（组内保持 ripgrep 的修改时间顺序）
 * @param maxItems 本次最多返回多少条
 * @returns 轮转后的子集
 */
function sampleAcrossTopLevel(paths: readonly string[], maxItems: number): string[] {
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const key = path.split('/')[0]
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [path])
    else group.push(path)
  }
  const result: string[] = []
  for (let index = 0; result.length < maxItems; index += 1) {
    let taken = false
    for (const group of groups.values()) {
      const item = group[index]
      if (item === undefined) continue
      result.push(item)
      taken = true
      if (result.length >= maxItems) break
    }
    if (!taken) break
  }
  return result
}

/**
 * 逐行解析 `rg --json` 输出，只收 match 记录。
 * 非法 JSON 或缺少路径/行号的记录直接报错，避免把不完整数据回灌给模型。
 * @param stdout 完整 stdout
 * @param root 工作区根（用于把绝对路径转成展示路径）
 * @returns 匹配列表，保持 ripgrep 输出顺序
 */
function parseGrepMatches(stdout: string, root: string): GrepMatch[] {
  const matches: GrepMatch[] = []
  for (const raw of stdout.split('\n')) {
    if (raw.length === 0) continue
    let record: {
      type?: unknown
      data?: { path?: { text?: unknown }; line_number?: unknown; lines?: { text?: unknown } }
    }
    try {
      record = JSON.parse(raw)
    } catch (error) {
      throw new Error('ripgrep 输出不是合法的 JSON', { cause: error })
    }
    // begin/end/summary 等是传输分帧，不是结果
    if (record.type !== 'match') continue
    const data = record.data
    const path = data?.path?.text
    const lineNumber = data?.line_number
    const line = data?.lines?.text
    if (typeof path !== 'string' || typeof lineNumber !== 'number') {
      throw new Error('ripgrep 的 match 记录缺少路径或行号')
    }
    matches.push({
      path: toWorkspaceRelative(path, root),
      lineNumber,
      // 非 UTF-8 行 rg 只给 bytes，这里给占位提示，不让整次搜索失败
      line: typeof line === 'string' ? line.replace(/\r?\n$/, '') : '(该行不是合法的 UTF-8 文本)'
    })
  }
  return matches
}

/**
 * glob 工具：按路径模式查找文件。
 * 与 grep 的分工：glob 找“哪些文件”，grep 找“哪一行”。
 * 全仓扫描交给 ripgrep：它不会被文件数预算截断，模式前缀里的目录还会被自动剪枝。
 */
export function createGlobTool(): ToolDefinition {
  return {
    name: 'glob',
    description:
      '按 glob 模式查找工作区内的文件路径（ripgrep 扫描，含隐藏文件）。支持 *、**、?、{a,b}；' +
      `结果相对工作区根，按修改时间排序，最多返回 ${GLOB_MAX_RESULTS} 条。` +
      '省略 path 时默认跳过 node_modules、bin、target、out 等依赖与编译产物目录；要搜它们请显式传 path。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'glob 模式，例如 src/**/*.ts 或 **/*.test.ts。'
        },
        path: {
          type: 'string',
          description: '搜索起点：文件或目录，相对于工作区根；省略时为工作区根。'
        }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    async execute(args, ctx) {
      const pattern = requireString(args, 'pattern')
      const start = optionalString(args, 'path')
      const target = await ctx.fs.resolve(start ?? '.', ctx.cwd)
      const info = await ctx.fs.stat(target)
      if (!info) {
        throw new Error(`搜索起点不存在：${target.displayPath}`)
      }
      if (info.type !== 'file' && info.type !== 'directory') {
        throw new Error(`搜索起点不是文件或目录：${target.displayPath}`)
      }
      const run = await runRipgrep(ctx, [
        '--files',
        `--glob=${pattern}`,
        '--sort=modified',
        ...buildCommonArgs(shouldPruneNoise(start)),
        '--',
        target.key
      ])
      const root = ctx.fs.root.key
      const paths = run.noMatches
        ? []
        : run.stdout
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => toWorkspaceRelative(line, root))
      const page =
        paths.length <= GLOB_MAX_RESULTS ? paths : sampleAcrossTopLevel(paths, GLOB_MAX_RESULTS)
      const lines =
        page.length > 0
          ? page.join('\n')
          : `没有匹配 ${pattern} 的文件。检查模式，或先用 list 看一下目录结构。`
      const capped = paths.length > page.length
      return {
        text:
          `<pattern>${pattern}</pattern>\n<matches>\n${lines}\n</matches>` +
          (capped
            ? `\n(共 ${paths.length} 条，按顶层目录轮转只显示 ${page.length} 条；用 path 或更精确的模式缩小范围。)`
            : ''),
        meta: { pattern, count: page.length, total: paths.length }
      }
    },
    presentCall(args) {
      const pattern = optionalString(args, 'pattern') ?? '*'
      return { kind: 'generic', title: `查找 ${pattern}` }
    },
    presentResult(args, outcome) {
      const pattern = optionalString(args, 'pattern') ?? '*'
      // 展开时只保留匹配列表，去掉给模型看的 `<pattern>`/`<matches>` 包裹
      return {
        kind: 'generic',
        title: `查找 ${pattern}`,
        body: sectionText(outcome.text, 'matches')
      }
    }
  }
}

/**
 * grep 工具：按 ripgrep 正则查找匹配行。
 * 只返回 路径:行号:内容，不带上下文行；path 是文件时只搜该文件。
 */
export function createGrepTool(): ToolDefinition {
  return {
    name: 'grep',
    description:
      '在工作区文本文件里按正则查找匹配行（ripgrep 语义，含隐藏文件），返回 路径:行号:内容。' +
      'path 可以是单个文件（只搜它）或目录；可配合 glob 参数缩小范围；' +
      '省略 path 时默认跳过 node_modules、bin、target、out 等目录。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ripgrep 正则表达式，例如 afterBindData\\(' },
        path: {
          type: 'string',
          description: '搜索起点：文件或目录，相对于工作区根；省略时为工作区根。'
        },
        glob: { type: 'string', description: '只搜索匹配该 glob 的文件，例如 **/*.ts。' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    async execute(args, ctx) {
      const pattern = requireString(args, 'pattern')
      const start = optionalString(args, 'path')
      const globFilter = optionalString(args, 'glob')
      const target = await ctx.fs.resolve(start ?? '.', ctx.cwd)
      const info = await ctx.fs.stat(target)
      if (!info) {
        throw new Error(`搜索起点不存在：${target.displayPath}`)
      }
      if (info.type !== 'file' && info.type !== 'directory') {
        throw new Error(`搜索起点不是文件或目录：${target.displayPath}`)
      }
      const run = await runRipgrep(ctx, [
        '--json',
        `--regexp=${pattern}`,
        ...(globFilter === undefined ? [] : [`--glob=${globFilter}`]),
        ...buildCommonArgs(shouldPruneNoise(start)),
        '--',
        target.key
      ])
      const matches = run.noMatches ? [] : parseGrepMatches(run.stdout, ctx.fs.root.key)
      const retained = matches.slice(0, GREP_MAX_MATCHES)
      const body =
        retained.length > 0
          ? retained
              .map((match) => `${match.path}:${match.lineNumber}: ${clip(match.line)}`)
              .join('\n')
          : `没有匹配 /${pattern}/ 的行。换一个更短的正则，或先用 glob 确认文件范围。`
      const capped = matches.length > retained.length
      return {
        text:
          `<pattern>${pattern}</pattern>\n<matches>\n${body}\n</matches>` +
          (capped
            ? `\n(共 ${matches.length} 条，仅显示前 ${retained.length} 条；用 path 或更精确的正则缩小范围。)`
            : ''),
        meta: { pattern, count: retained.length, total: matches.length }
      }
    },
    presentCall(args) {
      const pattern = optionalString(args, 'pattern') ?? ''
      return { kind: 'generic', title: `搜索 /${pattern}/` }
    },
    presentResult(args, outcome) {
      const pattern = optionalString(args, 'pattern') ?? ''
      // 展开时只保留匹配行，去掉给模型看的 `<pattern>`/`<matches>` 包裹
      return {
        kind: 'generic',
        title: `搜索 /${pattern}/`,
        body: sectionText(outcome.text, 'matches')
      }
    }
  }
}

/** 截断超长匹配行，保留开头 */
function clip(line: string): string {
  return line.length <= GREP_MAX_LINE_LENGTH ? line : `${line.slice(0, GREP_MAX_LINE_LENGTH)}…`
}
