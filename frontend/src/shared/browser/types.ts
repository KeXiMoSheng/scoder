/**
 * AI 浏览器页签的公共契约：主进程推送的页签状态、渲染进程上报的内容区位置，
 * 以及 preload 暴露给界面的浏览器 API。
 */

/** 一个浏览器页签的当前状态（主进程是唯一数据源） */
export interface BrowserTabState {
  /** 所属 AI 会话：同一会话跨轮次复用同一个页面与登录状态 */
  sessionId: string
  /** 当前地址 */
  url: string
  /** 页面标题；页面未提供标题时为空串 */
  title: string
  /** 页面视口宽高（CSS 像素） */
  width: number
  height: number
  /** 是否正在加载（页签上的刷新图标据此旋转） */
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** 页签内容区在主窗口内容坐标系里的位置与尺寸（CSS 像素 ≈ DIP） */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 主进程 → 渲染进程的浏览器页签事件 */
export type BrowserEvent =
  /** 新建或重新打开了一个会话的浏览器：界面应确保页签存在并激活它 */
  | { type: 'open'; tab: BrowserTabState }
  /** 地址、标题、加载状态或前进后退能力变化 */
  | { type: 'state'; tab: BrowserTabState }
  /** 页面已关闭（AI 调用 browser_close、会话删除或主窗口关闭） */
  | { type: 'closed'; sessionId: string }

/** 渲染进程可用的浏览器能力（preload 白名单） */
export interface BrowserAPI {
  /** 订阅页签事件；返回取消订阅函数 */
  onEvent: (callback: (event: BrowserEvent) => void) => () => void
  /** 列出当前仍打开的浏览器页签（渲染进程重载后恢复页签用） */
  list: () => Promise<BrowserTabState[]>
  /**
   * 打开（或切回）手动浏览页签：与 AI 会话隔离的固定页签，不预载地址，
   * 由用户在地址栏里自己输入。返回该页签的 sessionId。
   */
  openTab: () => Promise<string>
  /**
   * 上报页签内容区的位置并控制原生页面是否显示。
   * visible 为 false 时页面保持加载，只是不再覆盖编辑器（例如切到文件页签或弹出菜单）。
   */
  setBounds: (sessionId: string, bounds: BrowserBounds, visible: boolean) => Promise<void>
  /** 关闭一个浏览器页签（销毁页面与登录状态） */
  close: (sessionId: string) => Promise<boolean>
  /** 在现有页签里导航到新地址（地址栏回车）；归一化与协议校验在主进程完成 */
  navigate: (sessionId: string, url: string) => Promise<void>
  reload: (sessionId: string) => Promise<void>
  goBack: (sessionId: string) => Promise<void>
  goForward: (sessionId: string) => Promise<void>
  /** 用系统默认浏览器打开当前页面 */
  openExternal: (sessionId: string) => Promise<void>
}
