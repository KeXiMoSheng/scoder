/** Markdown 渲染层：markdown-it 实例与预览用到的自定义渲染规则 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Check, ChevronDown, Files, type LucideIcon } from 'lucide-react'
import MarkdownIt, { type Token } from 'markdown-it'
import { basename } from './filePath'
import { resolveMarkdownLanguage } from './language'

/** 把本地目录转成 file:// URL（保留末尾斜杠，供相对地址解析） */
function toDirectoryUrl(path: string): string {
  // Windows 路径（C:\a\b）先统一为正斜杠，再补前导斜杠组成 file:///C:/a/b/
  const normalized = path.replace(/\\/g, '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${prefixed}${prefixed.endsWith('/') ? '' : '/'}`
}

/**
 * 把 Markdown 中的图片地址解析为可加载的 URL：
 * 远程地址与 data: 内嵌图片原样保留，相对路径基于 Markdown 文件所在目录解析为 file://
 */
function resolveImageSrc(src: string | null, basePath?: string): string | null {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || !basePath) {
    return null
  }
  try {
    return new URL(src, toDirectoryUrl(basePath)).href
  } catch {
    return null
  }
}

/** 行内代码、链接或裸文本中识别出的文件目标 */
interface FileTarget {
  /** 原始路径文本：相对路径由点击处按来源基准解析 */
  path: string
  /** 从 :12 / :12:5 / #L12 后缀解析出的目标行（1 起） */
  line?: number
  /** 行号范围的结束行（包含）：#L109-L110 / path:109-110；与 line 相同时不设置 */
  endLine?: number
}

/**
 * 显式文件路径前缀：绝对路径、./、../、~/ 与 Windows 盘符。
 * 与 deepseek-harness 的 isExplicitFilePath 对齐，不依赖扩展名白名单。
 */
const EXPLICIT_PATH_PREFIX = /^(?:[\\/]|\.{1,2}[\\/]|~[\\/]|[a-z]:[\\/])/i

/** 无扩展名的常见文件名（Makefile 这类无法靠形态与标识符区分） */
const FILE_BASENAMES = new Set(['makefile', 'dockerfile', '.gitignore', '.editorconfig', '.npmrc'])

