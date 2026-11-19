/**
 * MCP 子进程的环境变量。
 *
 * 与 deepseek-harness 的 scrubbedParentEnv 同义：继承系统环境（PATH、HOME 等必须保留），
 * 但剔除密钥类变量与 Electron 自身的注入变量 —— 后者的存在会让一个 Node 写的
 * MCP 服务端误以为自己是 Electron，从而加载失败。
 */

/** 密钥形状的变量名：命中即不传给子进程 */
const SECRET_ENV_NAME =
  /(?:^|_)(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)(?:_|$)/i

/**
 * 生成 stdio 服务端的子进程环境：系统环境（已清洗）叠加配置里的显式变量。
 * @param extra 配置中填写的环境变量，同名时覆盖系统值
 * @returns 可直接交给 spawn 的环境变量表
 */
export function childEnvironment(extra: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // Electron 注入的开关（ELECTRON_RUN_AS_NODE 等）会把 Node 服务端的行为整个换掉
    if (key.startsWith('ELECTRON_')) continue
    if (SECRET_ENV_NAME.test(key)) continue
    environment[key] = value
  }
  return { ...environment, ...extra }
}
