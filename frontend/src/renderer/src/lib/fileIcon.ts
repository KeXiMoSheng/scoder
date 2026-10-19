/**
 * 文件图标解析：图标资源位于 public/icons，映射清单由
 * scripts/generate-file-icons.mjs 从 vscode-icons 的关联表生成。
 * 匹配顺序：完整文件名 → 最长后缀 → 通用文件图标。
 */
import manifest from './fileIconManifest.json'

/** 未匹配到类型时使用的通用文件图标 */
const DEFAULT_FILE_ICON = 'default_file.svg'

const FILE_NAMES: Readonly<Record<string, string>> = manifest.fileNames
const FILE_EXTENSIONS: Readonly<Record<string, string>> = manifest.fileExtensions

/**
 * 生成查表候选键，按优先级从高到低排列：
 * foo.test.ts → test.ts、ts；.env.local → env.local、env、local；Makefile → makefile。
 * vscode-icons 在 VS Code 里靠 languageId 区分 .env.local 这类文件，
 * 项目只能看到文件名，因此额外支持点文件的首段和无扩展名文件的整名。
 */
function getLookupKeys(fileName: string): string[] {
  const suffixes: string[] = []
  for (
    let dotIndex = fileName.indexOf('.');
    dotIndex !== -1;
    dotIndex = fileName.indexOf('.', dotIndex + 1)
  ) {
    const suffix = fileName.slice(dotIndex + 1)
    if (suffix) {
      suffixes.push(suffix)
    }
  }

  if (fileName.startsWith('.')) {
    const firstSegment = fileName.slice(1).split('.', 1)[0]
    if (firstSegment && firstSegment !== suffixes[0]) {
      suffixes.splice(1, 0, firstSegment)
    }
  } else if (suffixes.length === 0) {
    suffixes.push(fileName)
  }

  return suffixes
}

/** 图标命中结果，matchedKey 为命中的文件名或后缀 */
export interface FileIconMatch {
  icon: string
  matchedBy: 'fileName' | 'extension' | 'default'
  matchedKey?: string
}

/** 按文件名解析图标；未匹配时回退到通用文件图标 */
export function resolveFileIcon(fileName: string): FileIconMatch {
  const lowerName = fileName.toLowerCase()
  const exact = FILE_NAMES[lowerName]
  if (exact) {
    return { icon: exact, matchedBy: 'fileName', matchedKey: lowerName }
  }
  for (const key of getLookupKeys(lowerName)) {
    const icon = FILE_EXTENSIONS[key]
    if (icon) {
      return { icon, matchedBy: 'extension', matchedKey: key }
    }
  }
  return { icon: DEFAULT_FILE_ICON, matchedBy: 'default' }
}

/** 按文件名解析图标 URL */
export function getFileIconUrl(fileName: string): string {
  // BASE_URL：开发环境为 /，构建后为 ./（electron-vite 的 file:// 相对路径）
  return `${import.meta.env.BASE_URL}icons/${resolveFileIcon(fileName).icon}`
}
