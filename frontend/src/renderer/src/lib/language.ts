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
