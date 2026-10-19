import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from 'react-arborist'
import type { FileEntry } from '@shared/types'
import { useContainerSize } from '../../hooks/useContainerSize'
import { extractErrorMessage } from '../../lib/errorMessage'
import { basename, dirname, isAtOrUnder, joinPath, pathSeparator } from '../../lib/filePath'
import ContextMenu from '../ContextMenu'
import type { ContextMenuEntry } from '../ContextMenu/types'
import FileRow from '../FileRow'
import type {
  ContextMenuState,
  FileNode,
  FileTreeProps,
  MoveArgs,
  RenameArgs,
  SearchState
} from './types'

const ROW_HEIGHT = 24
const INDENT = 14
/** 搜索输入防抖间隔（ms） */
const SEARCH_DEBOUNCE = 200
/** 单次搜索展示的结果上限（主进程内部还有更宽的硬上限） */
const SEARCH_RESULT_LIMIT = 200
/** 操作失败等临时提示的展示时长（ms） */
const NOTICE_TIMEOUT = 4000

/** 通过 context 传递脏文件集合：保持 TreeNode 组件标识稳定，避免重挂载丢失编辑态 */
const DirtyPathsContext = createContext<ReadonlySet<string>>(new Set())

/** 通过 context 传递右键菜单入口：同样保持 TreeNode 组件标识稳定 */
const OpenContextMenuContext = createContext<(event: React.MouseEvent, path: string) => void>(
  () => {}
)

/** 目录节点初始给空数组，使其保持可展开形态（react-arborist 以 children 是否为数组判定叶子） */
function toFileNode(entry: FileEntry): FileNode {
  return { ...entry, children: entry.isDirectory ? [] : undefined }
}

/**
 * 把目录最新条目合并为节点数组：路径未变的节点保留原对象（含已加载的深层子项），
 * 避免刷新后已展开的目录丢失内容；新增/类型变化的条目重建节点。
 */
function mergeFileNodes(prevNodes: FileNode[], entries: FileEntry[]): FileNode[] {
  const prevByPath = new Map(prevNodes.map((node) => [node.path, node]))
  return entries.map((entry) => {
    const existing = prevByPath.get(entry.path)
    if (existing && existing.isDirectory === entry.isDirectory) {
      return existing
    }
    return toFileNode(entry)
  })
}

/** 在树数据中定位目录并按最新条目替换其 children（不可变更新；未命中分支保持原引用避免整树重渲染） */
function injectChildren(nodes: FileNode[], dirPath: string, entries: FileEntry[]): FileNode[] {
  let changed = false
  const next = nodes.map((node) => {
    if (node.path === dirPath) {
      changed = true
      return { ...node, children: mergeFileNodes(node.children ?? [], entries) }
    }
    if (!node.children || node.children.length === 0) {
      return node
    }
    const nextChildren = injectChildren(node.children, dirPath, entries)
    if (nextChildren === node.children) {
      return node
    }
    changed = true
    return { ...node, children: nextChildren }
  })
  return changed ? next : nodes
}

/** 目录在前、名称不区分大小写升序（与主进程 readDirectory 的排序一致） */
function sortFileNodes(nodes: FileNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  for (const node of nodes) {
    if (node.children && node.children.length > 0) {
      sortFileNodes(node.children)
    }
  }
}

/** 由搜索结果构造仅含命中条目及其全部祖先目录的子树（搜索模式下的树数据） */
function buildSearchTree(rootPath: string, entries: FileEntry[]): FileNode[] {
  const rootChildren: FileNode[] = []
  const dirNodes = new Map<string, FileNode>()

  for (const entry of entries) {
    const relative = entry.path.slice(rootPath.length + pathSeparator(rootPath).length)
    const segments = relative.split(/[\\/]/)
    // 逐级创建（或复用）祖先目录节点
    let siblingList = rootChildren
    let currentPath = rootPath
    for (let index = 0; index < segments.length - 1; index++) {
      currentPath = joinPath(currentPath, segments[index])
      let dirNode = dirNodes.get(currentPath)
      if (!dirNode) {
        dirNode = { name: segments[index], path: currentPath, isDirectory: true, children: [] }
        dirNodes.set(currentPath, dirNode)
        siblingList.push(dirNode)
      }
      siblingList = dirNode.children ?? []
    }
    if (dirNodes.has(entry.path)) {
      continue // 该目录已作为祖先节点存在，无需重复插入
    }
    const node: FileNode = { ...entry, children: entry.isDirectory ? [] : undefined }
    if (entry.isDirectory) {
      dirNodes.set(entry.path, node)
    }
    siblingList.push(node)
  }

  sortFileNodes(rootChildren)
  return rootChildren
}

