import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// 查询文件名在 VS Code Seti 主题下命中哪个图标定义。
// 直接加载渲染进程的真实解析模块，避免复制匹配规则。
// 用法：npm run check:file-icon -- package.json foo.spec.ts .env.local
// npm run check:file-icon -- src/renderer/src/App.tsx src/main/index.ts
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const names = process.argv.slice(2)

if (names.length === 0) {
  console.error('用法：npm run check:file-icon -- <文件名> [文件名...]')
  process.exit(1)
}

const server = await createServer({
  root: rootDir,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})

try {
  const { resolveFileIcon } = await server.ssrLoadModule('/src/renderer/src/lib/fileIcon.ts')

  for (const input of names) {
    const fileName = path.basename(input)
    const dark = resolveFileIcon(fileName, 'dark')
    const light = resolveFileIcon(fileName, 'light')
    const reason =
      dark.matchedBy === 'fileName'
        ? `完整文件名 "${dark.matchedKey}"`
        : dark.matchedBy === 'extension'
          ? `后缀 "${dark.matchedKey}"`
          : dark.matchedBy === 'language'
            ? `语言 "${dark.matchedKey}"`
            : '未命中，使用默认图标'
    console.log(
      `${fileName}\n  暗色：${dark.definition} ${dark.color} (U+${dark.character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0') ?? '----'})\n` +
        `  亮色：${light.definition} ${light.color}\n  依据：${reason}`
    )
  }
} finally {
  await server.close()
}
