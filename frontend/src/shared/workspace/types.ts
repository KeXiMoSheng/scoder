/** 最近打开项目：渲染进程与主进程共用的数据结构 */
export interface RecentProject {
  /** 项目目录绝对路径（菜单直接展示，不截成目录名） */
  path: string
}

/** 待恢复的编辑器页签指向的文件（绝对路径 + 展示名） */
export interface RestoredEditorFile {
  path: string
  name: string
}

/**
 * 某个项目未手动关闭的编辑器页签快照：仅记录路径与激活项。
 * 文件内容不落库，重启后由编辑器按需重新读盘。
 */
export interface EditorTabsSnapshot {
  files: RestoredEditorFile[]
  activePath: string | null
}
