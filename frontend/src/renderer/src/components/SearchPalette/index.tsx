import { useEffect, useRef, useState } from 'react'
import { CaseSensitive, Regex, Search, WholeWord } from 'lucide-react'
import { createSearchMatcher } from '@shared/files/types'
import type { ContentSearchMatch, FileEntry, SearchOptions } from '@shared/files/types'
import { extractErrorMessage } from '../../lib/errorMessage'
import {
  basename,
  isAbsolutePath,
  pathSeparator,
  relativePath,
  relativePathNative
} from '../../lib/filePath'
import FileRow from '../FileRow'
import { Button } from '../ui/button'

export type SearchPaletteMode = 'files' | 'content'

interface SearchPaletteProps {
  rootPath: string
  mode: SearchPaletteMode
  onClose: () => void
  onOpenFile: (path: string, line?: number) => void
  replaceMode?: boolean
}

const DEBOUNCE_MS = 200
const FILE_LIMIT = 100

function HighlightedText({
  text,
  matcher
}: {
  text: string
  matcher: RegExp | null
}): React.JSX.Element {
  if (matcher === null) return <>{text}</>
  const localMatcher = new RegExp(matcher.source, matcher.flags)
  const parts: React.ReactNode[] = []
  let start = 0
  let match: RegExpExecArray | null
  while ((match = localMatcher.exec(text)) !== null) {
    if (match.index > start) parts.push(text.slice(start, match.index))
    if (match[0].length > 0) {
      parts.push(
        <mark
          key={match.index}
          className="rounded-[2px] border border-[var(--search-match-border)] bg-[var(--search-match)] px-0.5 font-semibold text-inherit"
        >
          {match[0]}
        </mark>
      )
    }
    start = match.index + match[0].length
    if (match[0].length === 0) localMatcher.lastIndex += 1
  }
  if (start < text.length) parts.push(text.slice(start))
  return <>{parts}</>
}

