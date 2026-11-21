/** 导入主题通道：主进程 handler 与 preload 转发共用 */
export const THEME_CHANNELS = {
  /** 读取 userData/themes 下已导入的主题 */
  listImported: 'theme:listImported',
  /** 弹出文件选择框并导入主题（.json / .jsonc / .vsix） */
  importThemes: 'theme:importThemes',
  /** 删除一套已导入主题（主进程弹确认框） */
  deleteImported: 'theme:deleteImported'
} as const
