/**
 * 浏览器代理冒烟测试：用真实的 Electron WebContentsView 跑一遍导航 → 快照 → 点击 →
 * 输入 → 截图 → 关闭，并验证截图确实落进了图片对象存储。
 *
 * 为什么不用普通 node 跑：浏览器工具依赖 WebContentsView 与 nativeImage，
 * 只能在 Electron 主进程里执行。脚本由 scripts/run-browser-smoke.mjs 拉起
 * （Linux 下用 ozone headless，无需真实显示器），见 package.json 的 test:browser。
 */

import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { BrowserEvent } from '../src/shared/browser/types'
import { browserManager, normalizeBrowserUrl } from '../src/main/browser/manager'
import { toolImagePreviewPath } from '../src/main/ai/images/store'
import { createBrowserTools } from '../src/main/ai/tools/browser'
import type { ToolContext, ToolDefinition } from '../src/main/ai/tools/registry'

// 图片对象存储落在 userData 下：测试环境把它指到工作区（.browser-smoke 已被忽略），
// 否则只读的默认 userData 会让截图在落盘阶段失败。
const userData = join(process.cwd(), '.browser-smoke', 'user-data')
mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)

/** 断言失败即退出，避免后续断言给出误导性的连锁错误 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exit(1)
  }
  console.log(`✓ ${message}`)
}

/** 按名字取工具 */
function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((item) => item.name === name)
  if (found === undefined) {
    throw new Error(`缺少工具 ${name}`)
  }
  return found
}

/** 测试页：按钮点击计数、输入框回显，便于验证事件确实派发给了页面 */
const PAGE = `<!doctype html>
<html>
<head><title>Browser Smoke</title>
<style>body{background:#102030;color:#fff;font:16px sans-serif}</style></head>
<body>
  <h1>Hello Browser</h1>
  <button id="click">Click Me</button>
  <input id="name" placeholder="your name">
  <div id="out">count: 0</div>
  <script>
    let count = 0
    document.getElementById('click').addEventListener('click', () => {
      count += 1
      document.getElementById('out').textContent = 'count: ' + count
    })
    const input = document.getElementById('name')
    input.addEventListener('input', () => {
      document.getElementById('out').textContent = 'typed: ' + input.value
    })
  </script>
</body>
</html>`

/** 地址栏导航用的第二页：标题不同，便于断言同一页面确实发生了导航 */
const NEXT_PAGE = `<!doctype html>
<html>
<head><title>Browser Smoke Next</title></head>
<body><h1>Second Page</h1></body>
</html>`

/**
 * 用工具层走一遍完整的浏览器流程。
 * @param url 本机 fixture 地址
 * @param ctx 工具执行上下文（只需要会话 id 与能力开关）
 */
async function exerciseTools(url: string, ctx: ToolContext): Promise<void> {
  const tools = createBrowserTools()
  assert(tools.length === 6, '注册 6 个浏览器工具')
  assert(
    tools.every((item) => item.name.startsWith('browser_')),
    '工具名统一使用 browser_ 前缀'
  )

  const opened = await tool(tools, 'browser_open').execute({ url, width: 900, height: 600 }, ctx)
  assert(opened.text.includes('<title>Browser Smoke</title>'), 'browser_open 返回标题')
  assert(opened.text.includes('<viewport>900×600</viewport>'), 'browser_open 返回视口')
  assert(browserManager.list().length === 1, 'list 返回当前打开的页签')

  const snapshot = await tool(tools, 'browser_snapshot').execute({}, ctx)
  assert(snapshot.text.includes('[e1] button "Click Me"'), 'browser_snapshot 给出按钮引用')
  assert(snapshot.text.includes('[e2] input'), 'browser_snapshot 给出输入框引用')
  assert(snapshot.text.includes('Hello Browser'), 'browser_snapshot 带可见文字')

  const clicked = await tool(tools, 'browser_click').execute({ ref: 'e1' }, ctx)
  assert(clicked.text.includes('已点击 e1'), 'browser_click 返回已点击')
  const afterClick = await tool(tools, 'browser_snapshot').execute({}, ctx)
  assert(afterClick.text.includes('count: 1'), 'browser_click 触发页面事件')

  const typed = await tool(tools, 'browser_type').execute({ ref: 'e2', text: 'Ada' }, ctx)
  assert(typed.text.includes('写入 3 个字符'), 'browser_type 返回写入长度')
  const afterType = await tool(tools, 'browser_snapshot').execute({}, ctx)
  assert(afterType.text.includes('typed: Ada'), 'browser_type 触发页面事件')

  const screenshot = tool(tools, 'browser_screenshot')
  assert(screenshot.requiresVision === true, '截图工具声明需要识图能力')
  const result = await screenshot.execute({}, ctx)
  const image = result.image
  assert(image !== undefined, '截图产出图片引用')
  const preview = image === undefined ? undefined : toolImagePreviewPath(image)
  assert(preview !== undefined && existsSync(preview), '截图对象已落盘')
  const png = readFileSync(preview ?? '')
  assert([...png.subarray(0, 8)].join(',') === '137,80,78,71,13,10,26,10', '截图是合法 PNG')
  const card = screenshot.presentResult?.({}, result)
  assert(card?.kind === 'image' && card.path === preview, '截图卡片指向预览对象')
  // 便于失败时人工核对：保留最后一张截图（目录被 .gitignore 忽略）
  writeFileSync('.browser-smoke/last-screenshot.png', png)

  // 地址栏导航复用同一个页面：同一会话不应新建窗口/页签
  await browserManager.navigate(ctx.sessionId, `${url}next`)
  const navigated = await tool(tools, 'browser_snapshot').execute({}, ctx)
  assert(navigated.text.includes('<title>Browser Smoke Next</title>'), 'navigate 在同一页签内导航')
  assert(browserManager.list().length === 1, '导航后仍只有一个页签')

  const closed = await tool(tools, 'browser_close').execute({}, ctx)
  assert(closed.text.includes('已关闭'), 'browser_close 关闭页签')
  assert(browserManager.list().length === 0, '关闭后页签列表为空')
}

