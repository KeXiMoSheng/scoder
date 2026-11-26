/**
 * 浏览器页签：既服务于 AI 的页面操作，也提供标题栏「打开浏览器」的手动页签。
 * 每个页签一个 WebContentsView，嵌在主窗口的编辑器页签里。
 *
 * 为什么用 WebContentsView，而不是隐藏的 BrowserWindow 或 iframe：
 * - 编辑器里的页签显示的就是 AI 正在操作的真实页面，点击、滚动、输入都是原生行为；
 * - 主进程仍然可以直接在同一个 webContents 上执行快照脚本、点击/输入与截图，
 *   不需要再维护第二份页面实例或截图镜像；
 * - 页面运行在独立的内存分区里，禁用 Node、沙箱隔离，权限与下载策略与原来的隐藏窗口一致。
 *
 * 生命周期与会话绑定：同一会话跨轮次复用同一个页面（保留页面与登录状态）；
 * 手动页签固定一个页面，重复点击标题栏按钮只切回它。会话删除、主窗口关闭或应用退出时统一销毁。
 * 渲染进程只负责把页签内容区的位置上报给主进程（setBounds），由主进程把原生页面摆到编辑器页签上；
 * 切到文件页签、打开菜单/对话框时只隐藏原生页面，不销毁它。
 */
import { createHash } from 'node:crypto'
import type { BrowserWindow, Session, WebContents } from 'electron'
import { shell, WebContentsView } from 'electron'
import type { BrowserBounds, BrowserEvent, BrowserTabState } from '../../shared/browser/types'

/** 默认视口：够看清常见前端布局，缩成截图后仍在模型的长边上限内 */
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800
/** 视口范围：太小看不清，太大既浪费显存也让截图被强制缩小 */
const MIN_WIDTH = 320
const MAX_WIDTH = 3840
const MIN_HEIGHT = 240
const MAX_HEIGHT = 2160
/** 打开页面的等待上限：本地 dev server 通常秒开，慢构建留出余量 */
const LOAD_TIMEOUT_MS = 30_000
/** 点击/输入之后给页面一点异步更新的时间，再决定要不要等导航结束 */
const ACTION_SETTLE_MS = 250
/** 动作后等待导航结束的上限：超时不报错，页面可能本来就没有导航 */
const SETTLE_LOAD_TIMEOUT_MS = 15_000
/** 截图前等页面把最近一次 DOM 变化画进合成器 */
const SCREENSHOT_SETTLE_MS = 80
/** 隐藏页签截图时临时显示在窗口外，等一帧合成后再截图 */
const SCREENSHOT_PAINT_MS = 150
/** 截图命令的上限：窗口最小化等环境下合成器可能一直不出帧，不能让工具调用挂死 */
const SCREENSHOT_TIMEOUT_MS = 8_000
/** 快照里可见文字与可交互元素的保留上限：别让整页内容挤掉其它工具的结果 */
const MAX_SNAPSHOT_TEXT = 6_000
const MAX_SNAPSHOT_ELEMENTS = 80
/** 单个元素文本的保留上限 */
const MAX_ELEMENT_TEXT = 120
/**
 * 手动浏览页签的会话 id：标题栏「打开浏览器」用的固定页签。
 * 与 AI 会话 id 分开，手动浏览不复用 AI 页面的登录状态与历史，反之亦然。
 */
const MANUAL_BROWSER_SESSION_ID = 'manual-browser'

/** 页面的基本状态（工具结果与截图说明共用） */
export interface BrowserPageState {
  url: string
  title: string
  /** 视口宽高（CSS 像素），与截图的实际位图像素可能不同（高分屏） */
  width: number
  height: number
}

/** 快照里的一个可交互元素：ref 只在当次快照之后有效 */
export interface BrowserElement {
  ref: string
  tag: string
  role?: string
  text?: string
  /** 额外属性，如 type=email、href=/login */
  detail?: string
  disabled?: boolean
}

