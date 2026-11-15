/** 文件系统通道：主进程 handler 与 preload 转发共用，避免两处字符串漂移 */
export const FILES_CHANNELS = {
  /** 弹系统目录选择框（dialog 域，语义上属于打开项目） */
  openProjectDirectory: 'dialog:openProjectDirectory',
  readDirectory: 'fs:readDirectory',
  readFile: 'fs:readFile',
  readFileBytes: 'fs:readFileBytes',
  /** 文本流：大文件按块读取并增量灌入编辑器 */
  openTextStream: 'fs:openTextStream',
  readTextStreamChunk: 'fs:readTextStreamChunk',
  closeTextStream: 'fs:closeTextStream',
  /** 写入流：大文件按块写入临时文件，完成后 fsync + rename 原子替换 */
  openWriteStream: 'fs:openWriteStream',
  appendWriteChunk: 'fs:appendWriteChunk',
  finishWriteStream: 'fs:finishWriteStream',
  abortWriteStream: 'fs:abortWriteStream',
  /** 文件大小观测：决定是否给出超限提示 */
  statFile: 'fs:statFile',
  createEntry: 'fs:createEntry',
  moveEntry: 'fs:moveEntry',
  deleteEntry: 'fs:deleteEntry',
  revealEntry: 'fs:revealEntry',
  searchFiles: 'fs:searchFiles'
} as const
