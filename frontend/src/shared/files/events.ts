/** 文件系统通道：主进程 handler 与 preload 转发共用，避免两处字符串漂移 */
export const FILES_CHANNELS = {
  /** 弹系统目录选择框（dialog 域，语义上属于打开项目） */
  openProjectDirectory: 'dialog:openProjectDirectory',
  readDirectory: 'fs:readDirectory',
  readFile: 'fs:readFile',
  writeFile: 'fs:writeFile',
  createEntry: 'fs:createEntry',
  moveEntry: 'fs:moveEntry',
  deleteEntry: 'fs:deleteEntry',
  searchFiles: 'fs:searchFiles'
} as const
