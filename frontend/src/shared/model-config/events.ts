/** 模型配置通道：设置页的增删改查，数据落在主进程 SQLite */
export const MODEL_CONFIG_CHANNELS = {
  list: 'modelConfig:list',
  create: 'modelConfig:create',
  update: 'modelConfig:update',
  delete: 'modelConfig:delete',
  /** 拉取远程模型列表（主进程发请求，返回归一化后的待导入字段） */
  fetchRemote: 'modelConfig:fetchRemote',
  /** 批量导入：同一事务内落库，跳过已存在的配置 */
  importMany: 'modelConfig:importMany'
} as const
