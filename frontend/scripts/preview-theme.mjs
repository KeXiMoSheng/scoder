import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 生成主题颜色预览页：把主题 JSON 的 colors 与 rules/tokenColors 渲染成色块网格，
// 支持多主题切换、关键字过滤，生成单个自包含 HTML 后用浏览器打开。
// 用法：
//   node scripts/preview-theme.mjs                     # 预览 public/theme/ 下全部 .json 主题
//   node scripts/preview-theme.mjs <主题文件或目录>...  # 预览指定文件（支持 JSONC 与原版 VSCode 主题）
//   node scripts/preview-theme.mjs --out <路径>         # 指定输出文件
//   node scripts/preview-theme.mjs --no-open            # 只生成，不自动打开浏览器

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, '..')
const themeDir = path.join(rootDir, 'public', 'theme')

// ---------- 命令行参数 ----------

function printHelp() {
  console.log(`主题颜色预览

用法：
  node scripts/preview-theme.mjs [选项] [主题文件或目录...]

不传主题参数时，预览 public/theme/ 下全部 .json 主题（原版与 -monaco 版都包含）。

选项：
  --out <路径>   输出 HTML 路径（默认写入系统临时目录）
  --no-open      生成后不自动打开浏览器
  -h, --help     显示本帮助`)
}

function parseArgs(argv) {
  const options = { out: path.join(os.tmpdir(), 'scoder-theme-preview.html'), open: true, files: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      printHelp()
      process.exit(0)
    } else if (arg === '--out') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('--out 需要跟一个输出路径')
      }
      options.out = path.resolve(value)
      i += 1
    } else if (arg === '--no-open') {
      options.open = false
    } else if (arg.startsWith('-')) {
      throw new Error(`未知选项：${arg}`)
    } else {
      options.files.push(path.resolve(arg))
    }
  }
  return options
}

/** 参数里的目录展开为其中的 .json 文件；不传参数时取主题目录下的全部 .json（含原版与 -monaco 版） */
function resolveThemeFiles(files) {
  if (files.length === 0) {
    return readdirSync(themeDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(themeDir, name))
  }
  const result = []
  for (const file of files) {
    if (!existsSync(file)) {
      throw new Error(`找不到文件：${file}`)
    }
    if (statSync(file).isDirectory()) {
      for (const name of readdirSync(file).sort()) {
        if (name.endsWith('.json')) {
          result.push(path.join(file, name))
        }
      }
    } else {
      result.push(file)
    }
  }
  if (result.length === 0) {
    throw new Error('没有找到可预览的主题文件')
  }
  return result
}

// ---------- 主题解析 ----------

/** 去掉 JSONC 的注释与尾随逗号：原版 VSCode 主题带注释，直接 JSON.parse 会失败 */
function stripJsonc(text) {
  let withoutComments = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      withoutComments += ch
      if (ch === '\\') {
        withoutComments += text[i + 1] ?? ''
        i += 1
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      withoutComments += ch
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i += 1
      }
      withoutComments += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1
      }
      i += 1
    } else {
      withoutComments += ch
    }
  }

  // 第二次扫描只删尾随逗号，同样跳过字符串内容
  let result = ''
  inString = false
  for (let i = 0; i < withoutComments.length; i += 1) {
    const ch = withoutComments[i]
    if (inString) {
      result += ch
      if (ch === '\\') {
        result += withoutComments[i + 1] ?? ''
        i += 1
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      result += ch
    } else if (ch === ',') {
      let next = i + 1
      while (next < withoutComments.length && /\s/.test(withoutComments[next])) {
        next += 1
      }
      const nextChar = withoutComments[next]
      if (nextChar !== '}' && nextChar !== ']') {
        result += ch
      }
    } else {
      result += ch
    }
  }
  return result
}

function loadThemeData(file) {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  // 个别手动整理的文件开头会残留 ".theme" 标签，先去掉再解析
  const normalized = text.replace(/^\s*\.theme\s*/, '')
  try {
    return JSON.parse(normalized)
  } catch {
    return JSON.parse(stripJsonc(normalized))
  }
}

