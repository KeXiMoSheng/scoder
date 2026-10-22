import { useEffect, useState } from 'react'

/** 与 Tailwind 的 md 断点保持一致：小于该宽度时视作移动端布局 */
const MOBILE_BREAKPOINT = 768

/** 视口是否处于移动端宽度（shadcn Sidebar 据此在抽屉与固定侧栏间切换） */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const handleChange = (): void => setIsMobile(query.matches)
    handleChange()
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  return isMobile
}
