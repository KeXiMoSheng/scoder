import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// 从 vscode-icons 的关联表生成项目使用的文件图标清单。
// vscode-icons 把「图标 → 扩展名/完整文件名/语言」维护在 supportedExtensions.ts，
// 语言对应的后缀再集中定义在 languages.ts；构建主题时展开成 fileExtensions/fileNames。
// 这里用同样的数据源展开一次，运行时只查生成的清单，不再手写映射。
// 数据源已拷贝到 scripts/vscode-icons（取自 vscode-icons v13.0.0，MIT License）。
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.resolve(rootDir, 'scripts/vscode-icons')
const iconsDir = path.resolve(rootDir, 'public/icons')
const outputFile = path.resolve(rootDir, 'src/renderer/src/lib/fileIconManifest.json')

const require = createRequire(import.meta.url)

/**
 * 用 TypeScript 把 vscode-icons 的数据模块转成 CommonJS 再加载。
 * 这些模块只有类型导入和值导入各一条，转译后直接 require 即可。
 */
function loadIconCollections() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'scoder-file-icons-'))
  try {
    for (const name of ['languages.ts', 'supportedExtensions.ts']) {
      const source = readFileSync(path.join(sourceDir, name), 'utf8')
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022
        }
      })
      writeFileSync(path.join(tempDir, name.replace(/\.ts$/, '.js')), outputText)
    }
    return require(path.join(tempDir, 'supportedExtensions.js')).extensions
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

/** 优先暗色文件图标，只有亮色版本时回退到 file_type_light_* */
function resolveIconFile(icon, availableIcons, missingIcons) {
  const darkIcon = `file_type_${icon}.svg`
  if (availableIcons.has(darkIcon)) {
    return darkIcon
  }
  const lightIcon = `file_type_light_${icon}.svg`
  if (availableIcons.has(lightIcon)) {
    return lightIcon
  }
  missingIcons.add(icon)
  return null
}

function sortRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

const collections = loadIconCollections()
const availableIcons = new Set(readdirSync(iconsDir))
const missingIcons = new Set()
const fileNames = {}
const fileExtensions = {}

const setFileName = (name, iconFile) => {
  fileNames[name.toLowerCase()] = iconFile
}

// 与 vscode-icons 的 manifestBuilder 一致：扩展名去掉可能存在的首个点
const setFileExtension = (extension, iconFile) => {
  const key = extension.replace(/^\./, '').toLowerCase()
  if (key) {
    fileExtensions[key] = iconFile
  }
}

// 主题构建按图标名排序，后处理的条目覆盖先处理的，保持相同的覆盖顺序
const entries = collections.supported
  .filter((entry) => entry.icon && !entry.disabled)
  .sort((a, b) => (a.icon < b.icon ? -1 : a.icon > b.icon ? 1 : 0))

for (const entry of entries) {
  const iconFile = resolveIconFile(entry.icon, availableIcons, missingIcons)
  if (!iconFile) {
    continue
  }

  // 语言关联先写入（优先级低）：vscode-icons 在 VS Code 里靠 languageId 匹配图标，
  // 项目只能看到文件名，因此把 knownExtensions/knownFilenames 也加入清单
  for (const language of entry.languages ?? []) {
    for (const extension of language.knownExtensions ?? []) {
      setFileExtension(extension, iconFile)
    }
    for (const name of language.knownFilenames ?? []) {
      setFileName(name, iconFile)
    }
  }

  // 显式声明后写入，覆盖同名的语言关联
  for (const extension of entry.extensions ?? []) {
    if (entry.filename) {
      setFileName(extension, iconFile)
    } else {
      setFileExtension(extension, iconFile)
    }
  }

  // 形如 tsconfig.{json,yaml} 的组合：文件名前后缀做笛卡尔积
  if (entry.filenamesGlob?.length && entry.extensionsGlob?.length) {
    for (const name of entry.filenamesGlob) {
      for (const extension of entry.extensionsGlob) {
        const combined = `${name}.${extension}`
        if (entry.filename) {
          setFileName(combined, iconFile)
        } else {
          setFileExtension(combined, iconFile)
        }
      }
    }
  }
}

writeFileSync(
  outputFile,
  `${JSON.stringify(
    {
      fileNames: sortRecord(fileNames),
      fileExtensions: sortRecord(fileExtensions)
    },
    null,
    2
  )}\n`
)

if (missingIcons.size > 0) {
  console.warn(`缺少图标资源，已跳过：${[...missingIcons].sort().join(', ')}`)
}
console.log(
  `已生成 ${path.relative(rootDir, outputFile)}：${Object.keys(fileNames).length} 个文件名映射，` +
    `${Object.keys(fileExtensions).length} 个扩展名映射`
)
