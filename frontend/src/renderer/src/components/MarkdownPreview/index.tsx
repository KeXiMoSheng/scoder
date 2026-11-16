import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '../../lib/markdown'
import { monaco } from '../../lib/monaco'
import { getActiveThemeId } from '../../lib/theme'
import { isAbsolutePath, joinPath, normalizePath, pathSeparator } from '../../lib/filePath'
import { cn } from '../../lib/utils'
import type { MarkdownPreviewProps } from './types'

/** 已注册的语言 id：未注册的代码块保持纯文本，避免着色器产出空内容 */
const REGISTERED_LANGUAGE_IDS = new Set(monaco.languages.getLanguages().map((item) => item.id))

const COPY_IDLE_LABEL = '复制代码'
/** 复制结果反馈（图标）只停留一小段时间，之后恢复成复制图标 */
const COPY_FEEDBACK_DELAY = 1600

/** 按钮由 markdown-it 生成的 HTML 创建、不在 React 树内，只能命令式更新反馈状态 */
const copyTimers = new WeakMap<HTMLElement, number>()

/** 复制反馈不用文案避免干扰阅读：按钮切换成对勾图标，结果只写在 title / aria-label 上 */
function showCopyFeedback(button: HTMLElement, failed: boolean): void {
  const timer = copyTimers.get(button)
  if (timer !== undefined) {
    window.clearTimeout(timer)
  }
  const label = failed ? '复制失败' : '已复制'
  button.dataset.copied = failed ? 'error' : 'true'
  button.title = label
  button.setAttribute('aria-label', label)
  copyTimers.set(
    button,
    window.setTimeout(() => {
      copyTimers.delete(button)
      delete button.dataset.copied
      button.title = COPY_IDLE_LABEL
      button.setAttribute('aria-label', COPY_IDLE_LABEL)
    }, COPY_FEEDBACK_DELAY)
  )
}

/** 取代码块原文：着色后 pre 的 textContent 被逐行 <br/> 打断，优先读着色前缓存的 source */
function readCodeBlockSource(block: HTMLElement): string {
  const pre = block.querySelector('pre.md-code')
  if (!(pre instanceof HTMLElement)) {
    return ''
  }
  return pre.dataset.source ?? pre.textContent ?? ''
}

function copyCodeBlock(button: HTMLElement): void {
  const block = button.closest('.md-code-block')
  if (!(block instanceof HTMLElement)) {
    return
  }
  const source = readCodeBlockSource(block)
  if (source === '') {
    return
  }
  void navigator.clipboard.writeText(source).then(
    () => showCopyFeedback(button, false),
    () => showCopyFeedback(button, true)
  )
}

/** 收起/展开代码块：状态记在容器 dataset 上，显隐与箭头方向交给 CSS */
function toggleCodeBlock(button: HTMLElement): void {
  const block = button.closest('.md-code-block')
  if (!(block instanceof HTMLElement)) {
    return
  }
  const collapsed = block.dataset.collapsed === 'true'
  if (collapsed) {
    delete block.dataset.collapsed
  } else {
    block.dataset.collapsed = 'true'
  }
  button.setAttribute('aria-expanded', collapsed ? 'true' : 'false')
  button.title = collapsed ? '收起代码块' : '展开代码块'
}

/** 按基准目录补全相对路径并归一化 .. 段：分隔符风格跟随基准目录（Windows 下为反斜杠） */
function resolveAgainstBase(path: string, base: string | null | undefined): string {
  if (!base || isAbsolutePath(path)) {
    return normalizePath(path)
  }
  return normalizePath(joinPath(base, path.split(/[\\/]/).join(pathSeparator(base))))
}

/** 候选路径：primary 按标记来源基准解析，fallback 为另一基准（没有第二基准时与 primary 相同） */
interface FileTargetCandidates {
  primary: string
  fallback: string
}

/** 按元素上的 data 属性解析出两个候选绝对路径 */
function fileTargetCandidates(
  element: HTMLElement,
  basePath?: string,
  workspaceRoot?: string | null
): FileTargetCandidates {
  const raw = element.dataset.mdFile ?? ''
  const documentBase = basePath ?? workspaceRoot
  const workspaceBase = workspaceRoot ?? basePath
  const preferDocument = element.dataset.mdBase === 'document'
  return {
    primary: resolveAgainstBase(raw, preferDocument ? documentBase : workspaceBase),
    fallback: resolveAgainstBase(raw, preferDocument ? workspaceBase : documentBase)
  }
}

