/**
 * 工作区（最近项目 / 启动恢复）通道：主进程 handler 与 preload 转发共用，
 * 避免两处字符串漂移。读写都走 invoke（需要主进程返回落库结果）。
 */
export const WORKSPACE_CHANNELS = {
  /** 最近项目列表（MRU，最多 5 个），供「文件」菜单展示 */
  listRecent: 'workspace:listRecent',
  /** 记录一个刚打开的项目：置于 MRU 首位并写入待恢复路径 */
  recordOpened: 'workspace:recordOpened',
  /** 手动关闭文件夹：清除待恢复路径（MRU 历史保留） */
  clearRestore: 'workspace:clearRestore',
  /** 读取上次未手动关闭的项目路径（目录已不存在时返回 null），供启动自动打开 */
  getLastProject: 'workspace:getLastProject'
} as const