/** 页面快照：标题、可见文字与可交互元素 */
export interface BrowserSnapshot extends BrowserPageState {
  text: string
  elements: BrowserElement[]
  /** 实际命中的可交互元素总数（超出上限时大于 elements.length） */
  totalElements: number
}

/** 一次截图：PNG 字节与页面状态 */
export interface BrowserScreenshot extends BrowserPageState {
  data: Uint8Array
}

/** 打开页面的参数 */
export interface BrowserOpenOptions {
  url: string
  width?: number
  height?: number
  signal?: AbortSignal
}

/** 点击/输入脚本的返回值 */
interface ActionPayload {
  ok: boolean
  error?: 'missing' | 'disabled' | 'not-editable' | 'failed'
  tag?: string
  text?: string
}

/** 一个会话的浏览器页面：视图 + 布局状态 */
interface BrowserEntry {
  sessionId: string
  view: WebContentsView
  /** 当前是否显示在页签里；隐藏时页面仍可被工具操作 */
  visible: boolean
}

/**
 * 给所有可交互元素打上 data-scoder-ref，并顺便抓页面可见文字。
 * 用属性而不是 WeakMap：脚本每次执行都是全新上下文，属性才能跨调用找到同一个元素。
 * 注意脚本里不能出现反引号或 ${}，它是一段原样交给 Chromium 的字符串。
 */
const SNAPSHOT_SCRIPT = `(() => {
  const selector = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="textbox"]',
    '[role="checkbox"]',
    '[role="tab"]',
    '[contenteditable="true"]',
    '[onclick]'
  ].join(',')
  const visible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
  }
  // 先清掉上一轮引用：元素可能已隐藏或换了位置，旧引用不能继续命中
  for (const stale of document.querySelectorAll('[data-scoder-ref]')) {
    stale.removeAttribute('data-scoder-ref')
  }
  const textOf = (el) => {
    const raw = el.innerText || el.value || el.getAttribute('aria-label') ||
      el.getAttribute('title') || el.getAttribute('placeholder') || ''
    return String(raw).replace(/\\s+/g, ' ').trim().slice(0, ${MAX_ELEMENT_TEXT})
  }
  const elements = []
  let total = 0
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el)) continue
    total += 1
    if (elements.length >= ${MAX_SNAPSHOT_ELEMENTS}) continue
    const ref = 'e' + total
    el.setAttribute('data-scoder-ref', ref)
    const tag = el.tagName.toLowerCase()
    const item = { ref, tag }
    const role = el.getAttribute('role')
    if (role) item.role = role
    const text = textOf(el)
    if (text) item.text = text
    const detail = []
    if (tag === 'input') {
      detail.push('type=' + (el.type || 'text'))
      if (el.name) detail.push('name=' + el.name)
      if (el.checked) detail.push('checked')
    }
    if (tag === 'a' && el.href) detail.push('href=' + el.href)
    if (el.getAttribute('placeholder')) detail.push('placeholder=' + el.getAttribute('placeholder'))
    if (detail.length > 0) item.detail = detail.join(' ')
    if (el.disabled === true) item.disabled = true
    elements.push(item)
  }
  const body = document.body ? document.body.innerText : ''
  const text = String(body)
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim()
    .slice(0, ${MAX_SNAPSHOT_TEXT})
  return {
    title: document.title || '',
    url: location.href,
    text,
    elements,
    totalElements: total
  }
})()`

/** 点击脚本：ref 由 JSON.stringify 拼进来，避免模型输入改变脚本结构 */
function clickScript(ref: string): string {
  return `(() => {
    const el = document.querySelector('[data-scoder-ref="' + ${JSON.stringify(ref)} + '"]')
    if (!el) return { ok: false, error: 'missing' }
    if (el.disabled === true) return { ok: false, error: 'disabled' }
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
      if (el instanceof HTMLElement) el.focus()
      el.click()
    } catch (error) {
      return { ok: false, error: 'failed', text: String(error) }
    }
    const raw = el.innerText || el.value || el.getAttribute('aria-label') || ''
    const text = String(raw).replace(/\\s+/g, ' ').trim().slice(0, ${MAX_ELEMENT_TEXT})
    return { ok: true, tag: el.tagName.toLowerCase(), text }
  })()`
}

