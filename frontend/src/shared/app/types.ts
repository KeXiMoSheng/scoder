/** 应用基础信息：设置页「关于」分区展示 */
export interface AppInfo {
  /** 当前应用版本号（开发态读取 package.json，打包后为安装包版本） */
  version: string
  /** 官方仓库地址（GitHub），点击后由系统浏览器打开 */
  repositoryUrl: string
}
