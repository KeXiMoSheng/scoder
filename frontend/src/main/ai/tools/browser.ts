/**
 * 浏览器测试工具：让 AI 打开页面、读结构、点按输入并截图。
 *
 * 与 read_image 的关系：两者产出的图片走完全相同的通路 —— 工具只负责把
 * PNG 交给 images/store，循环在工具结果之后补一条图片消息给模型。
 * 差别只在图片来源：read_image 读工作区文件，browser_screenshot 读隐藏浏览器。
 */
import { prepareImageForModel, formatBytes } from '../images/prepare'
import { readImageFacts } from '../images/probe'
import { saveToolImage, toolImagePreviewPath } from '../images/store'
import type { ToolImageRef } from '../images/types'
import type { BrowserPageState, BrowserSnapshot } from '../../browser/manager'
import { browserManager } from '../../browser/manager'
import { optionalInteger, requireString, type ToolDefinition } from './registry'

/** 截图对象名的计数器：同一秒内连续截图也不会撞上预览别名 */
let screenshotSequence = 0

/** 快照与动作结果里的页面状态 */
function formatState(state: BrowserPageState): string {
  const title = state.title.length > 0 ? state.title : '(无标题)'
  return `<url>${state.url}</url>\n<title>${title}</title>\n<viewport>${state.width}×${state.height}</viewport>`
}

/** 快照里的一行元素描述 */
function formatElement(element: BrowserSnapshot['elements'][number]): string {
  const parts = [`[${element.ref}]`, element.tag]
  if (element.role !== undefined) {
    parts.push(`role=${element.role}`)
  }
  if (element.detail !== undefined) {
    parts.push(element.detail)
  }
  if (element.text !== undefined) {
    parts.push(`"${element.text}"`)
  }
  if (element.disabled === true) {
    parts.push('(disabled)')
  }
  return parts.join(' ')
}

/** 截图文件名：可读时间 + 进程内序号，避免预览别名指向上一张图 */
function screenshotName(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  screenshotSequence += 1
  return (
    `网页截图-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${screenshotSequence}.png`
  )
}

/** 截图卡片：图片本体按预览路径从 userData 读回 */
function screenshotCard(image: ToolImageRef | undefined): {
  kind: 'image'
  title: string
  path?: string
  image?: { mediaType: string; width: number; height: number; bytes: number }
} {
  const path = image === undefined ? undefined : toolImagePreviewPath(image)
  return {
    kind: 'image',
    title: '网页截图',
    ...(path === undefined ? {} : { path }),
    ...(image === undefined
      ? {}
      : {
          image: {
            mediaType: image.mediaType,
            width: image.width,
            height: image.height,
            bytes: image.bytes
          }
        })
  }
}

/** browser_open：在隐藏浏览器里打开页面 */
function createBrowserOpenTool(): ToolDefinition {
  return {
    name: 'browser_open',
    description:
      '在隐藏的 Chromium 浏览器里打开一个 http/https 页面（同一会话复用同一个窗口，跨轮次保留页面与登录状态）。' +
      '前端联调时先用 bash 启动 dev server，再用它打开 http://localhost:<端口>；随后用 browser_snapshot 看页面结构，' +
      '用 browser_screenshot 看真实渲染效果。file: 等本地协议不支持，纯静态页面请起一个本地 HTTP 服务。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要打开的地址，例如 http://localhost:5173/；省略协议时按 http:// 补全。'
        },
        width: {
          type: 'number',
          description: '视口宽度（CSS 像素），默认 1280；范围 320–3840。'
        },
        height: {
          type: 'number',
          description: '视口高度（CSS 像素），默认 800；范围 240–2160。'
        }
      },
      required: ['url'],
      additionalProperties: false
    },
    timeoutMs: 45_000,
    async execute(args, ctx) {
      const url = requireString(args, 'url')
      const state = await browserManager.open(ctx.sessionId, {
        url,
        ...(typeof args.width === 'number'
          ? { width: optionalInteger(args, 'width', 1280, 3840) }
          : {}),
        ...(typeof args.height === 'number'
          ? { height: optionalInteger(args, 'height', 800, 2160) }
          : {}),
        signal: ctx.signal
      })
      return {
        text: `已打开页面。\n${formatState(state)}`,
        meta: { url: state.url }
      }
    },
    presentCall(args) {
      const url = typeof args.url === 'string' ? args.url : ''
      return {
        kind: 'generic',
        title: url.length > 0 ? `打开 ${url}` : '打开网页'
      }
    },
    presentResult(args) {
      const url = typeof args.url === 'string' ? args.url : ''
      return {
        kind: 'generic',
        title: url.length > 0 ? `打开 ${url}` : '打开网页'
      }
    }
  }
}