/** 兼容 Monaco 版 rules 与原版 VSCode tokenColors，统一成 { token, foreground, background } */
function extractRules(data) {
  const rules = []
  for (const rule of Array.isArray(data.rules) ? data.rules : []) {
    rules.push({
      token: rule.token || '(默认)',
      foreground: rule.foreground || '',
      background: rule.background || ''
    })
  }
  for (const rule of Array.isArray(data.tokenColors) ? data.tokenColors : []) {
    const settings = rule.settings || {}
    const scope = Array.isArray(rule.scope) ? rule.scope.join(', ') : rule.scope
    rules.push({
      token: scope || rule.name || '(默认)',
      foreground: settings.foreground || '',
      background: settings.background || ''
    })
  }
  return rules
}

function loadTheme(file) {
  const data = loadThemeData(file)
  const colors = Object.entries(data.colors || {})
    .filter(([, value]) => typeof value === 'string')
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
  return {
    name: path.basename(file).replace(/-monaco\.json$/i, '').replace(/\.json$/i, ''),
    file,
    kind: data.type || data.base || '',
    colors,
    rules: extractRules(data)
  }
}

// ---------- 预览页生成 ----------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function swatch(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) {
    return '<span class="sw empty"></span>'
  }
  return `<span class="sw" style="background:${escapeHtml(trimmed)}"></span>`
}

function colorRow(key, value) {
  return (
    `<div class="row" data-search="${escapeHtml(`${key} ${value}`.toLowerCase())}">` +
    `${swatch(value)}<code class="key">${escapeHtml(key)}</code>` +
    `<code class="val">${escapeHtml(value)}</code></div>`
  )
}

function ruleRow(rule) {
  const search = `${rule.token} ${rule.foreground} ${rule.background}`.toLowerCase()
  return (
    `<div class="row" data-search="${escapeHtml(search)}">` +
    `<span class="pair">${swatch(rule.foreground)}${swatch(rule.background)}</span>` +
    `<code class="token">${escapeHtml(rule.token)}</code>` +
    `<code class="val">${escapeHtml([rule.foreground, rule.background].filter(Boolean).join(' '))}</code>` +
    `</div>`
  )
}

function themeSection(theme, index) {
  return (
    `<section class="theme" id="theme-${index}"${index === 0 ? '' : ' hidden'}>` +
    `<h2>colors（UI 颜色）<span class="count">${theme.colors.length} 项</span></h2>` +
    `<div class="grid">${theme.colors.map(([key, value]) => colorRow(key, value)).join('')}</div>` +
    `<h2>rules（语法 token：左块=前景，右块=背景）` +
    `<span class="count">${theme.rules.length} 项</span></h2>` +
    `<div class="grid">${theme.rules.map(ruleRow).join('')}</div>` +
    `</section>`
  )
}

