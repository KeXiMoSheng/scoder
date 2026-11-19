/**
 * 共享的结算截止时间：给启动、探测与关闭各自的预算一个统一的实现。
 */

/**
 * 在 remainingMs 内结算 promise；先到点则以 timeoutMessage 拒绝。
 * 计时器不持有事件循环，进程不会因为一次超时预算而无法退出。
 * @param promise 被限时的操作
 * @param remainingMs 剩余预算（毫秒，至少 1）
 * @param timeoutMessage 超时错误的可读原因
 * @returns 操作的返回值；操作失败或超时时拒绝
 */
export function withDeadline<T>(
  promise: Promise<T>,
  remainingMs: number,
  timeoutMessage: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), Math.max(1, remainingMs))
    timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

/**
 * 把异常压成一行可读文本，保留 cause 链。
 * 连接失败常见形态是 `TypeError: fetch failed, cause: Error: getaddrinfo ENOTFOUND …`，
 * 只取 message 会丢掉真正有用的那一层。
 * @param error 捕获到的异常
 * @returns 单行诊断文本
 */
export function describeError(error: unknown): string {
  const segments: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      const text = current.message.length > 0 ? `${current.name}: ${current.message}` : current.name
      segments.push(text)
      current = current.cause
    } else {
      segments.push(String(current))
      current = undefined
    }
  }
  return segments.length > 0 ? segments.join(', cause: ') : String(error)
}