/** browser_snapshot：读取标题、可见文字与可交互元素引用 */
function createBrowserSnapshotTool(): ToolDefinition {
  return {
    name: 'browser_snapshot',
    description:
      '读取当前浏览器页面的标题、可见文字和可交互元素列表。每个元素带一个 eN 引用，' +
      '点击与输入时用这个引用。页面更新后引用会失效，需要重新快照。' +
      '这是操作页面的第一步：不要凭猜测给选择器，先看快照。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    timeoutMs: 15_000,
    async execute(_args, ctx) {
      const snapshot = await browserManager.snapshot(ctx.sessionId)
      const lines: string[] = [formatState(snapshot)]
      if (snapshot.elements.length === 0) {
        lines.push('<elements>\n(没有可交互元素)\n</elements>')
      } else {
        const elements = snapshot.elements.map(formatElement)
        if (snapshot.totalElements > snapshot.elements.length) {
          elements.push(
            `... 还有 ${snapshot.totalElements - snapshot.elements.length} 个可交互元素未列出`
          )
        }
        lines.push(`<elements>\n${elements.join('\n')}\n</elements>`)
      }
      lines.push(
        `<text>\n${snapshot.text.length > 0 ? snapshot.text : '(页面没有可见文字)'}\n</text>`
      )
      return {
        text: lines.join('\n'),
        meta: { url: snapshot.url, elements: snapshot.elements.length }
      }
    },
    presentCall() {
      return { kind: 'generic', title: '查看页面' }
    },
    presentResult() {
      return { kind: 'generic', title: '查看页面' }
    }
  }
}

/** browser_click：点击快照里的 eN */
function createBrowserClickTool(): ToolDefinition {
  return {
    name: 'browser_click',
    description:
      '点击当前页面里由 browser_snapshot 给出的元素引用（如 e3）。' +
      '点击后可能触发异步更新或跳转，工具会等页面稳定并返回新的地址；' +
      '需要确认结果时再调用 browser_snapshot 或 browser_screenshot。',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: '快照里的元素引用，例如 e3。'
        }
      },
      required: ['ref'],
      additionalProperties: false
    },
    timeoutMs: 25_000,
    async execute(args, ctx) {
      const ref = requireRef(args, 'ref')
      const state = await browserManager.click(ctx.sessionId, ref, ctx.signal)
      return {
        text: `已点击 ${ref}（${state.target}）。\n${formatState(state)}`
      }
    },
    presentCall(args) {
      const ref = typeof args.ref === 'string' ? args.ref : ''
      return { kind: 'generic', title: ref.length > 0 ? `点击 ${ref}` : '点击元素' }
    }
  }
}

/** browser_type：向快照里的输入框写入文本 */
function createBrowserTypeTool(): ToolDefinition {
  return {
    name: 'browser_type',
    description:
      '向当前页面里由 browser_snapshot 给出的输入元素（input/textarea/contenteditable）写入文本。' +
      'submit 为 true 时提交所在表单或按回车，适合登录、搜索等流程。' +
      '写入会触发 input/change 事件，React 等受控组件也能收到。',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: '快照里的元素引用，例如 e5。'
        },
        text: {
          type: 'string',
          description: '要写入的文本；长度上限 10000 字符。'
        },
        submit: {
          type: 'boolean',
          description: '写入后是否提交表单（默认 false）。'
        }
      },
      required: ['ref', 'text'],
      additionalProperties: false
    },
    timeoutMs: 25_000,
    async execute(args, ctx) {
      const ref = requireRef(args, 'ref')
      const text = typeof args.text === 'string' ? args.text : ''
      if (text.length > 10_000) {
        throw new Error('text 超过 10000 字符上限')
      }
      const submit = args.submit === true
      const state = await browserManager.type(ctx.sessionId, ref, text, submit, ctx.signal)
      return {
        text: `已向 ${ref} 写入 ${text.length} 个字符${submit ? '并提交' : ''}。\n${formatState(state)}`
      }
    },
    presentCall(args) {
      const ref = typeof args.ref === 'string' ? args.ref : ''
      return { kind: 'generic', title: ref.length > 0 ? `输入到 ${ref}` : '输入文本' }
    }
  }
}

