import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Download, Trash2 } from 'lucide-react'
import type { ThemeImportResult } from '@shared/theme/types'
import { useTheme } from '../../hooks/useTheme'
import { extractErrorMessage } from '../../lib/errorMessage'
import { syncImportedThemes } from '../../lib/theme'
import type { AppTheme } from '../../lib/theme'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'

/** 行内代码样式：设置页里的路径/文件名统一用它，避免重复长类名 */
const INLINE_CODE_CLASS = 'rounded bg-base px-1 py-0.5 font-mono text-[11px] text-fg'

function InlineCode({ children }: { children: ReactNode }): React.JSX.Element {
  return <code className={INLINE_CODE_CLASS}>{children}</code>
}

interface ThemeRowProps {
  theme: AppTheme
  active: boolean
  deleting: boolean
  onApply: () => void
  onDelete?: () => void
}

/** 单套主题行：色板 + 名称/来源 + 应用/删除 */
function ThemeRow({
  theme,
  active,
  deleting,
  onApply,
  onDelete
}: ThemeRowProps): React.JSX.Element {
  const imported = theme.origin === 'imported'
  return (
    <li className="flex items-center gap-3 px-6 py-3">
      <span className="flex shrink-0 overflow-hidden rounded border border-line" aria-hidden="true">
        {[theme.vars['--bg'], theme.vars['--accent'], theme.vars['--text']].map((color, index) => (
          <span key={index} className="size-4" style={{ backgroundColor: color }} />
        ))}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-fg">{theme.label}</span>
          {imported ? (
            <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-dim">
              导入
            </span>
          ) : null}
          {active ? (
            <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-dim">
              <Check className="size-3" />
              使用中
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-dim">
          {theme.kind === 'dark' ? '深色' : '浅色'}
          {imported
            ? ` · 来源 ${theme.sourceName ?? '未知'}${theme.importedAt ? ` · ${formatImportedAt(theme.importedAt)}` : ''}`
            : ' · 内置主题'}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {active ? null : (
          <Button size="sm" variant="outline" onClick={onApply}>
            应用
          </Button>
        )}
        {imported && onDelete ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            disabled={deleting}
            onClick={onDelete}
          >
            <Trash2 />
            {deleting ? '删除中…' : '删除'}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/** 导入时间只展示到天，避免设置页出现冗长的 ISO 字符串 */
function formatImportedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/**
 * 设置 → 主题：展示内置与导入主题，支持导入 VS Code 主题文件/扩展包并即时切换。
 * 导入主题由主进程解析转换后写入 userData/themes，渲染进程只负责注册与展示。
 */
export default function ThemeSettings(): React.JSX.Element {
  const { themeId, setThemeId, themes } = useTheme()
  const [importing, setImporting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [result, setResult] = useState<ThemeImportResult | null>(null)
  const [appliedLabel, setAppliedLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const importedCount = themes.filter((theme) => theme.origin === 'imported').length

  const handleImport = useCallback(async (): Promise<void> => {
    if (importing) {
      return
    }
    setImporting(true)
    setError(null)
    setResult(null)
    setAppliedLabel(null)
    try {
      const outcome = await window.api.importThemes()
      if (outcome.canceled) {
        return
      }
      // 先让主进程的落盘结果进入主题目录（菜单同步更新），再切换第一套导入主题
      await syncImportedThemes()
      setResult(outcome)
      const first = outcome.themes[0]
      if (first) {
        setThemeId(first.id)
        setAppliedLabel(first.label)
      }
    } catch (reason) {
      setError(extractErrorMessage(reason))
    } finally {
      setImporting(false)
    }
  }, [importing, setThemeId])

  const handleDelete = useCallback(async (id: string): Promise<void> => {
    setDeletingId(id)
    setError(null)
    setResult(null)
    try {
      const deleted = await window.api.deleteImportedTheme(id)
      if (deleted) {
        // 删除的是当前主题时，syncImportedThemes 会回退到内置主题
        await syncImportedThemes()
      }
    } catch (reason) {
      setError(extractErrorMessage(reason))
    } finally {
      setDeletingId(null)
    }
  }, [])

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">主题</h1>
        <p className="mt-1 leading-[1.6] text-dim">
          导入 VS Code
          主题并应用到编辑器与界面配色。导入后的主题会立即出现在标题栏的「主题」菜单中，可随时切换。
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 leading-[1.6] text-danger">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="rounded-md border border-line bg-elevated px-3 py-2 text-[12px] leading-[1.7]">
          <div className="text-fg">
            {result.themes.length > 0
              ? `已导入 ${result.themes.length} 套主题${appliedLabel ? `，并切换到「${appliedLabel}」` : ''}。`
              : '没有导入任何主题。'}
          </div>
          {result.errors.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-0.5">
              {result.errors.map((item) => (
                <li key={`${item.file}-${item.message}`} className="text-danger">
                  {item.file}：{item.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <Card className="gap-5 py-5">
        <CardHeader>
          <CardTitle className="text-sm">导入主题</CardTitle>
          <CardDescription className="text-[12px]">
            支持 VS Code 配色主题文件（.json /
            .jsonc）与主题扩展包（.vsix），可一次选择多个文件；扩展包内的全部主题会一起导入。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => void handleImport()} disabled={importing}>
              <Download />
              {importing ? '导入中…' : '选择主题文件…'}
            </Button>
            <span className="text-xs text-dim">导入后自动切换到第一套主题</span>
          </div>
          <div className="rounded-md border border-line bg-hover px-3.5 py-3 text-[12px] leading-[1.7]">
            <p className="font-medium text-fg">怎么导出 VS Code 的主题</p>

            <p className="mt-2 font-medium text-dim">方式一：导出 VSIX（推荐）</p>
            <ol className="mt-1 flex list-decimal flex-col gap-1 pl-4 text-dim">
              <li>在 VS Code 左侧打开「扩展」视图，找到已安装的主题扩展。</li>
              <li>
                右键该扩展 →「Download VSIX」（中文界面为「下载 VSIX」）；没有这一项就看下一步。
              </li>
              <li>
                在浏览器打开主题的 Marketplace 页面，点击右侧 Resources 区域的下载链接（Download
                Extension），同样会下载 .vsix。
              </li>
              <li>回到本页点击「选择主题文件…」，选中刚下载的 .vsix，包内全部主题会一起导入。</li>
            </ol>

            <p className="mt-2 font-medium text-dim">方式二：直接使用本机已安装的主题</p>
            <ol className="mt-1 flex list-decimal flex-col gap-1 pl-4 text-dim">
              <li>
                在 VS Code 命令面板（Ctrl/Cmd+Shift+P）运行「Developer: Open Extensions
                Folder」，即可在文件管理器中打开扩展目录。
              </li>
              <li>
                进入主题扩展文件夹（目录名形如
                <InlineCode>publisher.theme-name-版本号</InlineCode>），选择其中的{' '}
                <InlineCode>package.json</InlineCode>（按清单导入该扩展声明的全部主题），或{' '}
                <InlineCode>themes/</InlineCode> 下的 <InlineCode>.json</InlineCode> /{' '}
                <InlineCode>.jsonc</InlineCode> 文件。
              </li>
            </ol>
            <p className="mt-1.5 text-dim">扩展目录也可以手动打开：</p>
            <p className="mt-1 text-dim">
              VS Code（正式版）：Windows <InlineCode>%USERPROFILE%\.vscode\extensions</InlineCode>
              ，macOS / Linux <InlineCode>~/.vscode/extensions</InlineCode>。
            </p>
            <p className="mt-1 text-dim">
              VS Code Insiders（预览版，扩展目录与正式版相互独立）：Windows{' '}
              <InlineCode>%USERPROFILE%\.vscode-insiders\extensions</InlineCode>，macOS / Linux{' '}
              <InlineCode>~/.vscode-insiders/extensions</InlineCode>。
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="gap-5 py-5">
        <CardHeader>
          <CardTitle className="text-sm">已安装主题</CardTitle>
          <CardDescription className="text-[12px]">
            内置 {themes.length - importedCount} 套，导入 {importedCount}{' '}
            套。导入的主题只保存在本机，随时可以删除。
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="divide-y divide-line border-t border-line">
            {themes.map((theme) => (
              <ThemeRow
                key={theme.id}
                theme={theme}
                active={theme.id === themeId}
                deleting={deletingId === theme.id}
                onApply={() => setThemeId(theme.id)}
                onDelete={
                  theme.origin === 'imported' ? () => void handleDelete(theme.id) : undefined
                }
              />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