/**
 * 输入脚本：用原型上的 value setter 写入，再派发 input/change，
 * 这样 React 这类受控组件也能收到与真实输入一致的事件。
 */
function typeScript(ref: string, value: string, submit: boolean): string {
  return `(() => {
    const el = document.querySelector('[data-scoder-ref="' + ${JSON.stringify(ref)} + '"]')
    if (!el) return { ok: false, error: 'missing' }
    if (el.disabled === true || el.readOnly === true) return { ok: false, error: 'disabled' }
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
      if (el instanceof HTMLElement) el.focus()
      const tag = el.tagName.toLowerCase()
      if (tag === 'input') {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(el, ${JSON.stringify(value)})
      } else if (tag === 'textarea') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(el, ${JSON.stringify(value)})
      } else if (el.isContentEditable) {
        el.textContent = ${JSON.stringify(value)}
      } else {
        return { ok: false, error: 'not-editable' }
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      if (${submit ? 'true' : 'false'}) {
        if (el.form) {
          el.form.requestSubmit()
        } else {
          el.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true
          }))
        }
      }
      return { ok: true, tag }
    } catch (error) {
      return { ok: false, error: 'failed', text: String(error) }
    }
  })()`
}

/** 把模型给的地址补全成 URL；只接受 http/https，避免打开 file: 之类的本地协议 */
export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new Error('url 不能为空')
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`URL 无效：${input}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只支持 http/https 地址：${input}`)
  }
  return url.toString()
}