function ChevronIcon({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      className={open ? 'text-dim transition-transform duration-100 rotate-90' : 'text-dim'}
      aria-hidden="true"
    >
      <path
        d="M6 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="text-[#dcb67a]" aria-hidden="true">
      <path
        d="M1.8 3.6c0-.6.5-1 1-1h3.1l1.3 1.4h6c.6 0 1 .4 1 1v7.4c0 .6-.4 1-1 1H2.8c-.5 0-1-.4-1-1V3.6z"
        fill="currentColor"
        opacity="0.85"
      />
    </svg>
  )
}

function RefreshIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v3.33h-3.33"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 重命名输入框：回车或失焦提交，Esc 取消；聚焦时选中主文件名（不含扩展名） */
function RenameInput({ node }: { node: NodeApi<FileNode> }): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const submittedRef = useRef(false)

  const submit = (): void => {
    if (submittedRef.current) {
      return
    }
    submittedRef.current = true
    node.submit(inputRef.current?.value ?? '')
  }

  return (
    <input
      ref={inputRef}
      className="min-w-0 flex-1 rounded-[2px] border border-accent-hover bg-base px-1 font-[inherit] text-[13px] text-fg outline-none"
      defaultValue={node.data.name}
      spellCheck={false}
      autoFocus
      onClick={(event) => event.stopPropagation()}
      onFocus={(event) => {
        const input = event.currentTarget
        const dotIndex = input.value.lastIndexOf('.')
        if (!node.data.isDirectory && dotIndex > 0) {
          input.setSelectionRange(0, dotIndex)
        } else {
          input.select()
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          submit()
        } else if (event.key === 'Escape') {
          node.reset()
        }
      }}
      onBlur={submit}
    />
  )
}

function TreeNode({ node, style, dragHandle }: NodeRendererProps<FileNode>): React.JSX.Element {
  const dirtyPaths = useContext(DirtyPathsContext)
  const openContextMenu = useContext(OpenContextMenuContext)
  const isDirty = !node.data.isDirectory && dirtyPaths.has(node.data.path)
  const rowClass = node.isSelected
    ? 'flex cursor-pointer items-center gap-1 whitespace-nowrap pr-2 select-none hover:bg-hover bg-selection'
    : 'flex cursor-pointer items-center gap-1 whitespace-nowrap pr-2 select-none hover:bg-hover'
  return (
    <div
      // 编辑中不挂拖拽源，避免拖动选中重命名文本时误触发节点拖拽
      ref={node.isEditing ? undefined : dragHandle}
      style={style}
      className={rowClass}
      onContextMenu={(event) => {
        // 拦截系统默认行为，改由文件树展示自定义菜单
        event.preventDefault()
        openContextMenu(event, node.data.path)
      }}
      onClick={() => {
        // 单击目录切换展开/折叠；文件的选择由行容器统一处理（onSelect 中打开）
        if (!node.isEditing && node.isInternal) {
          node.toggle()
        }
      }}
    >
      <span className="inline-flex w-4 shrink-0 items-center justify-center text-dim">
        {node.isInternal ? <ChevronIcon open={node.isOpen} /> : null}
      </span>
      <FileRow
        name={node.data.name}
        icon={node.data.isDirectory ? <FolderIcon /> : undefined}
        trailing={
          isDirty ? (
            <span
              className="ml-0.5 h-[7px] w-[7px] shrink-0 rounded-full bg-fg opacity-85"
              title="有未保存的更改"
            />
          ) : null
        }
        className="flex-1 gap-1"
      >
        {node.isEditing ? <RenameInput node={node} /> : undefined}
      </FileRow>
    </div>
  )
}

