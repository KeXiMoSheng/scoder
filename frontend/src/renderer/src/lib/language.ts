/** 常见扩展名到 Monaco 语言 id 的映射；未命中的回退 plaintext */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  java: 'java',
  kt: 'kotlin',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  properties: 'ini',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  r: 'r',
  bat: 'bat',
  cmd: 'bat',
  ps1: 'powershell',
  txt: 'plaintext',
  log: 'plaintext'
}

/** Markdown 代码围栏的语言别名 → Monaco 语言 id（未命中的键再按扩展名映射解析） */
const MARKDOWN_LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell',
  terminal: 'shell',
  py: 'python',
  yml: 'yaml',
  golang: 'go',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  kt: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
  rs: 'rust',
  docker: 'dockerfile',
  toml: 'ini',
  conf: 'ini',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext'
}

/** 根据文件名推断 Monaco 语言 id */
export function detectLanguage(fileName: string): string {
  const lowerName = fileName.toLowerCase()
  // 无扩展名或扩展名不代表语言的特殊文件
  if (lowerName === 'dockerfile' || lowerName.startsWith('dockerfile.')) {
    return 'dockerfile'
  }
  if (lowerName.startsWith('.env')) {
    return 'ini'
  }
  if (lowerName === '.gitignore' || lowerName === 'makefile') {
    return 'plaintext'
  }
  const dotIndex = lowerName.lastIndexOf('.')
  const extension = dotIndex >= 0 ? lowerName.slice(dotIndex + 1) : ''
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext'
}

/** 是否为 Markdown 文件（决定编辑器是否启用预览视图） */
export function isMarkdownFile(fileName: string): boolean {
  return detectLanguage(fileName) === 'markdown'
}

/**
 * 解析 Markdown 代码围栏的语言标识（如 ```js、```bash title="x"），返回 Monaco 语言 id。
 * 无法识别时返回标识本身，由调用方按语言是否注册决定是否着色
 */
export function resolveMarkdownLanguage(info: string): string {
  const alias = (info.trim().split(/\s+/)[0] ?? '').toLowerCase()
  if (!alias) {
    return ''
  }
  return MARKDOWN_LANGUAGE_ALIASES[alias] ?? LANGUAGE_BY_EXTENSION[alias] ?? alias
}
