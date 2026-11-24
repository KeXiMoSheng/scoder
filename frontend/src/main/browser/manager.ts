/**
 * AI 浏览器：每个会话一个隐藏的 Chromium 窗口。
 *
 * 为什么用 Electron 自带的 BrowserWindow，而不是再装一套 Playwright：
 * - 应用里已经有一份 Chromium，再下一个浏览器既大又慢；
 * - 工具只需要「打开页面、看结构、点一下、截个图」这几件事，Electron 的
 *   webContents 已经全部提供，不需要额外进程与 CDP 端口。
 *
 * 生命周期与会话绑定：同一会话跨轮次复用同一个窗口（保留页面与登录状态），
 * 会话删除、主窗口关闭或应用退出时统一销毁。窗口刻意不显示（对应
 * deepseek-harness 浏览器提供方的 headless 默认值），用户看到的是工具卡片里的截图。
 */
import { createHash } from 'node:crypto'
import type { Session } from 'electron'
import { BrowserWindow } from 'electron'

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
/** 快照里可见文字与可交互元素的保留上限：别让整页内容挤掉其它工具的结果 */
const MAX_SNAPSHOT_TEXT = 6_000
const MAX_SNAPSHOT_ELEMENTS = 80
/** 单个元素文本的保留上限 */
const MAX_ELEMENT_TEXT = 120

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
 * 浏览器窗口管理器。
 * 一个会话一个窗口：工具串行执行，但不同会话可能同时操作各自的页面。
 */
export class BrowserManager {
  private readonly windows = new Map<string, BrowserWindow>()
  /** 已配置过权限/下载策略的分区：窗口重开时不能重复挂监听取 */
  private readonly preparedPartitions = new Set<string>()

  /** 会话是否已有浏览器窗口（供提示词或 UI 查询） */
  has(sessionId: string): boolean {
    const window = this.windows.get(sessionId)
    return window !== undefined && !window.isDestroyed()
  }

  /**
   * 打开（或复用）会话的浏览器窗口并导航到目标地址。
   * @param sessionId 当前 AI 会话 id
   * @param options 地址与可选视口
   * @returns 加载完成后的页面状态
   */
  async open(sessionId: string, options: BrowserOpenOptions): Promise<BrowserPageState> {
    const window = this.ensureWindow(sessionId)
    if (options.width !== undefined || options.height !== undefined) {
      const [currentWidth, currentHeight] = window.getContentSize()
      const width = clampDimension(options.width, currentWidth, MIN_WIDTH, MAX_WIDTH)
      const height = clampDimension(options.height, currentHeight, MIN_HEIGHT, MAX_HEIGHT)
      if (width !== currentWidth || height !== currentHeight) {
        window.setContentSize(width, height)
      }
    }
    const url = normalizeBrowserUrl(options.url)
    await this.load(window, url, options.signal)
    return this.state(window)
  }

  /**
   * 读取当前页面的标题、可见文字与可交互元素。
   * 元素引用（eN）会在快照时重新编号，之前拿到的引用不能跨快照使用。
   */
  async snapshot(sessionId: string): Promise<BrowserSnapshot> {
    const window = this.requireWindow(sessionId)
    const raw = asRecord(await window.webContents.executeJavaScript(SNAPSHOT_SCRIPT))
    if (raw === undefined) {
      throw new Error('页面快照失败：脚本没有返回对象')
    }
    const state = await this.state(window)
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
    const window = this.requireWindow(sessionId)
    const payload = await this.action(window, clickScript(ref), ref)
    await this.settle(window, signal)
    const state = await this.state(window)
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
    const window = this.requireWindow(sessionId)
    await this.action(window, typeScript(ref, text, submit), ref)
    await this.settle(window, signal)
    return this.state(window)
  }