/**
 * 标题栏「打开浏览器」的手动页签：不预载地址、重复打开复用同一个页签，
 * 之后靠地址栏导航，与 AI 页面共用同一套视图管理。
 */
async function exerciseManualTab(url: string): Promise<void> {
  const sessionId = browserManager.openManual()
  const [opened] = browserManager.list()
  assert(opened?.sessionId === sessionId, 'openManual 建出独立的手动浏览页签')
  assert(opened?.url === '', '手动页签不预载地址')
  assert(browserManager.openManual() === sessionId, '再次打开复用同一个页签')
  assert(browserManager.list().length === 1, '重复打开不会堆出多个页签')
  await browserManager.navigate(sessionId, url)
  assert(browserManager.list()[0]?.url === url, '手动页签可以用地址栏导航')
  assert(browserManager.close(sessionId), '手动页签可以关闭')
}

/** 入口：启动 fixture 服务，先验证 URL 规则，再跑工具流程 */
async function main(): Promise<void> {
  assert(normalizeBrowserUrl('localhost:5173') === 'http://localhost:5173/', '省略协议时补 http://')
  let rejected = false
  try {
    normalizeBrowserUrl('file:///etc/passwd')
  } catch {
    rejected = true
  }
  assert(rejected, '拒绝 file: 协议')

  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(request.url === '/next' ? NEXT_PAGE : PAGE)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const ctx = {
    sessionId: 'browser-smoke',
    supportsVision: true,
    signal: new AbortController().signal,
    cwd: process.cwd(),
    fs: {} as never,
    observation: {} as never
  } as ToolContext
  // 浏览器页面是挂在主窗口上的 WebContentsView：测试里用一个窗口模拟主窗口。
  // show: true 是截图所需——隐藏窗口里的视图不会产生合成画面；Linux 下由 ozone headless 提供虚拟显示。
  const host = new BrowserWindow({
    show: true,
    width: 1200,
    height: 900,
    webPreferences: { sandbox: true }
  })
  await host.loadURL('data:text/html,<html><body></body></html>')
  browserManager.attachWindow(host)
  const events: BrowserEvent[] = []
  browserManager.setNotifier((event) => events.push(event))
  try {
    await exerciseTools(url, ctx)
    assert(
      events.some((event) => event.type === 'open'),
      '打开页面会推送 open 页签事件'
    )
    assert(
      events.some((event) => event.type === 'state' && event.tab.title === 'Browser Smoke'),
      '页签状态事件带页面标题'
    )
    assert(events.at(-1)?.type === 'closed', '关闭页面会推送 closed 页签事件')
    await exerciseManualTab(url)
    console.log('浏览器代理冒烟测试全部通过')
  } finally {
    browserManager.setNotifier(null)
    browserManager.disposeAll()
    if (!host.isDestroyed()) {
      host.destroy()
    }
    server.close()
  }
}

void app.whenReady().then(
  () =>
    main().then(
      () => app.quit(),
      (error: unknown) => {
        console.error(error)
        process.exitCode = 1
        app.quit()
      }
    ),
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
    app.quit()
  }
)
