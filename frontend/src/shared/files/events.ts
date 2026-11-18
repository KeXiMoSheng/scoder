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
  searchFiles: 'fs:searchFiles',
  searchFileContents: 'fs:searchFileContents',
  replaceFileContents: 'fs:replaceFileContents',
  /** 目录监听：渲染进程同步「已加载目录」，主进程挂原生 watcher 并推送条目变化 */
  setWatchedDirectories: 'fs:setWatchedDirectories',
  clearWatchedDirectories: 'fs:clearWatchedDirectories',
  /** 文件监听：渲染进程同步「编辑器已打开（已缓存）的文件」，内容变化时推送 */
  setWatchedFiles: 'fs:setWatchedFiles',
  /** 主进程 → 渲染进程：目录内条目发生增删/改名 */
  directoriesChanged: 'fs:directoriesChanged',
  /** 主进程 → 渲染进程：打开文件的内容被外部修改或条目被替换 */
  filesChanged: 'fs:filesChanged'
} as const