  /** 截取当前视口；返回 PNG 字节与页面状态 */
  async screenshot(sessionId: string, signal?: AbortSignal): Promise<BrowserScreenshot> {
    const window = this.requireWindow(sessionId)
    // 等两帧：确保 DOM 更新已经画进了合成器，隐藏窗口也能被 capturePage 抓到
    await window.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'
    )
    signal?.throwIfAborted()
    const image = await window.webContents.capturePage()
    if (image.isEmpty()) {
      throw new Error('截图失败：当前页面没有可捕获的内容')
    }
    const state = await this.state(window)
    return { ...state, data: image.toPNG() }
  }

  /** 关闭会话的浏览器窗口；没有窗口时返回 false */
  close(sessionId: string): boolean {
    const window = this.windows.get(sessionId)
    if (window === undefined) {
      return false
    }
    this.windows.delete(sessionId)
    if (!window.isDestroyed()) {
      window.destroy()
    }
    return true
  }

  /** 应用退出或主窗口关闭时销毁全部浏览器窗口 */
  disposeAll(): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) {
        window.destroy()
      }
    }
    this.windows.clear()
  }

  /** 取窗口；不存在时给出可执行的下一步提示 */
  private requireWindow(sessionId: string): BrowserWindow {
    const window = this.windows.get(sessionId)
    if (window === undefined || window.isDestroyed()) {
      throw new Error('当前会话还没有打开浏览器页面；先调用 browser_open')
    }
    return window
  }

  /**
   * 创建窗口：隐藏、独立内存分区、禁用 Node 与弹窗。
   * 同一会话重复调用时复用已经打开的窗口。
   */
  private ensureWindow(sessionId: string): BrowserWindow {
    const existing = this.windows.get(sessionId)
    if (existing !== undefined && !existing.isDestroyed()) {
      return existing
    }
    const partition = partitionOf(sessionId)
    const window = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      useContentSize: true,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      title: 'scoder 浏览器',
      backgroundColor: '#ffffff',
      webPreferences: {
        // 页面是不可信的远端内容：不给 Node，开沙箱，隔离上下文
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // 隐藏窗口也要持续绘制，否则截图可能是空白
        backgroundThrottling: false,
        partition
      }
    })
    this.preparePartition(window.webContents.session, partition)
    // 页面里的链接只允许继续在 http/https 内跳转；其它协议直接拦下
    window.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url)) {
        event.preventDefault()
      }
    })
    // target=_blank 不开新窗口：在当前页面继续导航，AI 才有唯一的操作对象
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedNavigation(url)) {
        void window.loadURL(url).catch(() => undefined)
      }
      return { action: 'deny' }
    })
    window.on('closed', () => {
      if (this.windows.get(sessionId) === window) {
        this.windows.delete(sessionId)
      }
    })
    this.windows.set(sessionId, window)
    return window
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
  private load(window: BrowserWindow, url: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const webContents = window.webContents
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
      void window.loadURL(url).catch((error: unknown) => {
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
  private async settle(window: BrowserWindow, signal?: AbortSignal): Promise<void> {
    await delay(ACTION_SETTLE_MS, signal)
    if (!window.webContents.isLoading()) {
      return
    }
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        window.webContents.removeListener('did-stop-loading', finish)
        resolve()
      }
      const timer = setTimeout(finish, SETTLE_LOAD_TIMEOUT_MS)
      window.webContents.once('did-stop-loading', finish)
    })
  }

  /** 执行一个动作脚本并把失败翻译成可读错误 */
  private async action(window: BrowserWindow, script: string, ref: string): Promise<ActionPayload> {
    const payload = asRecord(await window.webContents.executeJavaScript(script))
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

  /** 读取页面状态；标题取不到时用空串兜底 */
  private async state(window: BrowserWindow): Promise<BrowserPageState> {
    const [width, height] = window.getContentSize()
    let title = ''
    try {
      const value: unknown = await window.webContents.executeJavaScript('document.title')
      if (typeof value === 'string') {
        title = value
      }
    } catch {
      // 页面正在导航时脚本可能失败：标题不是必需信息
    }
    return {
      url: window.webContents.getURL(),
      title,
      width,
      height
    }
  }
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

/** 进程内唯一的浏览器管理器：AI 工具与会话生命周期共用 */
export const browserManager = new BrowserManager()