/** 优先首选路径，不存在时尝试另一基准；两者都不存在时保留首选路径由编辑器提示失败 */
async function statCandidates(
  primary: string,
  fallback: string
): Promise<{ ok: boolean; path: string }> {
  if (typeof window.api === 'undefined') {
    // 非 Electron 环境（测试）没有 statFile：不限制候选
    return { ok: true, path: primary }
  }
  const primaryStat = await window.api.statFile(primary).catch(() => null)
  if (primaryStat !== null) {
    return { ok: true, path: primary }
  }
  if (fallback !== primary) {
    const fallbackStat = await window.api.statFile(fallback).catch(() => null)
    if (fallbackStat !== null) {
      return { ok: true, path: fallback }
    }
  }
  return { ok: false, path: primary }
}

/**
 * 把 Markdown 中的文件目标解析成打开用的绝对路径。
 * 先按标记的来源基准解析（行内代码/裸文本 → 工作区根，链接 → 文档目录），
 * 文件不存在时再尝试另一个基准，两者都不存在时仍返回首选路径，由编辑器提示打开失败。
 */
async function resolveFileTarget(
  element: HTMLElement,
  basePath?: string,
  workspaceRoot?: string | null
): Promise<string> {
  const raw = element.dataset.mdFile ?? ''
  if (!raw) {
    return raw
  }
  const { primary, fallback } = fileTargetCandidates(element, basePath, workspaceRoot)
  return (await statCandidates(primary, fallback)).path
}

/** 真实文件校验结果缓存：流式重渲染与主题重建时避免重复 stat */
const FILE_TARGET_CACHE_TTL = 30_000
/** 每批并发校验的文件数：避免一条消息里的候选路径集中打满 IPC */
const FILE_TARGET_BATCH = 8

interface FileTargetCheck {
  ok: boolean
  path: string
  expiresAt: number
}

const fileTargetChecks = new Map<string, FileTargetCheck>()

/**
 * 校验 mention 候选是否对应真实文件（对应 deepseek-harness 由 owner 提供文件清单的思路：
 * 渲染器只标记“形态像路径”，真实存在性由文件系统判定）。
 */
async function checkFileTarget(
  element: HTMLElement,
  basePath?: string,
  workspaceRoot?: string | null
): Promise<FileTargetCheck> {
  const { primary, fallback } = fileTargetCandidates(element, basePath, workspaceRoot)
  const key = `${primary}\u0000${fallback}`
  const cached = fileTargetChecks.get(key)
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached
  }
  const result = await statCandidates(primary, fallback)
  const entry: FileTargetCheck = { ...result, expiresAt: Date.now() + FILE_TARGET_CACHE_TTL }
  fileTargetChecks.set(key, entry)
  return entry
}