function buildHtml(themes) {
  const options = themes
    .map(
      (theme, index) =>
        `<option value="${index}">${escapeHtml(theme.name)}（${theme.colors.length} 色 / ${theme.rules.length} token）</option>`
    )
    .join('')
  const meta = themes[0] ? `${escapeHtml(themes[0].kind)}` : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>主题颜色预览</title>
<style>
  body { background:#1b1e24; color:#c8ccd4; font:13px/1.5 ui-monospace,Consolas,monospace; margin:0; padding:24px 24px 60px; }
  h1 { font-size:16px; color:#fff; margin:0 0 4px; }
  .meta { color:#7f848e; margin-bottom:12px; }
  .toolbar { position:sticky; top:0; z-index:9; display:flex; gap:12px; align-items:center;
             padding:10px 0; margin-bottom:8px; background:#1b1e24; border-bottom:1px solid #2b313b; }
  select, input { padding:6px 10px; background:#23272e; color:#d7dae0; border:1px solid #3e4452; border-radius:6px; font:inherit; }
  input { width:320px; }
  .stat { color:#7f848e; }
  h2 { font-size:14px; color:#8fb7ff; margin:26px 0 8px; border-bottom:1px solid #333a46; padding-bottom:6px; }
  .count { color:#7f848e; font-weight:normal; margin-left:8px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); gap:2px 18px; }
  .row { display:flex; align-items:center; gap:8px; padding:1px 4px; border-radius:4px; }
  .row:hover { background:#262b33; }
  .sw { display:inline-block; width:16px; height:16px; border-radius:3px; border:1px solid #4a515f; flex:none;
        background-image:linear-gradient(45deg,#3a3a3a 25%,transparent 25%,transparent 75%,#3a3a3a 75%),
                         linear-gradient(45deg,#3a3a3a 25%,#222 25%,#222 75%,#3a3a3a 75%);
        background-size:8px 8px; }
  .sw.empty { background:#2a2e36; border-style:dashed; }
  .pair { display:inline-flex; gap:2px; flex:none; }
  .key { color:#abb2bf; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .token { color:#98c379; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .val { color:#61afef; margin-left:auto; flex:none; }
</style>
</head>
<body>
<h1>主题颜色预览</h1>
<div class="meta">${themes.length} 个主题 · ${meta}</div>
<div class="toolbar">
  <select id="theme">${options}</select>
  <input id="filter" placeholder="过滤：键名 / 色值 / token，如 editor、#61afef">
  <span class="stat" id="stat"></span>
</div>
${themes.map(themeSection).join('')}
<script>
  var select = document.getElementById('theme')
  var filter = document.getElementById('filter')
  var stat = document.getElementById('stat')
  var sections = Array.prototype.slice.call(document.querySelectorAll('section.theme'))

  function applyFilter() {
    var keyword = filter.value.toLowerCase()
    var visible = 0
    var total = 0
    sections.forEach(function (section) {
      var shown = 0
      var rows = section.querySelectorAll('.row')
      rows.forEach(function (row) {
        var match = !keyword || (row.dataset.search || '').indexOf(keyword) !== -1
        row.style.display = match ? '' : 'none'
        if (!section.hidden) {
          total += 1
          if (match) shown += 1
        }
      })
      if (!section.hidden) visible = shown
    })
    stat.textContent = keyword ? '显示 ' + visible + ' / ' + total : ''
  }

  function activate(index) {
    sections.forEach(function (section, i) {
      section.hidden = i !== index
    })
    history.replaceState(null, '', '#' + index)
    applyFilter()
  }

  select.addEventListener('change', function () {
    activate(Number(select.value))
  })
  filter.addEventListener('input', applyFilter)

  var initial = Number((location.hash || '').replace('#', ''))
  if (initial >= 0 && initial < sections.length) {
    select.value = String(initial)
    activate(initial)
  } else {
    activate(0)
  }
</script>
</body>
</html>
`
}

// ---------- 执行 ----------

function openInBrowser(file) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 没有图形环境时打开失败不影响已生成的预览文件
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const files = resolveThemeFiles(options.files)
  const themes = files.map(loadTheme)
  // 同时传入原版与 -monaco 版时名称会重复，重复项改用完整文件名区分
  const nameCounts = new Map()
  for (const theme of themes) {
    nameCounts.set(theme.name, (nameCounts.get(theme.name) || 0) + 1)
  }
  for (const theme of themes) {
    if (nameCounts.get(theme.name) > 1) {
      theme.name = path.basename(theme.file)
    }
  }
  const html = buildHtml(themes)

  mkdirSync(path.dirname(options.out), { recursive: true })
  writeFileSync(options.out, html, 'utf8')

  console.log(`已生成主题预览：${options.out}`)
  for (const theme of themes) {
    console.log(`  - ${theme.name}：${theme.colors.length} 个颜色，${theme.rules.length} 条 token 规则`)
  }
  if (options.open) {
    openInBrowser(options.out)
  }
}

try {
  main()
} catch (error) {
  console.error(`[preview-theme] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
