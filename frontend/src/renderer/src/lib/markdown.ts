/** Markdown 渲染层：markdown-it 实例与预览用到的自定义渲染规则 */
import MarkdownIt from 'markdown-it'
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

// html: false 表示不解析内联 HTML：文件内容与 AI 输出都可能夹带任意标签，
// 禁用后所有 HTML 按文本转义，避免脚本注入渲染进程
const md = new MarkdownIt({ html: false, linkify: true })

// 代码块：语言标识转成 Monaco 语言 id，正文直接作为 pre 的文本节点。
// 预览侧用 monaco.editor.colorizeElement 着色，而该 API 只读取元素的第一个文本子节点，
// 因此不能再套一层 <code>；复制按钮只能放在 pre 的外层容器里，否则会被着色结果覆写
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const language = resolveMarkdownLanguage(token.info)
  const languageAttr = language ? ` data-lang="${md.utils.escapeHtml(language)}"` : ''
  return (
    '<div class="md-code-block">' +
    '<button type="button" class="md-code-copy" data-md-code-copy>复制</button>' +
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

/** 渲染 Markdown 为 HTML；basePath 为源文件所在目录时，相对图片路径才能显示 */
export function renderMarkdown(content: string, basePath?: string): string {
  return md.render(content, { basePath })
}