/** 项目名称与内容的快捷搜索面板。 */
export default function SearchPalette({
  rootPath,
  mode,
  onClose,
  onOpenFile,
  replaceMode = false
}: SearchPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [replaceNotice, setReplaceNotice] = useState<string | null>(null)
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false
  })
  const [files, setFiles] = useState<FileEntry[]>([])
  const [matches, setMatches] = useState<ContentSearchMatch[]>([])
  const [searchPending, setSearchPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [selected, setSelected] = useState(0)
  const [searchVersion, setSearchVersion] = useState(0)
  const requestRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resultsRef = useRef<HTMLDivElement | null>(null)
  const trimmed = query.trim()
  const count = mode === 'files' ? files.length : matches.length
  let matcher: RegExp | null = null
  let invalidRegex = false
  if (trimmed) {
    try {
      matcher = createSearchMatcher(trimmed, options)
    } catch {
      invalidRegex = true
    }
  }
  const toggleOption = (key: keyof SearchOptions): void => {
    requestRef.current += 1
    setOptions((current) => ({ ...current, [key]: !current[key] }))
    setFiles([])
    setMatches([])
    setSelected(0)
    setTruncated(false)
    setError(null)
    setSearchPending(trimmed.length > 0)
  }
  const pending = trimmed.length > 0 && !invalidRegex && searchPending
  const changeQuery = (value: string): void => {
    requestRef.current += 1
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    setQuery(value)
    setSelected(0)
    setFiles([])
    setMatches([])
    setError(null)
    setTruncated(false)
    setSearchPending(value.trim().length > 0)
  }

  useEffect(() => {
    const request = ++requestRef.current
    if (!trimmed || invalidRegex) return
    timerRef.current = setTimeout(() => {
      const search =
        mode === 'files'
          ? window.api.searchFiles(rootPath, trimmed, FILE_LIMIT, options).then((result) => {
              if (request !== requestRef.current) return
              setFiles(result.entries.filter((entry) => !entry.isDirectory))
              setMatches([])
              setTruncated(result.truncated)
              setSelected(0)
            })
          : window.api.searchFileContents(rootPath, trimmed, options).then((result) => {
              if (request !== requestRef.current) return
              setMatches(result.matches)
              setFiles([])
              setTruncated(result.truncated)
              setSelected(0)
            })
      void search
        .catch((reason: unknown) => {
          if (request !== requestRef.current) return
          setFiles([])
          setMatches([])
          setError(extractErrorMessage(reason))
        })
        .finally(() => {
          if (request === requestRef.current) setSearchPending(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [mode, rootPath, trimmed, options, invalidRegex, searchVersion])

  const replaceMatches = async (selectedOnly: boolean): Promise<void> => {
    if (replacing || invalidRegex || !trimmed || matches.length === 0) return
    const targets = selectedOnly
      ? [matches[selected]].filter((match) => match !== undefined)
      : matches
    if (targets.length === 0) return
    const count = new Set(targets.map((match) => match.path)).size
    const action = selectedOnly ? '替换此结果所在行' : `替换 ${count} 个文件中的搜索结果`
    if (!window.confirm(`${action}为“${replacement}”？\n此操作会直接修改磁盘文件。`)) return
    setReplacing(true)
    setError(null)
    setReplaceNotice(null)
    try {
      const result = await window.api.replaceFileContents(
        rootPath,
        trimmed,
        replacement,
        options,
        targets
      )
      setReplaceNotice(`已替换 ${result.replacements} 处，涉及 ${result.filesChanged} 个文件`)
      setMatches([])
      requestRef.current += 1
      setSearchPending(true)
      // 触发重新搜索，防止已替换结果再次执行。
      setSearchVersion((version) => version + 1)
    } catch (reason: unknown) {
      setError(extractErrorMessage(reason))
    } finally {
      setReplacing(false)
    }
  }

  const moveSelection = (direction: -1 | 1): void => {
    const next = Math.max(0, Math.min(selected + direction, count - 1))
    setSelected(next)
    const item = resultsRef.current?.querySelector<HTMLElement>(`[data-result-index="${next}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }

  const openSelected = (index: number): void => {
    if (mode === 'files') {
      const file = files[index]
      if (file) onOpenFile(file.path)
    } else {
      const match = matches[index]
      if (match) onOpenFile(match.path, match.line)
    }
    if (index >= 0 && index < count) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center bg-black/30 pt-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'files' ? '查找文件' : '在文件中查找'}
        className="flex max-h-[70vh] w-[min(680px,90vw)] flex-col overflow-hidden rounded-md border border-line bg-elevated shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3">
          <Search className="size-4 shrink-0 text-dim" />
          <input
            autoFocus
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                moveSelection(1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                moveSelection(-1)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                openSelected(selected)
              }
            }}
            placeholder={mode === 'files' ? '按名称查找文件…' : '在项目文件中搜索内容…'}
            className="h-11 min-w-0 flex-1 bg-transparent font-[inherit] text-[14px] text-fg outline-none placeholder:text-dim"
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex shrink-0 items-center gap-0.5">
            {(
              [
                ['caseSensitive', '大小写匹配', CaseSensitive],
                ['wholeWord', '全字匹配', WholeWord],
                ['regex', '使用正则表达式', Regex]
              ] as const
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={options[key]}
                onClick={() => toggleOption(key)}
                className={`cursor-pointer rounded p-1 transition-colors hover:bg-hover ${options[key] ? 'bg-selection text-accent-hover' : 'text-dim'}`}
              >
                <Icon className="size-4" color="currentColor" strokeWidth={1} />
              </button>
            ))}
          </div>
          <kbd className="rounded border border-line px-1.5 py-0.5 text-[11px] text-dim">Esc</kbd>
        </div>
        {replaceMode ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3">
            <input
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              placeholder="替换为…"
              aria-label="替换为"
              className="h-9 min-w-0 flex-1 bg-transparent font-[inherit] text-[13px] text-fg outline-none placeholder:text-dim"
              spellCheck={false}
              autoComplete="off"
            />
            <Button
              size="xs"
              variant="outline"
              disabled={replacing || count === 0 || invalidRegex}
              onClick={() => void replaceMatches(true)}
            >
              替换
            </Button>
            <Button
              size="xs"
              disabled={replacing || count === 0 || invalidRegex}
              onClick={() => void replaceMatches(false)}
            >
              全部替换
            </Button>
          </div>
        ) : null}
        {replaceNotice ? (
          <p className="shrink-0 border-b border-line px-3 py-1.5 text-[12px] text-fg">
            {replaceNotice}
          </p>
        ) : null}
        <div ref={resultsRef} className="min-h-20 overflow-y-auto p-1.5">
          {invalidRegex ? (
            <p className="px-3 py-6 text-center text-danger">正则表达式无效，请检查语法</p>
          ) : !trimmed ? (
            <p className="px-3 py-6 text-center text-dim">
              {mode === 'files'
                ? '输入文件名，回车打开'
                : replaceMode
                  ? '输入文本，预览后可替换当前结果'
                  : '输入文本，在项目中查找匹配行'}
            </p>
          ) : error ? (
            <p className="px-3 py-6 text-center text-danger">搜索失败：{error}</p>
          ) : count === 0 ? (
            <p className="px-3 py-6 text-center text-dim">
              {pending ? '搜索中…' : '没有匹配的结果'}
            </p>
          ) : (
            <ul className="m-0 list-none p-0">
              {mode === 'files'
                ? files.map((file, index) => {
                    const pathQuery = trimmed.replace(/[./\\]+/gu, pathSeparator(rootPath))
                    const displayName = isAbsolutePath(pathQuery)
                      ? file.path
                      : pathQuery.includes(pathSeparator(rootPath))
                        ? relativePathNative(file.path, rootPath)
                        : file.name
                    return (
                      <li key={file.path} data-result-index={index}>
                        <button
                          type="button"
                          title={relativePath(file.path, rootPath)}
                          className={`h-6 w-full cursor-pointer rounded px-2 text-left whitespace-nowrap select-none hover:bg-hover ${selected === index ? 'bg-selection' : ''}`}
                          onMouseEnter={() => setSelected(index)}
                          onClick={() => openSelected(index)}
                        >
                          <FileRow name={file.name} className="gap-1">
                            <span className="min-w-0 truncate">
                              <HighlightedText text={displayName} matcher={matcher} />
                            </span>
                          </FileRow>
                        </button>
                      </li>
                    )
                  })
                : matches.map((match, index) => (
                    <li key={`${match.path}:${match.line}:${index}`} data-result-index={index}>
                      <button
                        type="button"
                        className={`w-full cursor-pointer rounded px-2 py-1.5 text-left ${selected === index ? 'bg-hover' : ''}`}
                        onMouseEnter={() => setSelected(index)}
                        onClick={() => openSelected(index)}
                      >
                        <span className="block truncate text-[13px] text-fg">
                          <HighlightedText text={match.text || '(空白行)'} matcher={matcher} />
                        </span>
                        <span className="block truncate text-[11px] text-dim">
                          {basename(match.path)}:{match.line} · {relativePath(match.path, rootPath)}
                        </span>
                      </button>
                    </li>
                  ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 justify-between border-t border-line px-3 py-1.5 text-[11px] text-dim">
          <span>{truncated ? `仅显示前 ${count} 条，请细化关键词` : `${count} 条结果`}</span>
          <span>
            {replaceMode ? '替换前会确认，仅处理当前展示的结果行' : '↑↓ 选择 · Enter 打开'}
          </span>
        </div>
      </div>
    </div>
  )
}