/** 订阅应用主题 id：主题切换后需要重建预览 DOM 并按新主题重新着色 */
function useActiveThemeId(): string {
  const [themeId, setThemeId] = useState(getActiveThemeId)
  useEffect(() => {
    // lib/theme.ts 切换主题时写入 <html data-theme>，作为唯一的主题变更信号
    const observer = new MutationObserver(() => setThemeId(getActiveThemeId()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    return () => observer.disconnect()
  }, [])
  return themeId
}

/**
 * Markdown 预览：markdown-it 负责把源文本渲染为 HTML，
 * 代码块再交给 Monaco 着色（复用编辑器已注册的 tokenizer，配色与编辑器一致）。
 * 正文中的 Markdown 链接直接可点击；行内代码与裸文本路径先标记候选，
 * 再用宿主真实文件校验（statFile）通过后才显示为可点击。外部链接交给系统浏览器。
 */
export default function MarkdownPreview({
  content,
  basePath,
  workspaceRoot,
  onOpenFile,
  variant = 'document',
  className
}: MarkdownPreviewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const themeId = useActiveThemeId()
  // 只有提供了打开回调才把路径标记为可点击，避免无导航能力时出现误导性样式
  const fileLinks = onOpenFile !== undefined
  const html = useMemo(
    () => renderMarkdown(content, basePath, { fileLinks }),
    [content, basePath, fileLinks]
  )

  // 代码块着色：colorizeElement 会就地改写 pre 的 innerHTML，
  // 因此每次都先把原文还原（StrictMode 下 effect 会重跑），并清掉上一次追加的主题类名
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    for (const block of container.querySelectorAll<HTMLElement>('pre[data-lang]')) {
      const language = block.dataset.lang ?? ''
      if (!language || language === 'plaintext' || !REGISTERED_LANGUAGE_IDS.has(language)) {
        continue
      }
      const source = block.dataset.source ?? block.textContent ?? ''
      block.dataset.source = source
      block.className = 'md-code'
      block.textContent = source
      // theme 必须显式传入：colorizeElement 默认用 vs（浅色），并会把全局编辑器主题改成它
      void monaco.editor
        .colorizeElement(block, { theme: themeId, tabSize: 2 })
        .catch(() => undefined)
    }
  }, [html, themeId])

  // 行内代码/裸文本只是“形态像路径”的候选，用宿主真实文件校验后才显示为可点击；
  // Markdown 链接是显式导航语义，不做存在性限制。主题切换会重建 DOM，因此依赖 themeId。
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const mentions = Array.from(
      container.querySelectorAll<HTMLElement>('[data-md-file-kind="mention"]')
    )
    if (mentions.length === 0) {
      return
    }
    let cancelled = false
    void (async (): Promise<void> => {
      for (let start = 0; start < mentions.length; start += FILE_TARGET_BATCH) {
        const batch = mentions.slice(start, start + FILE_TARGET_BATCH)
        const checks = await Promise.all(
          batch.map((element) => checkFileTarget(element, basePath, workspaceRoot))
        )
        if (cancelled) {
          return
        }
        checks.forEach((check, index) => {
          const element = batch[index]
          element.dataset.mdFileState = check.ok ? 'ok' : 'missing'
          if (!check.ok) {
            // 不存在的候选保持普通文本外观（没有可点击提示），也不再进入 Tab 序列
            element.removeAttribute('role')
            element.removeAttribute('tabindex')
            element.removeAttribute('title')
          }
        })
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [html, themeId, basePath, workspaceRoot])

  /** 打开正文中被标记的文件路径：行号（含范围）从 data 属性读取，缺省时只打开文件 */
  const openFileTarget = (element: HTMLElement): void => {
    // missing 候选已确认不是工作区文件，点击不再触发打开
    if (!onOpenFile || element.dataset.mdFileState === 'missing') {
      return
    }
    const parsedLine = Number.parseInt(element.dataset.mdLine ?? '', 10)
    const line = Number.isInteger(parsedLine) && parsedLine > 0 ? parsedLine : undefined
    const parsedEnd = Number.parseInt(element.dataset.mdEndLine ?? '', 10)
    const endLine =
      line !== undefined && Number.isInteger(parsedEnd) && parsedEnd > line ? parsedEnd : undefined
    void resolveFileTarget(element, basePath, workspaceRoot).then((path) => {
      if (path) {
        onOpenFile(path, line, endLine)
      }
    })
  }

  /** 点击：代码块工具条优先（展开/收起、复制）；文件路径打开编辑器；其余锚点阻止渲染进程内跳转 */
  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const toggleButton = target.closest('[data-md-code-toggle]')
    if (toggleButton instanceof HTMLElement) {
      event.preventDefault()
      toggleCodeBlock(toggleButton)
      return
    }
    const copyButton = target.closest('[data-md-code-copy]')
    if (copyButton instanceof HTMLElement) {
      event.preventDefault()
      copyCodeBlock(copyButton)
      return
    }
    const fileLink = target.closest<HTMLElement>('[data-md-file]')
    if (fileLink) {
      event.preventDefault()
      openFileTarget(fileLink)
      return
    }
    const anchor = target.closest('a')
    if (!anchor) {
      return
    }
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) {
      // 主进程的 setWindowOpenHandler 会把新窗口请求转成 shell.openExternal
      window.open(href)
    }
  }

  /** 键盘：行内代码不是原生可激活元素，补上 Enter / 空格；链接的 Enter 走原生 click */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }
    const target = event.target as HTMLElement
    const fileLink = target.closest<HTMLElement>('[data-md-file]')
    if (!fileLink || fileLink.tagName === 'A') {
      return
    }
    event.preventDefault()
    openFileTarget(fileLink)
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'markdown-body overflow-auto bg-base',
        variant === 'message' ? 'px-3 py-2' : 'px-8 py-6',
        className
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {/* key 随主题变化重建 DOM：着色结果依赖当前主题的 token 配色 */}
      <div
        key={themeId}
        className={cn(
          'markdown-content',
          variant === 'message' ? 'text-[13px]' : 'mx-auto max-w-[880px]'
        )}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
// AI 输出接入方式：<MarkdownPreview content={assistantText} variant="message" />