/** 是否允许导航到该地址（页面里的链接同样受此限制） */
function isAllowedNavigation(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** 可中止的等待：用户点停止后不用等满超时 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('用户中止了这一轮对话'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('用户中止了这一轮对话'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 从 unknown 里安全取对象 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 把 unknown 数组整理成快照元素；字段不全的条目直接跳过 */
function toElements(raw: unknown): BrowserElement[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const elements: BrowserElement[] = []
  for (const item of raw) {
    const record = asRecord(item)
    if (record === undefined) continue
    const ref = typeof record.ref === 'string' ? record.ref : ''
    const tag = typeof record.tag === 'string' ? record.tag : ''
    if (ref.length === 0 || tag.length === 0) continue
    elements.push({
      ref,
      tag,
      ...(typeof record.role === 'string' ? { role: record.role } : {}),
      ...(typeof record.text === 'string' ? { text: record.text } : {}),
      ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
      ...(record.disabled === true ? { disabled: true } : {})
    })
  }
  return elements
}

/** 会话 id → 稳定的内存分区名：同一会话保留 cookie，不同会话互相隔离 */
function partitionOf(sessionId: string): string {
  const digest = createHash('sha1').update(sessionId).digest('hex').slice(0, 16)
  return `scoder-browser-${digest}`
}

/**
 * 浏览器页面管理器。
 * 一个会话一个 WebContentsView：工具串行执行，但不同会话可能同时操作各自的页面。
 */
export class BrowserManager {
  private readonly entries = new Map<string, BrowserEntry>()
  /** 已配置过权限/下载策略的分区：窗口重开时不能重复挂监听取 */
  private readonly preparedPartitions = new Set<string>()
  /** 承载页签的主窗口；没有窗口时（例如单元测试）由调用方先 attachWindow */
  private host: BrowserWindow | null = null
  /** 页签事件出口：由主进程绑定到主窗口的 webContents */
  private notifier: ((event: BrowserEvent) => void) | null = null

  /** 绑定/切换承载页签的主窗口；切换窗口时销毁旧页面，避免视图挂在已销毁的窗口上 */
  attachWindow(window: BrowserWindow | null): void {
    if (this.host !== window) {
      this.disposeAll()
    }
    this.host = window
  }

  /** 注册页签事件出口；主窗口关闭时传 null 断开，避免向已销毁的 webContents 发送 */
  setNotifier(notifier: ((event: BrowserEvent) => void) | null): void {
    this.notifier = notifier
  }

  /** 会话是否已有浏览器页面（供提示词或 UI 查询） */
  has(sessionId: string): boolean {
    const entry = this.entries.get(sessionId)
    return entry !== undefined && !entry.view.webContents.isDestroyed()
  }

  /** 列出当前打开的页签：渲染进程重载后据此恢复页签列表 */
  list(): BrowserTabState[] {
    return [...this.entries.values()]
      .filter((entry) => !entry.view.webContents.isDestroyed())
      .map((entry) => this.tabState(entry))
  }

  /**
   * 打开（或切回）手动浏览页签，返回它的会话 id。
   * 与 AI 页面共用同一套视图管理，但不预载地址：地址栏留空，由用户自己输入。
   * 页签已经存在时只推送 open 让界面切回来，不重建页面，保留历史与登录状态。
   */
  openManual(): string {
    const entry = this.ensureEntry(MANUAL_BROWSER_SESSION_ID)
    // 与 browser_open 一致：先让界面把页签建出来（或激活已有的）再继续
    this.notify({ type: 'open', tab: this.tabState(entry) })
    return MANUAL_BROWSER_SESSION_ID
  }

  /**
   * 打开（或复用）会话的浏览器页面并导航到目标地址。
   * @param sessionId 当前 AI 会话 id
   * @param options 地址与可选视口（页签已经可见时以页签实际尺寸为准）
   * @returns 加载完成后的页面状态
   */
  async open(sessionId: string, options: BrowserOpenOptions): Promise<BrowserPageState> {
    const entry = this.ensureEntry(sessionId)
    if (options.width !== undefined || options.height !== undefined) {
      // 页签可见时页面大小由编辑器布局决定；只在尚未显示时把工具给的尺寸当作初始视口
      if (!entry.visible) {
        const current = entry.view.getBounds()
        const width = clampDimension(options.width, current.width, MIN_WIDTH, MAX_WIDTH)
        const height = clampDimension(options.height, current.height, MIN_HEIGHT, MAX_HEIGHT)
        if (width !== current.width || height !== current.height) {
          entry.view.setBounds({ ...current, width, height })
        }
      }
    }
    const url = normalizeBrowserUrl(options.url)
    // 先让界面把页签建出来并激活，再等待页面加载：用户能立刻看到浏览器页签
    this.notify({ type: 'open', tab: this.tabState(entry) })
    await this.load(entry.view.webContents, url, options.signal)
    this.notifyState(entry)
    return this.state(entry)
  }

  /** 读取当前页面的标题、可见文字与可交互元素 */
  async snapshot(sessionId: string): Promise<BrowserSnapshot> {
    const entry = this.requireEntry(sessionId)
    const raw = asRecord(await entry.view.webContents.executeJavaScript(SNAPSHOT_SCRIPT))
    if (raw === undefined) {
      throw new Error('页面快照失败：脚本没有返回对象')
    }
    const state = this.state(entry)
    return {
      ...state,
      title: typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : state.title,
      url: typeof raw.url === 'string' && raw.url.length > 0 ? raw.url : state.url,
      text: typeof raw.text === 'string' ? raw.text.slice(0, MAX_SNAPSHOT_TEXT) : '',
      elements: toElements(raw.elements),
      totalElements:
        typeof raw.totalElements === 'number' && raw.totalElements >= 0 ? raw.totalElements : 0
    }
  }

  /**
   * 点击一个快照引用。
   * @returns 被点击元素的描述（标签与可见文字）
   */
  async click(
    sessionId: string,
    ref: string,
    signal?: AbortSignal
  ): Promise<BrowserPageState & { target: string }> {
    const entry = this.requireEntry(sessionId)
    const payload = await this.action(entry.view.webContents, clickScript(ref), ref)
    await this.settle(entry.view.webContents, signal)
    const state = this.state(entry)
    this.notifyState(entry)
    return {
      ...state,
      target:
        payload.text !== undefined && payload.text.length > 0
          ? `${payload.tag ?? '元素'} "${payload.text}"`
          : (payload.tag ?? '元素')
    }
  }

  /** 向一个快照引用输入文本；submit 为 true 时提交所在表单或按回车 */
  async type(
    sessionId: string,
    ref: string,
    text: string,
    submit: boolean,
    signal?: AbortSignal
  ): Promise<BrowserPageState> {
    const entry = this.requireEntry(sessionId)
    await this.action(entry.view.webContents, typeScript(ref, text, submit), ref)
    await this.settle(entry.view.webContents, signal)
    const state = this.state(entry)
    this.notifyState(entry)
    return state
  }

  /** 截取当前视口；返回 PNG 字节与页面状态 */
  async screenshot(sessionId: string, signal?: AbortSignal): Promise<BrowserScreenshot> {
    const entry = this.requireEntry(sessionId)
    await delay(SCREENSHOT_SETTLE_MS, signal)
    signal?.throwIfAborted()
    const data = await this.captureEntry(entry)
    return { ...this.state(entry), data }
  }

  /**
   * 渲染进程上报页签内容区的位置并控制原生页面显示。
   * 会话已关闭（关闭动画/竞态）时静默忽略，不向渲染进程抛错。
   */
  setBounds(sessionId: string, bounds: BrowserBounds, visible: boolean): void {
    const entry = this.entries.get(sessionId)
    const host = this.host
    if (
      entry === undefined ||
      entry.view.webContents.isDestroyed() ||
      host === null ||
      host.isDestroyed()
    ) {
      return
    }
    if (
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height)
    ) {
      return
    }
    const width = Math.round(bounds.width)
    const height = Math.round(bounds.height)
    if (width < 1 || height < 1) {
      entry.visible = false
      entry.view.setVisible(false)
      return
    }
    const [contentWidth, contentHeight] = host.getContentSize()
    const x = clamp(Math.round(bounds.x), 0, Math.max(0, contentWidth - 1))
    const y = clamp(Math.round(bounds.y), 0, Math.max(0, contentHeight - 1))
    const fittedWidth = Math.min(width, contentWidth - x)
    const fittedHeight = Math.min(height, contentHeight - y)
    if (fittedWidth < 1 || fittedHeight < 1) {
      entry.visible = false
      entry.view.setVisible(false)
      return
    }
    entry.view.setBounds({ x, y, width: fittedWidth, height: fittedHeight })
    entry.view.setVisible(visible)
    entry.visible = visible
  }

  /**
   * 地址栏回车：在现有页面里导航到新地址。
   * 归一化（补 http://）与协议校验与 browser_open 一致；页签已关闭时静默忽略。
   */
  async navigate(sessionId: string, url: string): Promise<void> {
    const entry = this.entries.get(sessionId)
    if (entry === undefined || entry.view.webContents.isDestroyed()) {
      return
    }
    await this.load(entry.view.webContents, normalizeBrowserUrl(url))
    this.notifyState(entry)
  }

  /** 刷新当前页面；页签已关闭时静默忽略（工具栏点击与关闭存在竞态） */
  reload(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry === undefined || entry.view.webContents.isDestroyed()) {
      return
    }
    entry.view.webContents.reload()
  }

  /** 后退/前进：没有历史时静默忽略（工具栏按钮也会按 canGoBack/canGoForward 置灰） */
  goBack(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry === undefined || entry.view.webContents.isDestroyed()) {
      return
    }
    const history = entry.view.webContents.navigationHistory
    if (history.canGoBack()) {
      history.goBack()
    }
  }

  goForward(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry === undefined || entry.view.webContents.isDestroyed()) {
      return
    }
    const history = entry.view.webContents.navigationHistory
    if (history.canGoForward()) {
      history.goForward()
    }
  }

  /** 用系统浏览器打开当前页面；只放行 http/https */
  openExternal(sessionId: string): Promise<void> {
    const entry = this.requireEntry(sessionId)
    const url = this.state(entry).url
    if (!isAllowedNavigation(url)) {
      throw new Error('当前页面还没有可打开的地址')
    }
    return shell.openExternal(url)
  }

  /** 隐藏全部页面但保留加载状态：渲染进程重载时避免原生页面继续盖住新界面 */
  hideAll(): void {
    for (const entry of this.entries.values()) {
      if (!entry.view.webContents.isDestroyed()) {
        entry.view.setVisible(false)
        entry.visible = false
      }
    }
  }

  /** 关闭会话的浏览器页面；没有页面时返回 false */
  close(sessionId: string): boolean {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) {
      return false
    }
    this.entries.delete(sessionId)
    const host = this.host
    if (host !== null && !host.isDestroyed()) {
      host.contentView.removeChildView(entry.view)
    }
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close({ waitForBeforeUnload: false })
    }
    this.notify({ type: 'closed', sessionId })
    return true
  }

  /** 应用退出或主窗口关闭时销毁全部浏览器页面 */
  disposeAll(): void {
    for (const sessionId of [...this.entries.keys()]) {
      this.close(sessionId)
    }
    this.host = null
  }

  /** 取页面；不存在时给出可执行的下一步提示 */
  private requireEntry(sessionId: string): BrowserEntry {
    const entry = this.entries.get(sessionId)
    if (entry === undefined || entry.view.webContents.isDestroyed()) {
      throw new Error('当前会话还没有打开浏览器页面；先调用 browser_open')
    }
    return entry
  }

  /** 主窗口只有在 createWindow 之后才可承载 WebContentsView */
  private requireHost(): BrowserWindow {
    if (this.host === null || this.host.isDestroyed()) {
      throw new Error('浏览器宿主窗口尚未就绪，请等主窗口创建后再打开页面')
    }
    return this.host
  }

  /**
   * 创建页面：隐藏、独立内存分区、禁用 Node 与弹窗。
   * 同一会话重复调用时复用已经打开的页面。
   */
  private ensureEntry(sessionId: string): BrowserEntry {
    const existing = this.entries.get(sessionId)
    if (existing !== undefined && !existing.view.webContents.isDestroyed()) {
      return existing
    }
    if (existing !== undefined) {
      this.entries.delete(sessionId)
    }
    const host = this.requireHost()
    const partition = partitionOf(sessionId)
    const view = new WebContentsView({
      webPreferences: {
        // 页面是不可信的远端内容：不给 Node，开沙箱，隔离上下文
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // 隐藏的页签也要持续绘制，否则截图与快照可能停在旧画面
        backgroundThrottling: false,
        partition
      }
    })
    view.setBackgroundColor('#ffffff')
    // 初始尺寸：页签还没上报布局时也能正常加载与截图；真正显示后由 setBounds 覆盖
    view.setBounds({ x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
    view.setVisible(false)
    host.contentView.addChildView(view)
    const entry: BrowserEntry = { sessionId, view, visible: false }
    this.entries.set(sessionId, entry)
    this.preparePartition(view.webContents.session, partition)
    const webContents = view.webContents
    // 页面里的链接只允许继续在 http/https 内跳转；其它协议直接拦下
    webContents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url)) {
        event.preventDefault()
      }
    })
    // target=_blank 不开新窗口：在当前页面继续导航，AI 才有唯一的操作对象
    webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedNavigation(url)) {
        void view.webContents.loadURL(url).catch(() => undefined)
      }
      return { action: 'deny' }
    })
    // 地址/标题/加载状态变化时同步页签；页签上的刷新图标与前进后退按钮依赖这些状态
    const update = (): void => {
      this.notifyState(entry)
    }
    webContents.on('did-navigate', update)
    webContents.on('did-navigate-in-page', update)
    webContents.on('page-title-updated', update)
    webContents.on('did-start-loading', update)
    webContents.on('did-stop-loading', update)
    // 页面崩溃或被强制销毁：把页签一并收掉，避免界面留下无法操作的空白页
    webContents.on('destroyed', () => {
      if (this.entries.get(sessionId) === entry) {
        this.entries.delete(sessionId)
        this.notify({ type: 'closed', sessionId })
      }
    })
    return entry
  }

  /** 分区级策略：拒绝摄像头/定位等权限请求，阻止页面触发下载 */
  private preparePartition(session: Session, partition: string): void {
    if (this.preparedPartitions.has(partition)) {
      return
    }
    this.preparedPartitions.add(partition)
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.on('will-download', (event) => event.preventDefault())
  }

  /** 导航并等待加载完成；超时、加载失败与用户中止都会抛出 */
  private load(webContents: WebContents, url: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      // 放在对象里：finish 可能先于 setTimeout 的赋值被调用（例如信号已中止）
      const handle: { timer?: ReturnType<typeof setTimeout> } = {}
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        if (handle.timer !== undefined) clearTimeout(handle.timer)
        webContents.removeListener('did-finish-load', onFinish)
        webContents.removeListener('did-fail-load', onFail)
        signal?.removeEventListener('abort', onAbort)
        if (error === undefined) {
          resolve()
        } else {
          reject(error)
        }
      }
      handle.timer = setTimeout(() => {
        finish(new Error(`页面在 ${LOAD_TIMEOUT_MS / 1000} 秒内没有加载完成：${url}`))
      }, LOAD_TIMEOUT_MS)
      const onFinish = (): void => finish()
      const onFail = (
        _event: Electron.Event,
        code: number,
        description: string,
        _validatedUrl: string,
        isMainFrame: boolean
      ): void => {
        if (!isMainFrame) return
        // ERR_ABORTED：页面脚本或重定向取消了这次加载，后续导航会自己收尾
        if (code === -3) return
        finish(new Error(`页面加载失败：${description || '未知错误'}（${code}）`))
      }
      const onAbort = (): void => finish(new Error('用户中止了这一轮对话'))
      webContents.once('did-finish-load', onFinish)
      webContents.on('did-fail-load', onFail)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        finish(new Error('用户中止了这一轮对话'))
        return
      }
      void webContents.loadURL(url).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        // 重定向时 loadURL 常以 ERR_ABORTED 收尾，真正的结果交给 did-finish-load
        if (message.includes('ERR_ABORTED')) {
          return
        }
        finish(error instanceof Error ? error : new Error(message))
      })
    })
  }

  /** 点击/输入后等页面稳定：先给异步更新一点时间，发生导航时再等加载结束 */
  private async settle(webContents: WebContents, signal?: AbortSignal): Promise<void> {
    await delay(ACTION_SETTLE_MS, signal)
    if (!webContents.isLoading()) {
      return
    }
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        webContents.removeListener('did-stop-loading', finish)
        resolve()
      }
      const timer = setTimeout(finish, SETTLE_LOAD_TIMEOUT_MS)
      webContents.once('did-stop-loading', finish)
    })
  }

  /** 执行一个动作脚本并把失败翻译成可读错误 */
  private async action(
    webContents: WebContents,
    script: string,
    ref: string
  ): Promise<ActionPayload> {
    const payload = asRecord(await webContents.executeJavaScript(script))
    if (payload === undefined || payload.ok !== true) {
      const reason = typeof payload?.error === 'string' ? payload.error : 'failed'
      if (reason === 'missing') {
        throw new Error(
          `元素引用 ${ref} 不存在或已失效：页面可能在快照之后重新渲染了，先重新调用 browser_snapshot`
        )
      }
      if (reason === 'disabled') {
        throw new Error(`元素 ${ref} 当前不可操作（禁用或只读）`)
      }
      if (reason === 'not-editable') {
        throw new Error(`元素 ${ref} 不是可输入的元素（input/textarea/contenteditable）`)
      }
      const detail = typeof payload?.text === 'string' ? `：${payload.text}` : ''
      throw new Error(`操作元素 ${ref} 失败${detail}`)
    }
    return {
      ok: true,
      ...(typeof payload.tag === 'string' ? { tag: payload.tag } : {}),
      ...(typeof payload.text === 'string' ? { text: payload.text } : {})
    }
  }

  /**
   * 截取一个页面的视口。
   * 页签正在显示时直接截；切到了文件页签、或菜单/对话框把页面隐藏时，
   * 先把原生视图临时挪到窗口右侧之外并设为可见，等一帧后再截，截完恢复原位原状态。
   * 这样截图不会在编辑器上闪一下，也不依赖隐藏视图的合成器行为。
   */
  private async captureEntry(entry: BrowserEntry): Promise<Uint8Array> {
    if (entry.visible) {
      return this.capturePng(entry.view.webContents)
    }
    const host = this.requireHost()
    const [contentWidth] = host.getContentSize()
    const previous = entry.view.getBounds()
    entry.view.setBounds({ x: contentWidth, y: 0, width: previous.width, height: previous.height })
    entry.view.setVisible(true)
    try {
      await delay(SCREENSHOT_PAINT_MS)
      return await this.capturePng(entry.view.webContents)
    } finally {
      // 截图期间页签可能被重新激活（布局上报把 visible 改回 true）：
      // 这时不能再把视图隐藏或恢复成旧尺寸，否则会盖掉刚显示出来的页面
      if (!entry.visible && !entry.view.webContents.isDestroyed()) {
        entry.view.setVisible(false)
        entry.view.setBounds(previous)
      }
    }
  }

  /**
   * 用 CDP 截取视口 PNG。
   * 页签隐藏时 chrome 不提供 capturePage 的画面，但 Page.captureScreenshot 在视图可见时
   * 会强制走一次合成；captureEntry 已经负责把隐藏页面临时摆到窗口外。
   * 调用方偶尔已经 attach 调试器时不重复 attach。
   */
  private async capturePng(webContents: WebContents): Promise<Uint8Array> {
    const target = webContents.debugger
    const attachedHere = !target.isAttached()
    if (attachedHere) {
      target.attach('1.3')
    }
    try {
      const result = (await withTimeout(
        target.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false
        }),
        SCREENSHOT_TIMEOUT_MS,
        '截图超时：浏览器窗口可能已最小化或当前环境无法合成页面'
      )) as { data?: unknown }
      if (typeof result?.data !== 'string' || result.data.length === 0) {
        throw new Error('截图失败：页面没有返回图像数据')
      }
      return new Uint8Array(Buffer.from(result.data, 'base64'))
    } finally {
      if (attachedHere && target.isAttached()) {
        target.detach()
      }
    }
  }

  /** 读取页面状态；标题取不到时用空串兜底 */
  private state(entry: BrowserEntry): BrowserPageState {
    const bounds = entry.view.getBounds()
    return {
      url: entry.view.webContents.getURL(),
      title: entry.view.webContents.getTitle(),
      width: bounds.width,
      height: bounds.height
    }
  }

  /** 页签状态：页面状态 + 加载/历史能力 */
  private tabState(entry: BrowserEntry): BrowserTabState {
    const state = this.state(entry)
    const webContents = entry.view.webContents
    return {
      sessionId: entry.sessionId,
      ...state,
      loading: webContents.isLoading(),
      canGoBack: webContents.navigationHistory.canGoBack(),
      canGoForward: webContents.navigationHistory.canGoForward()
    }
  }

  /** 推送页面状态；页面已销毁时忽略，避免异常从事件监听器冒出去 */
  private notifyState(entry: BrowserEntry): void {
    if (entry.view.webContents.isDestroyed()) {
      return
    }
    this.notify({ type: 'state', tab: this.tabState(entry) })
  }

  private notify(event: BrowserEvent): void {
    try {
      this.notifier?.(event)
    } catch (error) {
      console.warn('浏览器页签事件推送失败', error)
    }
  }
}

/** 给一个 Promise 加超时：用于 CDP 截图这类可能因环境不出帧而永不返回的调用 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

/** 视口尺寸：非整数或越界时退回当前值/边界 */
function clampDimension(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || !Number.isInteger(value) || value < min) {
    return fallback
  }
  return Math.min(value, max)
}

/** 限幅到 [min, max] */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 进程内唯一的浏览器管理器：AI 工具与会话生命周期共用 */
export const browserManager = new BrowserManager()
