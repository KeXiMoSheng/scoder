/** 模型配置通道：设置页的增删改查，数据落在主进程 SQLite */
export const MODEL_CONFIG_CHANNELS = {
  list: 'modelConfig:list',
  create: 'modelConfig:create',
  update: 'modelConfig:update',
  delete: 'modelConfig:delete'
} as const