export default function FileTree({
  rootPath,
  selectedPath,
  dirtyPaths,
  onSelectFile,
  onBeforeEntryMove,
  onEntryMoved,
  onEntryDeleted
}: FileTreeProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)
  const { width, height } = useContainerSize(listRef)
  const treeRef = useRef<TreeApi<FileNode> | null>(null)

  const [treeData, setTreeData] = useState<FileNode[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 手动刷新进行中（防止重复触发）
  const [refreshing, setRefreshing] = useState(false)
  // 已发起过加载的目录集合（失败时移除，允许重试）
  const loadedDirsRef = useRef<Set<string>>(new Set())

  // 右键菜单：坐标 + 目标节点路径
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  // 名称搜索：查询词非空时，用主进程递归搜索的结果替换树数据，交由 react-arborist 过滤展示
  const [query, setQuery] = useState('')
  const [searchState, setSearchState] = useState<SearchState | null>(null)
  const searchSeqRef = useRef(0)
  const trimmedQuery = query.trim()
  const searchActive = trimmedQuery.length > 0
  // 当前查询词对应的结果；为空表示尚未产出（防抖或请求中，界面显示“搜索中”）
  const currentSearch = searchState && searchState.term === trimmedQuery ? searchState : null
  const searchPending = searchActive && currentSearch === null

  // 操作失败等临时提示自动消失
  useEffect(() => {
    if (!notice) {
      return
    }
    const timer = setTimeout(() => setNotice(null), NOTICE_TIMEOUT)
    return () => clearTimeout(timer)
  }, [notice])

  // 打开项目时读取根目录第一层，其余层级在展开时懒加载
  useEffect(() => {
    let cancelled = false
    window.api
      .readDirectory(rootPath)
      .then((entries) => {
        if (cancelled) {
          return
        }
        loadedDirsRef.current.add(rootPath)
        setTreeData(entries.map(toFileNode))
        setLoadError(null)
      })
      .catch((reason: unknown) => {
        if (cancelled) {
          return
        }
        setTreeData([])
        setLoadError(extractErrorMessage(reason))
      })
    return () => {
      cancelled = true
    }
  }, [rootPath])

  const loadChildren = useCallback(async (dirPath: string): Promise<void> => {
    const loaded = loadedDirsRef.current
    if (loaded.has(dirPath)) {
      return
    }
    loaded.add(dirPath)
    try {
      const entries = await window.api.readDirectory(dirPath)
      setTreeData((prev) => injectChildren(prev, dirPath, entries))
    } catch (reason) {
      loaded.delete(dirPath)
      setNotice(`读取目录失败：${extractErrorMessage(reason)}`)
    }
  }, [])

  // react-arborist 的 onToggle 在节点开合时都会触发，仅在首次展开时请求子项；
  // 搜索模式下子树已完整，无需懒加载
  const handleToggle = useCallback(
    (id: string): void => {
      if (searchActive) {
        return
      }
      void loadChildren(id)
    },
    [loadChildren, searchActive]
  )

  /** 重新读取已加载目录的最新内容（重命名/移动/删除后刷新树；未加载目录在展开时会自然读到最新内容） */
  const refreshDirectory = useCallback(
    async (dirPath: string): Promise<void> => {
      if (!loadedDirsRef.current.has(dirPath)) {
        return
      }
      const entries = await window.api.readDirectory(dirPath)
      // 根目录不是树数据中的节点（树数据即根目录的子项），需直接合并到顶层
      if (dirPath === rootPath) {
        setTreeData((prev) => mergeFileNodes(prev, entries))
        return
      }
      setTreeData((prev) => injectChildren(prev, dirPath, entries))
    },
    [rootPath]
  )

  /** 手动刷新：重新读取根目录与所有已加载目录的最新内容（外部工具改动磁盘后同步树） */
  const handleRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) {
      return
    }
    setRefreshing(true)
    try {
      const dirs = Array.from(loadedDirsRef.current)
      // 目录已在外部被删除时读取失败：仅移除其加载记录，由父目录的刷新将其从树上剔除
      const results = await Promise.all(
        dirs.map(async (dir) => {
          try {
            return { dir, entries: await window.api.readDirectory(dir) }
          } catch {
            return { dir, entries: null }
          }
        })
      )
      for (const { dir, entries } of results) {
        if (entries === null) {
          loadedDirsRef.current.delete(dir)
        }
      }
      setTreeData((prev) => {
        let next = prev
        for (const { dir, entries } of results) {
          if (entries === null) {
            continue
          }
          next =
            dir === rootPath ? mergeFileNodes(next, entries) : injectChildren(next, dir, entries)
        }
        return next
      })
    } finally {
      setRefreshing(false)
    }
  }, [refreshing, rootPath])

  /** 拖拽移动：react-arborist 已拦截拖入自身子树的情况，过滤模式（搜索）下拖拽被禁用 */
  const handleMove = useCallback(
    async ({ dragIds, parentId }: MoveArgs<FileNode>): Promise<void> => {
      const targetDir = parentId ?? rootPath
      for (const dragId of dragIds) {
        const targetPath = joinPath(targetDir, basename(dragId))
        if (targetPath === dragId) {
          continue // 位置未变（如同层排序：本实现按名称排序，不支持手动排序）
        }
        try {
          await onBeforeEntryMove(dragId)
          await window.api.moveEntry(dragId, targetPath)
          await refreshDirectory(dirname(dragId))
          await refreshDirectory(targetDir)
          onEntryMoved(dragId, targetPath)
        } catch (reason) {
          setNotice(`移动失败：${extractErrorMessage(reason)}`)
          return
        }
      }
    },
    [rootPath, onBeforeEntryMove, onEntryMoved, refreshDirectory]
  )

  /** 重命名：失败信息就地提示，本处理器不抛错（tree.submit 会等待其完成并退出编辑态） */
  const handleRename = useCallback(
    async ({ id, name }: RenameArgs<FileNode>): Promise<void> => {
      const newName = name.trim()
      if (!newName || newName === basename(id)) {
        return
      }
      if (newName.includes('/') || newName.includes('\\')) {
        setNotice('名称不能包含路径分隔符')
        return
      }
      const parentDir = dirname(id)
      const targetPath = joinPath(parentDir, newName)
      try {
        await onBeforeEntryMove(id)
        await window.api.moveEntry(id, targetPath)
        await refreshDirectory(parentDir)
        onEntryMoved(id, targetPath)
      } catch (reason) {
        setNotice(`重命名失败：${extractErrorMessage(reason)}`)
      }
    },
    [onBeforeEntryMove, onEntryMoved, refreshDirectory]
  )

  const handleSelect = useCallback(
    (nodes: NodeApi<FileNode>[]): void => {
      const node = nodes[0]
      if (node && !node.data.isDirectory) {
        onSelectFile(node.data)
      }
    },
    [onSelectFile]
  )

  // F2 重命名选中的节点（Enter 重命名为 react-arborist 内置行为）
  const handleKeyDown = useCallback((event: React.KeyboardEvent): void => {
    if (event.key !== 'F2') {
      return
    }
    const tree = treeRef.current
    const node = tree?.focusedNode ?? tree?.mostRecentNode
    if (node && node.isEditable) {
      event.preventDefault()
      void node.edit()
    }
  }, [])

  /** 打开右键菜单：坐标贴近鼠标，贴边修正由 ContextMenu 组件完成 */
  const openContextMenu = useCallback((event: React.MouseEvent, path: string): void => {
    setContextMenu({ x: event.clientX, y: event.clientY, path })
  }, [])

  /** 菜单操作：重命名（复用行内编辑；节点可能因刷新失效，按路径回查） */
  const handleMenuRename = useCallback((targetPath: string): void => {
    const node = treeRef.current?.get(targetPath)
    if (node && node.isEditable) {
      void node.edit()
    }
  }, [])

  /** 菜单操作：删除（确认框在主进程；确认后刷新父目录并通知外部清理编辑状态） */
  const handleMenuDelete = useCallback(
    async (targetPath: string): Promise<void> => {
      try {
        const deleted = await window.api.deleteEntry(targetPath)
        if (!deleted) {
          return // 用户在确认框中取消
        }
        // 清除被删目录的加载记录，避免重建同名目录后不再触发懒加载
        for (const dir of loadedDirsRef.current) {
          if (isAtOrUnder(dir, targetPath)) {
            loadedDirsRef.current.delete(dir)
          }
        }
        await refreshDirectory(dirname(targetPath))
        onEntryDeleted(targetPath)
      } catch (reason) {
        setNotice(`删除失败：${extractErrorMessage(reason)}`)
      }
    },
    [refreshDirectory, onEntryDeleted]
  )

  // 查询词变化：防抖后请求主进程递归搜索，并构造“命中条目 + 祖先目录”的子树
  useEffect(() => {
    if (!searchActive) {
      searchSeqRef.current += 1 // 使在途请求失效，避免清除查询后旧结果回填
      return
    }
    const timer = setTimeout(() => {
      const seq = ++searchSeqRef.current
      window.api
        .searchFiles(rootPath, trimmedQuery, SEARCH_RESULT_LIMIT)
        .then((result) => {
          if (seq !== searchSeqRef.current) {
            return
          }
          setSearchState({
            term: trimmedQuery,
            entries: buildSearchTree(rootPath, result.entries),
            truncated: result.truncated,
            error: null
          })
        })
        .catch((reason: unknown) => {
          if (seq !== searchSeqRef.current) {
            return
          }
          setSearchState({
            term: trimmedQuery,
            entries: [],
            truncated: false,
            error: extractErrorMessage(reason)
          })
        })
    }, SEARCH_DEBOUNCE)
    return () => clearTimeout(timer)
  }, [searchActive, trimmedQuery, rootPath])

  let searchStateText: string | null = null
  if (searchPending) {
    searchStateText = '搜索中…'
  } else if (currentSearch) {
    if (currentSearch.error) {
      searchStateText = `搜索失败：${currentSearch.error}`
    } else if (currentSearch.entries.length === 0) {
      searchStateText = '没有匹配的结果'
    }
  }

  // 右键菜单条目（数据驱动）。扩展点：后续「发送给 AI」等操作在此数组追加即可
  let contextMenuEntries: ContextMenuEntry[] = []
  if (contextMenu) {
    const targetPath = contextMenu.path
    contextMenuEntries = [
      {
        id: 'rename',
        label: '重命名',
        disabled: searchActive,
        disabledReason: '搜索模式下不可用',
        onSelect: () => handleMenuRename(targetPath)
      },
      {
        id: 'delete',
        label: '删除',
        disabled: searchActive,
        disabledReason: '搜索模式下不可用',
        onSelect: () => void handleMenuDelete(targetPath)
      }
    ]
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <input
          type="text"
          className="min-w-0 flex-1 cursor-text rounded-[3px] border border-line bg-base px-2 py-[3px] font-[inherit] text-[12px] text-fg outline-none transition-colors placeholder:text-dim focus:border-accent-hover"
          value={query}
          placeholder="搜索文件"
          spellCheck={false}
          aria-label="搜索文件"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('')
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent p-0 text-[14px] leading-none text-dim transition-colors hover:bg-hover hover:text-fg"
            aria-label="清空搜索"
            title="清空搜索"
            onClick={() => setQuery('')}
          >
            ×
          </button>
        ) : null}
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent p-0 text-dim transition-colors enabled:hover:bg-hover enabled:hover:text-fg disabled:cursor-default disabled:opacity-50"
          aria-label="刷新文件树"
          title="刷新文件树"
          disabled={refreshing}
          onClick={() => void handleRefresh()}
        >
          <RefreshIcon />
        </button>
      </div>
      {notice ? (
        <p className="m-0 shrink-0 border-b border-line bg-[color-mix(in_srgb,var(--error)_12%,transparent)] px-2.5 py-1 break-all text-danger">
          {notice}
        </p>
      ) : null}
      {currentSearch?.truncated ? (
        <p className="m-0 shrink-0 border-b border-line px-2.5 py-1 text-dim">
          仅显示前 {SEARCH_RESULT_LIMIT} 个匹配，请细化关键词
        </p>
      ) : null}
      <div
        ref={listRef}
        className="relative min-h-0 flex-1 overflow-hidden py-1.5"
        onKeyDown={handleKeyDown}
      >
        {loadError ? (
          <p className="mx-3 my-4 break-all leading-[1.6] text-danger">无法读取目录：{loadError}</p>
        ) : width > 0 && height > 0 ? (
          <DirtyPathsContext.Provider value={dirtyPaths}>
            <OpenContextMenuContext.Provider value={openContextMenu}>
              <Tree<FileNode>
                ref={treeRef}
                data={searchActive ? (currentSearch?.entries ?? []) : treeData}
                idAccessor="path"
                childrenAccessor="children"
                width={width}
                height={height}
                rowHeight={ROW_HEIGHT}
                indent={INDENT}
                // 目录默认折叠：懒加载下展开时才请求子项（react-arborist 默认值为 true，会导致首次点击只折叠不展开）
                openByDefault={false}
                searchTerm={searchActive ? trimmedQuery : undefined}
                disableDrag={searchActive}
                disableEdit={searchActive}
                disableMultiSelection
                selection={selectedPath ?? undefined}
                onMove={handleMove}
                onRename={handleRename}
                onToggle={handleToggle}
                onSelect={handleSelect}
                aria-label="项目文件树"
              >
                {TreeNode}
              </Tree>
            </OpenContextMenuContext.Provider>
          </DirtyPathsContext.Provider>
        ) : null}
        {!loadError && searchStateText ? (
          <p className="pointer-events-none absolute inset-0 m-0 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_72%,transparent)] p-4 text-center text-dim">
            {searchStateText}
          </p>
        ) : null}
      </div>
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entries={contextMenuEntries}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  )
}