/** decodeURIComponent 对畸形转义会抛错：失败时保留原文 */
function safeDecodeURI(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 拆分行号后缀：path:12、path:12:5、path:12-15、path#L12、path#L109-L110（结束行可选） */
function splitLineSuffix(text: string): FileTarget {
  let path = text
  let line: number | undefined
  let endLine: number | undefined
  const hashMatch = path.match(/^(.*?)#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i)
  if (hashMatch) {
    path = hashMatch[1]
    line = Number.parseInt(hashMatch[2], 10)
    endLine = hashMatch[3] === undefined ? undefined : Number.parseInt(hashMatch[3], 10)
  } else {
    // Windows 盘符（C:）不参与行号匹配
    const colonMatch = path.match(/^(.+?):(\d+)(?::\d+)?(?:-(\d+))?$/)
    if (colonMatch && !/^[a-z]:$/i.test(colonMatch[1])) {
      path = colonMatch[1]
      line = Number.parseInt(colonMatch[2], 10)
      endLine = colonMatch[3] === undefined ? undefined : Number.parseInt(colonMatch[3], 10)
    }
  }
  if (line === undefined) {
    return { path }
  }
  return endLine !== undefined && endLine > line ? { path, line, endLine } : { path, line }
}

/** 是否为协议地址（http://、file://、mailto: 等），这些不是项目文件 */
function isProtocolAddress(text: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ||
    /^(?:mailto|data|tel|javascript|blob|vbscript):/i.test(text)
  )
}

/** 任意扩展名后缀（不依赖固定白名单）：.java、.scala、.proto、.env…… */
const FILE_EXTENSION_SUFFIX = /\.[A-Za-z0-9!_~+-]{1,12}$/

/**
 * 判断一个 token 是否值得当作文件路径候选（不依赖扩展名白名单）。
 * 是否真正可点击由 MarkdownPreview 用 statFile 结合工作区真实文件判定；
 * 这里只排除明显不是路径的内容（命令、表达式、普通标识符）。
 */
function looksLikeFilePath(path: string): boolean {
  return (
    EXPLICIT_PATH_PREFIX.test(path) ||
    path.includes('/') ||
    path.includes('\\') ||
    FILE_EXTENSION_SUFFIX.test(path)
  )
}

/**
 * 裸文本是弱信号：除了带路径分隔符，还要求显式路径前缀或任意扩展名，
 * 避免把 and/or、a/b/c 这类普通文本都送去文件校验。
 */
function looksLikeBareFilePath(path: string): boolean {
  return EXPLICIT_PATH_PREFIX.test(path) || FILE_EXTENSION_SUFFIX.test(path)
}

/**
 * 解析行内代码/裸文本中的文件路径候选。
 * 支持行号后缀；含空白、括号、引号等明显不是路径的内容不识别；
 * 单文件名（如 package.json）也算候选，最终由文件存在性校验决定是否可点击。
 */
function parseFileTarget(raw: string): FileTarget | null {
  const text = raw.trim()
  if (!text || /\s/.test(text) || /[<>()"'`{}]/.test(text) || isProtocolAddress(text)) {
    return null
  }
  const target = splitLineSuffix(text)
  // 目录（以分隔符结尾）不可打开，不标记
  if (!target.path || /[\\/]$/.test(target.path)) {
    return null
  }
  const name = basename(target.path).toLowerCase()
  if (!looksLikeFilePath(target.path) && !FILE_BASENAMES.has(name)) {
    return null
  }
  return target
}

/**
 * 解析 Markdown 链接目标（对齐 deepseek-harness 的 parseFileLink）：
 * 链接本身带有导航语义，显式文件路径或非绝对 URL 的相对地址都视为本地文件，
 * 不依赖扩展名白名单；协议地址、页内锚点与协议相对地址（//host）除外。
 */
function parseLinkTarget(raw: string): FileTarget | null {
  const text = raw.trim()
  if (!text || text.startsWith('#') || text.startsWith('//') || isProtocolAddress(text)) {
    return null
  }
  const target = splitLineSuffix(text)
  if (!target.path || /[\\/]$/.test(target.path)) {
    return null
  }
  return target
}

// html: false 表示不解析内联 HTML：文件内容与 AI 输出都可能夹带任意标签，
// 禁用后所有 HTML 按文本转义，避免脚本注入渲染进程
const md = new MarkdownIt({ html: false, linkify: true })

/**
 * 工具条图标：Markdown 渲染结果是 HTML 字符串，无法直接挂载 React 组件，
 * 因此在模块初始化时把 lucide 图标渲染成静态 SVG 字符串嵌入；
 * 颜色由 stroke="currentColor" 继承按钮文字色，尺寸由 main.css 的 .md-icon 规则控制。
 */
function iconMarkup(Icon: LucideIcon, className: string): string {
  return renderToStaticMarkup(
    createElement(Icon, {
      className: className ? `md-icon ${className}` : 'md-icon',
      'aria-hidden': true
    })
  )
}

const CHEVRON_ICON = iconMarkup(ChevronDown, 'md-code-chevron')
const COPY_ICON = iconMarkup(Files, '')
const CHECK_ICON = iconMarkup(Check, '')

// 代码块：语言标识转成 Monaco 语言 id，正文直接作为 pre 的文本节点。
// 预览侧用 monaco.editor.colorizeElement 着色，而该 API 只读取元素的第一个文本子节点，
// 因此不能再套一层 <code>；工具条（语言名 + 复制）必须放在 pre 之外，否则会被着色结果覆写
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const language = resolveMarkdownLanguage(token.info)
  const languageAttr = language ? ` data-lang="${md.utils.escapeHtml(language)}"` : ''
  const label = language && language !== 'plaintext' ? language : 'text'
  return (
    '<div class="md-code-block">' +
    '<div class="md-code-bar">' +
    '<button type="button" class="md-code-lang" data-md-code-toggle aria-expanded="true" ' +
    `title="收起代码块"><span>${md.utils.escapeHtml(label)}</span>${CHEVRON_ICON}</button>` +
    '<button type="button" class="md-code-copy" data-md-code-copy ' +
    'title="复制代码" aria-label="复制代码">' +
    `<span class="md-code-icon" data-md-icon="copy">${COPY_ICON}</span>` +
    `<span class="md-code-icon" data-md-icon="check">${CHECK_ICON}</span>` +
    '</button>' +
    '</div>' +
    `<pre class="md-code"${languageAttr}>${md.utils.escapeHtml(token.content)}</pre>` +
    '</div>\n'
  )
}

// 图片：相对路径重写为 file:// 绝对地址，否则渲染进程会以页面所在目录为基准解析
const defaultImageRule = md.renderer.rules.image

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const basePath = typeof env?.basePath === 'string' ? env.basePath : undefined
  const src = token.attrGet('src')
  const resolved = resolveImageSrc(typeof src === 'string' ? src : null, basePath)
  if (resolved) {
    token.attrSet('src', resolved)
  }
  // 交给默认规则：它会用图片描述补齐 alt（renderToken 不会）
  return defaultImageRule(tokens, idx, options, env, self)
}

/** 文本是否位于链接文字内：链接整体由 link_open 规则接管，避免嵌套可点击元素 */
function isInsideLink(tokens: Token[], idx: number): boolean {
  let depth = 0
  for (let index = 0; index < idx; index += 1) {
    if (tokens[index].type === 'link_open') {
      depth += 1
    } else if (tokens[index].type === 'link_close') {
      depth -= 1
    }
  }
  return depth > 0
}

/**
 * 文件跳转元素的公共属性。
 * data-md-file 保留原文，由 MarkdownPreview 结合文档目录 / 工作区根解析成绝对路径；
 * base 决定优先基准：行内代码与裸文本走 workspace，链接走 document。
 * kind=mention 的元素（行内代码/裸文本）还要通过真实文件校验才显示为可点击；
 * kind=link 是 Markdown 显式链接，本身就是导航声明。
 */
