/**
 * 提取可展示的错误信息。
 * ipcRenderer.invoke 会把主进程抛出的错误包装为
 * "Error invoking remote method 'xxx': Error: 原始信息"，展示前去掉这层前缀
 */
export function extractErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  const match = /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s.exec(message)
  return match ? match[1] : message
}