/** browser_screenshot：把当前视口交给模型看 */
function createBrowserScreenshotTool(): ToolDefinition {
  return {
    name: 'browser_screenshot',
    description:
      '截取当前浏览器视口，把 PNG 直接交给模型查看真实渲染效果。' +
      '检查布局、颜色、间距、文字截断或报错覆盖层时用它；' +
      '需要检查页面结构或点击元素时用 browser_snapshot。' +
      '截图只包含视口，不含浏览器边框与开发者工具。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    timeoutMs: 20_000,
    requiresVision: true,
    async execute(_args, ctx) {
      if (!ctx.supportsVision) {
        throw new Error('当前模型不支持图片输入，无法查看网页截图；请换用能看图的模型后再试')
      }
      const shot = await browserManager.screenshot(ctx.sessionId, ctx.signal)
      const facts = readImageFacts(shot.data)
      if (facts === undefined) {
        throw new Error('截图失败：生成的 PNG 无法识别')
      }
      const prepared = prepareImageForModel(shot.data, facts)
      const image = await saveToolImage(prepared, screenshotName())
      const scaled = prepared.width !== facts.width || prepared.height !== facts.height
      const note = scaled
        ? `原图 ${facts.width}×${facts.height}，为控制体积已缩小到 ${prepared.width}×${prepared.height}`
        : `${prepared.width}×${prepared.height}`
      return {
        text:
          `${formatState(shot)}\n` +
          `<content>\n网页截图：${prepared.mediaType}，${note}，${formatBytes(prepared.data.byteLength)}。` +
          '截图已作为图片附在本条工具结果之后，请直接查看。\n</content>',
        image
      }
    },
    presentCall() {
      return { kind: 'generic', title: '网页截图' }
    },
    presentResult(_args, outcome) {
      return screenshotCard(outcome.image)
    }
  }
}

/** browser_close：关闭当前会话的浏览器窗口 */
function createBrowserCloseTool(): ToolDefinition {
  return {
    name: 'browser_close',
    description:
      '关闭当前会话的浏览器窗口，释放页面与登录状态。需要干净环境重新测试，或本轮浏览器工作结束时用它；' +
      '下次 browser_open 会创建新的窗口。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    timeoutMs: 5_000,
    execute(_args, ctx) {
      const closed = browserManager.close(ctx.sessionId)
      return Promise.resolve({
        text: closed ? '已关闭当前会话的浏览器窗口。' : '当前会话没有打开的浏览器窗口。'
      })
    },
    presentCall() {
      return { kind: 'generic', title: '关闭浏览器' }
    }
  }
}

/** 一次注册全部浏览器工具 */
export function createBrowserTools(): ToolDefinition[] {
  return [
    createBrowserOpenTool(),
    createBrowserSnapshotTool(),
    createBrowserClickTool(),
    createBrowserTypeTool(),
    createBrowserScreenshotTool(),
    createBrowserCloseTool()
  ]
}

/** 校验快照引用：只接受 eN，挡住模型把选择器或脚本塞进参数 */
function requireRef(args: Record<string, unknown>, key: string): string {
  const ref = requireString(args, key)
  if (!/^e\d{1,4}$/.test(ref)) {
    throw new Error(`参数 ${key} 必须是快照里的元素引用（形如 e3），而不是选择器`)
  }
  return ref
}
