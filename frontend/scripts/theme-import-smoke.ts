/**
 * 导入主题冒烟测试：验证 JSONC 解析、VS Code → Monaco 转换、include 继承与 .vsix 解包。
 *
 * 与 test:mcp 同样的理由：项目没有前端测试运行器，用 rolldown 把主进程的主题模块
 * 打成 CJS 后直接跑（见 package.json 的 test:theme）。这些模块不依赖 Electron。
 */

import { promises as fs } from 'fs'
import { deflateRawSync } from 'zlib'
import { join } from 'path'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import {
  convertThemeToMonaco,
  loadThemeWithIncludes,
  parseThemeJsonc,
  sanitizeConvertedTheme,
  type ThemeSource
} from '../src/shared/theme/convert'
import { importThemeFile } from '../src/main/theme/import'
import { openVsixThemePackage } from '../src/main/theme/vsix'

/** 断言失败即退出 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exit(1)
  }
  console.log(`✓ ${message}`)
}

const DEMO_JSONC = `{
  // 行注释：字符串里的 // 不能被删掉
  "name": "Demo // Theme /* not comment */",
  "type": "dark",
  "colors": {
    "editor.background": "#101010",
    "editor.foreground": "#eeeeee",
    "button.background": "#2adb5c",
    "invalid.color": "not-a-color"
  },
  "tokenColors": [
    {
      "scope": "comment, string",
      "settings": { "foreground": "#808080", "fontStyle": "italic underline nonsense" }
    },
    {
      "scope": ["keyword", " storage.type "],
      "settings": { "foreground": "#ff0000", "background": "#000000" }
    },
    { "settings": { "foreground": "#cccccc" } },
  ]
}`

function testJsoncAndConvert(): void {
  const parsed = parseThemeJsonc(DEMO_JSONC) as Record<string, unknown>
  assert(parsed.name === 'Demo // Theme /* not comment */', 'JSONC 解析保留字符串里的注释符号')
  const converted = convertThemeToMonaco(parsed)
  const theme = converted.editorTheme
  assert(converted.label === 'Demo // Theme /* not comment */', '主题名来自 name 字段')
  assert(theme.base === 'vs-dark', 'type=dark 映射到 vs-dark')
  assert(theme.colors['invalid.color'] === undefined, '非法颜色被丢弃')
  assert(theme.colors['button.background'] === '#2adb5c', '合法颜色保留')
  assert(
    theme.rules.some((rule) => rule.token === 'comment'),
    '逗号分隔的 scope 拆成多条规则'
  )
  assert(
    theme.rules.some((rule) => rule.token === 'string'),
    '逗号分隔的第二条 scope 也生成规则'
  )
  const keyword = theme.rules.find((rule) => rule.token === 'keyword')
  assert(
    keyword?.foreground === '#ff0000' && keyword.background === '#000000',
    'scope 数组与前景/背景色正确'
  )
  const comment = theme.rules.find((rule) => rule.token === 'comment')
  assert(comment?.fontStyle === 'italic underline', 'fontStyle 过滤掉非法关键字')
  const defaultRule = theme.rules[theme.rules.length - 1]
  assert(
    defaultRule.token === '' && defaultRule.foreground === '#eeeeee',
    '默认 token 取 editor.foreground'
  )

  const light = convertThemeToMonaco({ type: 'light', colors: {} })
  assert(light.editorTheme.base === 'vs', 'type=light 映射到 vs')
  const fallback = convertThemeToMonaco({ colors: {} }, { uiTheme: 'vs-dark' })
  assert(fallback.editorTheme.base === 'vs-dark', '缺 type 时回退扩展 manifest 的 uiTheme')
}

function testSanitize(): void {
  assert(
    sanitizeConvertedTheme({ base: 'nope', colors: {}, rules: [] }) === null,
    '非法 base 被拒绝'
  )
  const sanitized = sanitizeConvertedTheme({
    base: 'vs-dark',
    colors: { 'editor.foreground': '#fff', broken: 'red' },
    rules: [
      { token: 'x', foreground: '#abc' },
      { token: 'y', foreground: 'bad' }
    ]
  })
  assert(sanitized !== null, '合法主题通过校验')
  assert(sanitized?.colors.broken === undefined, '校验时再次过滤非法颜色')
  assert(
    sanitized?.rules.every((rule) => rule.token !== 'y'),
    '校验时过滤无有效样式的规则'
  )
}

async function testInclude(): Promise<void> {
  const files: Record<string, string> = {
    'extension/base.json': JSON.stringify({
      type: 'dark',
      colors: { 'editor.background': '#000000', 'editor.foreground': '#ffffff' },
      tokenColors: [{ scope: 'comment', settings: { foreground: '#777777' } }]
    }),
    'extension/themes/demo.json': JSON.stringify({
      include: '../base.json',
      name: 'Include Demo',
      colors: { 'editor.background': '#111111' },
      tokenColors: [{ scope: 'keyword', settings: { foreground: '#ff0000' } }]
    })
  }
  const source: ThemeSource = {
    resolve: (reference, fromKey) => {
      const directory = fromKey.slice(0, fromKey.lastIndexOf('/'))
      const parts = `${directory}/${reference}`.split('/')
      const stack: string[] = []
      for (const part of parts) {
        if (part === '..') {
          stack.pop()
        } else if (part !== '.' && part !== '') {
          stack.push(part)
        }
      }
      return stack.join('/')
    },
    read: (key) => {
      const text = files[key]
      if (!text) {
        throw new Error(`missing ${key}`)
      }
      return JSON.parse(text) as unknown
    }
  }
  const theme = await loadThemeWithIncludes(source, 'extension/themes/demo.json')
  const converted = convertThemeToMonaco(theme)
  assert(converted.editorTheme.colors['editor.background'] === '#111111', '子主题覆盖父主题颜色')
  assert(converted.label === 'Include Demo', 'include 后保留子主题名')
  assert(converted.editorTheme.rules.length === 3, 'include 后 tokenColors 拼接（含默认规则）')
}

async function testLocalManifest(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'scoder-theme-test-'))
  try {
    const themesDir = join(directory, 'themes')
    await fs.mkdir(themesDir, { recursive: true })
    await fs.writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'demo-extension',
        contributes: {
          themes: [{ label: '本地主题', uiTheme: 'vs-dark', path: './themes/demo.json' }]
        }
      }),
      'utf8'
    )
    await fs.writeFile(
      join(themesDir, 'demo.json'),
      JSON.stringify({
        name: 'Local Demo',
        colors: { 'editor.background': '#222222', 'editor.foreground': '#dddddd' },
        tokenColors: [{ scope: 'comment', settings: { foreground: '#888888' } }]
      }),
      'utf8'
    )
    const result = await importThemeFile(join(directory, 'package.json'))
    assert(result.errors.length === 0, '本地扩展清单没有错误')
    assert(result.drafts.length === 1, '本地扩展清单一套主题')
    assert(result.drafts[0]?.label === '本地主题', '扩展清单 label 优先')
    assert(result.drafts[0]?.editorTheme.base === 'vs-dark', '清单 uiTheme 生效')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** 构造最小 ZIP：store/deflate 两种方式都覆盖，CRC 留 0（读取端不校验） */
function buildZip(files: { path: string; content: string; deflate?: boolean }[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const raw = Buffer.from(file.content, 'utf8')
    const method = file.deflate ? 8 : 0
    const data = file.deflate ? deflateRawSync(raw) : raw

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + data.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

async function testVsix(): Promise<void> {
  const zip = buildZip([
    {
      path: 'extension/package.json',
      content: JSON.stringify({
        name: 'demo-theme',
        contributes: {
          themes: [
            { label: 'VSIX Demo', uiTheme: 'vs-dark', path: './themes/demo.json' },
            { label: 'VSIX Light', uiTheme: 'vs', path: './themes/light.json' }
          ]
        }
      }),
      deflate: true
    },
    {
      path: 'extension/themes/demo.json',
      content: JSON.stringify({
        include: './base.json',
        colors: { 'editor.background': '#0a0a0a' },
        tokenColors: [{ scope: 'string', settings: { foreground: '#00ff00' } }]
      })
    },
    {
      path: 'extension/themes/base.json',
      content: JSON.stringify({
        type: 'dark',
        colors: { 'editor.foreground': '#ffffff' },
        tokenColors: [{ scope: 'comment', settings: { foreground: '#777777' } }]
      }),
      deflate: true
    },
    {
      path: 'extension/themes/light.json',
      content: JSON.stringify({
        type: 'light',
        colors: { 'editor.background': '#ffffff', 'editor.foreground': '#111111' }
      })
    }
  ])

  const themePackage = openVsixThemePackage(zip)
  assert(themePackage.refs.length === 2, 'VSIX 清单解析出两套主题')
  const dark = await loadThemeWithIncludes(themePackage.source, themePackage.refs[0]!.key)
  const converted = convertThemeToMonaco(dark, { uiTheme: themePackage.refs[0]!.uiTheme })
  assert(converted.editorTheme.base === 'vs-dark', 'VSIX 主题类型来自 include 的父主题')
  assert(
    converted.editorTheme.colors['editor.foreground'] === '#ffffff',
    'VSIX 包内 include 能读到父主题'
  )
  const light = await loadThemeWithIncludes(themePackage.source, themePackage.refs[1]!.key)
  assert(convertThemeToMonaco(light).editorTheme.base === 'vs', 'VSIX 内浅色主题映射到 vs')
}

async function main(): Promise<void> {
  testJsoncAndConvert()
  testSanitize()
  await testInclude()
  await testLocalManifest()
  await testVsix()
  console.log('\n全部主题导入测试通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
