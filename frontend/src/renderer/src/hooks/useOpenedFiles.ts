import { useCallback, useState } from 'react'
import { basename, isAtOrUnder } from '../lib/filePath'

/** 编辑器标签指向的文件（绝对路径为唯一标识） */
export interface OpenedFile {
  path: string
  name: string
}

/** 已打开文件状态：列表（按打开顺序）+ 当前激活项 */
interface OpenedFilesState {
  files: OpenedFile[]
  activePath: string | null
}

export interface OpenedFilesApi {
  /** 已打开的文件（按打开顺序） */
  files: OpenedFile[]
  /** 当前激活文件路径；无激活项时为 null */
  activePath: string | null
  /** 当前激活的文件；无激活项时为 null */
  activeFile: OpenedFile | null
  /** 打开文件：已打开时仅激活（复用编辑器缓存），否则追加到末尾并激活 */
  open: (file: OpenedFile) => void
  /** 激活指定文件（仅当其已在列表中） */
  activate: (path: string) => void
  /** 关闭单个标签；编辑器模型缓存保留，重新打开可恢复未保存内容 */
  close: (path: string) => void
  /** 关闭除指定文件外的全部标签 */
  closeOthers: (path: string) => void
  /** 关闭指定文件右侧的全部标签 */
  closeToRight: (path: string) => void
  /** 关闭全部标签 */
  closeAll: () => void
  /** 条目重命名/移动后同步标签路径（oldPath 前缀替换为 newPath） */
  remap: (oldPath: string, newPath: string) => void
  /** 关闭指定路径及其子路径下的标签（条目被删除后调用） */
  closeUnder: (path: string) => void
}

/**
 * 从列表中移除命中谓词的标签并维护激活项：
 * 激活项被移除时优先激活其右侧的幸存标签，否则向左回退，最后为 null。
 */
function removeMatching(
  state: OpenedFilesState,
  shouldRemove: (file: OpenedFile, index: number) => boolean
): OpenedFilesState {
  const files = state.files.filter((file, index) => !shouldRemove(file, index))
  if (files.length === state.files.length) {
    return state
  }
  let activePath = state.activePath
  const activeIndex = state.files.findIndex((file) => file.path === state.activePath)
  if (activeIndex !== -1 && shouldRemove(state.files[activeIndex], activeIndex)) {
    activePath = null
    for (let index = activeIndex + 1; index < state.files.length; index++) {
      if (!shouldRemove(state.files[index], index)) {
        activePath = state.files[index].path
        break
      }
    }
    if (activePath === null) {
      for (let index = activeIndex - 1; index >= 0; index--) {
        if (!shouldRemove(state.files[index], index)) {
          activePath = state.files[index].path
          break
        }
      }
    }
  }
  return { files, activePath }
}

/** 多标签文件状态管理（打开/激活/关闭各类操作/路径同步） */
export function useOpenedFiles(): OpenedFilesApi {
  const [state, setState] = useState<OpenedFilesState>({ files: [], activePath: null })

  const open = useCallback((file: OpenedFile): void => {
    setState((prev) => {
      if (prev.files.some((item) => item.path === file.path)) {
        return prev.activePath === file.path ? prev : { files: prev.files, activePath: file.path }
      }
      return { files: [...prev.files, file], activePath: file.path }
    })
  }, [])

  const activate = useCallback((path: string): void => {
    setState((prev) => {
      if (prev.activePath === path || !prev.files.some((file) => file.path === path)) {
        return prev
      }
      return { files: prev.files, activePath: path }
    })
  }, [])

  const close = useCallback((path: string): void => {
    setState((prev) => removeMatching(prev, (file) => file.path === path))
  }, [])

  const closeOthers = useCallback((path: string): void => {
    setState((prev) => {
      const target = prev.files.find((file) => file.path === path)
      if (!target || prev.files.length === 1) {
        return prev
      }
      return { files: [target], activePath: path }
    })
  }, [])

  const closeToRight = useCallback((path: string): void => {
    setState((prev) => {
      const index = prev.files.findIndex((file) => file.path === path)
      if (index === -1 || index === prev.files.length - 1) {
        return prev
      }
      return removeMatching(prev, (_file, i) => i > index)
    })
  }, [])

  const closeAll = useCallback((): void => {
    setState((prev) => (prev.files.length === 0 ? prev : { files: [], activePath: null }))
  }, [])

  const remap = useCallback((oldPath: string, newPath: string): void => {
    setState((prev) => {
      let changed = false
      const files = prev.files.map((file) => {
        if (!isAtOrUnder(file.path, oldPath)) {
          return file
        }
        changed = true
        const nextPath = file.path === oldPath ? newPath : newPath + file.path.slice(oldPath.length)
        return { path: nextPath, name: basename(nextPath) }
      })
      let activePath = prev.activePath
      if (activePath !== null && isAtOrUnder(activePath, oldPath)) {
        activePath = activePath === oldPath ? newPath : newPath + activePath.slice(oldPath.length)
        changed = true
      }
      return changed ? { files, activePath } : prev
    })
  }, [])

  const closeUnder = useCallback((path: string): void => {
    setState((prev) => removeMatching(prev, (file) => isAtOrUnder(file.path, path)))
  }, [])

  return {
    files: state.files,
    activePath: state.activePath,
    activeFile: state.files.find((file) => file.path === state.activePath) ?? null,
    open,
    activate,
    close,
    closeOthers,
    closeToRight,
    closeAll,
    remap,
    closeUnder
  }
}
