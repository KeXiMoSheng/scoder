import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 校验版本号是否一致：package.json 是唯一真源，package-lock.json 里两处 version 只是
// npm 在 install / version 时写入的快照，手改 package.json 不会同步它们。
// 用法：npm run version:check（make lint 也会调用）
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'))

const expected = pkg.version
const targets = [
  ['package.json', pkg.version],
  ['package-lock.json', lock.version],
  ['package-lock.json packages[""]', lock.packages?.['']?.version]
]

const drift = targets.filter(([, version]) => version !== expected)
if (drift.length > 0) {
  console.error(`[version] 版本号不一致，期望 ${expected}：`)
  for (const [where, version] of drift) {
    console.error(`  - ${where}: ${version ?? '缺失'}`)
  }
  console.error(
    '[version] 不要手改 package.json 的 version，用下面的命令变更（会自动同步锁文件）：'
  )
  console.error('  npm run release:patch   # 或 release:minor / release:major')
  console.error('  npm install --package-lock-only --ignore-scripts   # 仅补同步锁文件')
  process.exit(1)
}

console.log(`[version] OK ${expected}`)
