import { useEffect, useState, type RefObject } from 'react'

export interface ContainerSize {
  width: number
  height: number
}

/** 通过 ResizeObserver 持续测量容器内容区尺寸（react-arborist 需要明确的像素宽高） */
export function useContainerSize(ref: RefObject<HTMLElement | null>): ContainerSize {
  const [size, setSize] = useState<ContainerSize>({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) {
        return
      }
      const { width, height } = entry.contentRect
      setSize({ width: Math.floor(width), height: Math.floor(height) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return size
}
