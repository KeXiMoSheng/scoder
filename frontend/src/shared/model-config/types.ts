/**
 * 模型配置域：数据库 model_configs 表在进程边界上的投影。
 * 这里是跨进程共享的“领域类型”，不是表结构本身——行映射（snake_case → camelCase）
 * 只在主进程 db/model-configs.ts 内发生。
 */

/** 已保存的模型配置（对应数据库 model_configs 表的一行） */
export interface ModelConfig {
  /** 自增主键 */
  id: number
  /** 模型供应商名，如 OpenAI */
  providerName: string
  /** 模型服务地址（OpenAI 兼容的 base URL） */
  baseUrl: string
  /** 模型显示名称（界面上展示的名字） */
  displayName: string
  /** 模型名称（调用接口时使用的 model 参数） */
  modelName: string
  /** API Key（本地明文存储；主进程调用模型时读取，渲染进程只在设置页回填使用） */
  apiKey: string
  /** 创建时间（UTC，ISO 字符串） */
  createdAt: string
  /** 最后更新时间（UTC，ISO 字符串） */
  updatedAt: string
}

/** 新建/更新模型配置时提交的字段 */
export interface ModelConfigInput {
  providerName: string
  baseUrl: string
  displayName: string
  modelName: string
  /** API Key；本地模型等场景允许为空字符串 */
  apiKey: string
}

/**
 * 一键导入：拉取远程模型列表的参数。
 * 请求由主进程发起——渲染进程直连第三方地址会被 CORS 拦住。
 */
export interface RemoteModelListRequest {
  /** 模型请求地址：导入后写入每条配置的 baseUrl */
  baseUrl: string
  /** 模型列表地址（完整 URL，通常以 /models 结尾） */
  modelsUrl: string
  /** Authorization 头的值，如 Bearer sk-…；API Key 取 Bearer 之后的部分 */
  authorization: string
}

/** 一键导入的结果 */
export interface ModelImportResult {
  /** 本次新建成功的配置 */
  created: ModelConfig[]
  /** 因「模型请求地址 + 模型名称」已存在而跳过的条数 */
  skipped: number
}
