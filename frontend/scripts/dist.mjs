import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/**
 * 交叉打包时补上目标平台的 ripgrep 二进制。
 * @vscode/ripgrep 只会安装构建机平台对应的可选依赖，从 Linux 打 Windows 包时
 * node_modules 里只有 rg，没有 rg.exe，装出来的应用会搜不了文件。
 * @param target 目标平台（win | linux | mac）
 */
function ensureRipgrepBinary(target) {
  const platformName = target === 'win' ? 'win32' : target === 'mac' ? 'darwin' : 'linux'
  const binary = platformName === 'win32' ? 'rg.exe' : 'rg'
  const packageName = `@vscode/ripgrep-${platformName}-${process.arch}`
  const packageFallback = path.join(
    rootDir,
    'node_modules',
    '@vscode',
    `ripgrep-${platformName}-${process.arch}`
  )
  if (existsSync(path.join(packageFallback, 'bin', binary))) {
    return
  }
  const ripgrepVersion = JSON.parse(
    readFileSync(path.join(rootDir, 'node_modules', '@vscode', 'ripgrep', 'package.json'), 'utf8')
  ).version
  console.log(`[dist] 补装 ${packageName}@${ripgrepVersion}（目标平台二进制）`)
  // 隔离到临时目录安装再拷回来：直接 --os 装到工程目录会把宿主平台的可选依赖顶掉
  const staging = mkdtempSync(path.join(tmpdir(), 'scoder-rg-'))
  try {
    execSync(
      `npm install --prefix "${staging}" --no-save --force --no-audit --no-fund ` +
        `--os=${platformName} --cpu=${process.arch} ${packageName}@${ripgrepVersion}`,
      { cwd: rootDir, stdio: 'inherit', env }
    )
    cpSync(
      path.join(staging, 'node_modules', '@vscode', path.basename(packageFallback)),
      packageFallback,
      {
        recursive: true
      }
    )
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * 交叉打包时补上目标平台的 better-sqlite3 预编译二进制。
 * better-sqlite3 的 npm 包自带各平台 N-API 预编译文件（prebuilds/<platform>-<arch>.node），
 * 本机安装目录里的文件可能不齐（如从 Linux 打 Windows 包时缺 win32-x64.node），
 * 应用启动会报 "Cannot find module ...better_sqlite3.node"。
 * 缺文件时从 npm tarball 里提取目标平台的预编译文件补齐。
 * @param target 目标平台（win | linux | mac）
 */
function ensureBetterSqlite3Prebuild(target) {
  const platformName = target === 'win' ? 'win32' : target === 'mac' ? 'darwin' : 'linux'
  const prebuildName = `${platformName}-${process.arch}.node`
  const packageDir = path.join(rootDir, 'node_modules', 'better-sqlite3')
  const prebuildDir = path.join(packageDir, 'prebuilds')
  if (existsSync(path.join(prebuildDir, prebuildName))) {
    return
  }
  const sqliteVersion = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version
  console.log(`[dist] 补齐 better-sqlite3 ${prebuildName}（${sqliteVersion}）`)
  const staging = mkdtempSync(path.join(tmpdir(), 'scoder-sqlite-'))
  try {
    execSync(
      `npm pack better-sqlite3@${sqliteVersion} --pack-destination "${staging}" --silent`,
      { cwd: rootDir, stdio: 'inherit', env }
    )
    // tar 在 Linux/macOS 与 Windows 10+ 均可用；剥离 package/prebuilds/ 前缀后直接落到 prebuilds 目录
    execSync(
      `tar -xzf "${path.join(staging, `better-sqlite3-${sqliteVersion}.tgz`)}" -C "${prebuildDir}" ` +
        `--strip-components=2 "package/prebuilds/${prebuildName}"`,
      { cwd: rootDir, stdio: 'inherit', env }
    )
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

ensureRipgrepBinary(platform)
ensureBetterSqlite3Prebuild(platform)
execSync(`electron-builder --${platform} -c.extraMetadata.version=${version}`, {
  cwd: rootDir,
  stdio: 'inherit',
  env
})
