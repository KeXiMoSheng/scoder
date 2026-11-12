/** 模型配置通道：设置页的增删改查，数据落在主进程 SQLite */
export const MODEL_CONFIG_CHANNELS = {
  list: 'modelConfig:list',
  create: 'modelConfig:create',
  update: 'modelConfig:update',
  delete: 'modelConfig:delete',
  /** 删除全部模型配置（主进程弹确认框） */
  deleteAll: 'modelConfig:deleteAll',
  /** 拉取远程模型列表（主进程发请求，返回归一化后的待导入字段） */
  fetchRemote: 'modelConfig:fetchRemote',
  /** 批量导入：同一事务内落库，已存在的三元组配置覆盖，否则新增 */
  importMany: 'modelConfig:importMany',
  /** 读取上次成功导入时填写的连接信息 */
  getImportForm: 'modelConfig:getImportForm',
  /** 保存本次成功导入时填写的连接信息 */
  saveImportForm: 'modelConfig:saveImportForm',
  /** 读取对话框上次选中的模型主键 */
  getSelected: 'modelConfig:getSelected',
  /** 记录对话框当前选中的模型主键 */
  saveSelected: 'modelConfig:saveSelected'
} as const
