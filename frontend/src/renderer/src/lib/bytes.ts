/** 字节数的展示口径：输入区附件、工具卡片与文件预览共用同一套格式 */

/**
 * 人类可读的字节数：B / KB / MB / GB。
 * 10 以下保留一位小数，10 以上取整，避免同一处出现两种精度。
 * @param bytes 字节数（非负数）
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}