function fileTargetAttrs(
  target: FileTarget,
  base: 'workspace' | 'document',
  kind: 'mention' | 'link'
): string {
  const lineLabel =
    target.line === undefined
      ? ''
      : target.endLine === undefined
        ? `（第 ${target.line} 行）`
        : `（第 ${target.line}-${target.endLine} 行）`
  const attrs = [
    'class="md-file-link"',
    `data-md-file="${md.utils.escapeHtml(target.path)}"`,
    `data-md-base="${base}"`,
    `data-md-file-kind="${kind}"`,
    'role="link"',
    'tabindex="0"',
    `title="打开 ${md.utils.escapeHtml(target.path)}${lineLabel}"`
  ]
  if (target.line !== undefined) {
    attrs.push(`data-md-line="${target.line}"`)
  }
  if (target.endLine !== undefined) {
    attrs.push(`data-md-end-line="${target.endLine}"`)
  }
  return attrs.join(' ')
}

// 行内代码：内容像文件路径时标记候选（真实存在性由 MarkdownPreview 校验），否则走默认渲染
const defaultCodeInlineRule = md.renderer.rules.code_inline

md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  // 链接文字内的行内代码不单独标记：整个链接已可点击，避免可点击元素嵌套
  if (env?.fileLinks && !isInsideLink(tokens, idx)) {
    const target = parseFileTarget(token.content)
    if (target) {
      // ./ 与 ../ 开头按文档目录解析；其余按工作区根解析（AI 输出与仓库文档的惯例）
      const base = /^\.\.?[\\/]/.test(target.path) ? 'document' : 'workspace'
      return `<code ${fileTargetAttrs(target, base, 'mention')}>${md.utils.escapeHtml(token.content)}</code>`
    }
  }
  return defaultCodeInlineRule(tokens, idx, options, env, self)
}

// 链接：显式导航语义，非协议地址的相对链接直接标记为文件（对齐 deepseek-harness）
const defaultLinkOpenRule =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (env?.fileLinks) {
    const href = token.attrGet('href')
    const target = typeof href === 'string' ? parseLinkTarget(safeDecodeURI(href)) : null
    if (target) {
      token.attrSet('data-md-file', target.path)
      token.attrSet('data-md-base', 'document')
      token.attrSet('data-md-file-kind', 'link')
      if (target.line !== undefined) {
        token.attrSet('data-md-line', String(target.line))
      }
      if (target.endLine !== undefined) {
        token.attrSet('data-md-end-line', String(target.endLine))
      }
      token.attrJoin('class', 'md-file-link')
    }
  }
  return defaultLinkOpenRule(tokens, idx, options, env, self)
}

/** 裸文本中的路径候选：限制为 ASCII 路径字符，避免把相邻中文粘进路径 */
const BARE_FILE_PATH_PATTERN = /[A-Za-z0-9_./\\:@#%~+-]+/g

/** 路径后紧贴的句子标点（中英文）：识别前裁掉，识别后原样输出 */
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、）】》”"']+$/

/**
 * 纯文本中的文件路径也标记为候选（如 AI 直接输出的 a/b/Foo.kt#L184）。
 * 只接管含路径分隔符的片段，其余文本照常转义输出；是否可点击由真实文件校验决定。
 */
function renderTextFileLinks(content: string): string {
  let result = ''
  let lastIndex = 0
  for (const match of content.matchAll(BARE_FILE_PATH_PATTERN)) {
    const raw = match[0]
    const start = match.index ?? 0
    const candidate = raw.replace(TRAILING_PUNCTUATION, '')
    const target = parseFileTarget(candidate)
    // 裸文本是弱信号：解析出的路径必须带分隔符，且带任意扩展名、显式前缀或已知无扩展名文件名
    if (target === null) {
      continue
    }
    const name = basename(target.path).toLowerCase()
    if (!looksLikeBareFilePath(target.path) && !FILE_BASENAMES.has(name)) {
      continue
    }
    if (!target.path.includes('/') && !target.path.includes('\\')) {
      continue
    }
    result += md.utils.escapeHtml(content.slice(lastIndex, start))
    result += `<span ${fileTargetAttrs(target, 'workspace', 'mention')}>${md.utils.escapeHtml(candidate)}</span>`
    result += md.utils.escapeHtml(raw.slice(candidate.length))
    lastIndex = start + raw.length
  }
  return result + md.utils.escapeHtml(content.slice(lastIndex))
}

// 纯文本：识别裸文件路径；链接文字（link 内）不处理，避免可点击元素嵌套
const defaultTextRule = md.renderer.rules.text

md.renderer.rules.text = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (!env?.fileLinks || isInsideLink(tokens, idx)) {
    return defaultTextRule(tokens, idx, options, env, self)
  }
  return renderTextFileLinks(token.content)
}

/** 渲染 Markdown 为 HTML；basePath 为源文件所在目录时，相对图片路径才能显示 */
export function renderMarkdown(
  content: string,
  basePath?: string,
  options: { fileLinks?: boolean } = {}
): string {
  return md.render(content, { basePath, fileLinks: options.fileLinks === true })
}
