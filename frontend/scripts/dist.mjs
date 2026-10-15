import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'))

const platform = process.argv[2]
if (!['win', 'linux', 'mac'].includes(platform)) {
  console.error(
    '用法: node scripts/dist.mjs <win|linux|mac>，通道由环境变量 BUILD_CHANNEL 控制（release|dev）'
  )
  process.exit(1)
}

// release=正式版（版本号取 package.json）；dev=开发版（基础版本 + -dev.<yyyyMMddHHmm> 时间戳，无需手改版本号）
const channel = process.env.BUILD_CHANNEL === 'dev' ? 'dev' : 'release'
const baseVersion = packageJson.version.split('-')[0]
const now = new Date()
const stamp = [
  now.getFullYear(),
  now.getMonth() + 1,
  now.getDate(),
  now.getHours(),
  now.getMinutes()
]
  .map((n) => String(n).padStart(2, '0'))
  .join('')

const version = channel === 'dev' ? `${baseVersion}-dev.${stamp}` : packageJson.version
console.log(`[dist] channel=${channel} version=${version}`)

const env = {
  ...process.env,
  PATH: `${path.join(rootDir, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}`
}
execSync(`electron-builder --${platform} -c.extraMetadata.version=${version}`, {
  cwd: rootDir,
  stdio: 'inherit',
  env
})
