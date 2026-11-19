import { useCallback, useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { extractErrorMessage } from '../../lib/errorMessage'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Skeleton } from '../ui/skeleton'
import { DEFAULT_TERMINAL_SETTINGS, POWERSHELL_DOWNLOAD_URL } from '@shared/terminal/settings'
import type { ChangeEvent, FormEvent } from 'react'

/** 测试按钮的结果：成功展示版本号，失败展示原因 */
interface TestResult {
  ok: boolean
  text: string
}

/**
 * 终端设置分区：指定 PowerShell 7 的安装路径，并提供实际启动测试。
 * 打开设置页时会从 PATH 与常见安装目录自动探测 pwsh.exe 并预先填入；
 * 留空时运行时仍回退 Windows 自带的 5.1。
 */
export default function TerminalSettings(): React.JSX.Element {
  const [path, setPath] = useState(DEFAULT_TERMINAL_SETTINGS.powershellPath)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  // 首屏加载：没有保存路径时用自动探测结果预填，方便用户看到可用的 PowerShell 7
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const settings = await window.api.getTerminalSettings()
        if (!active) {
          return
        }
        if (settings.powershellPath.trim().length > 0) {
          setPath(settings.powershellPath)
          return
        }
        // 探测只是辅助：失败时保持留空，运行时照常回退 5.1
        const detected = await window.api.detectPowerShellPath().catch(() => null)
        if (active) {
          setPath(detected ?? '')
        }
      } catch (reason) {
        if (active) {
          setError(extractErrorMessage(reason))
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const updatePath = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    setPath(event.target.value)
    setSaved(false)
    setTestResult(null)
  }, [])

  // 与文件树的「在文件资源管理器中显示」共用 revealEntry：
  // 浏览按钮直接打开系统文件管理器并选中当前路径
  const browse = useCallback(async (): Promise<void> => {
    const target = path.trim()
    if (target.length === 0) {
      return
    }
    setError(null)
    try {
      await window.api.revealEntry(target)
    } catch (reason) {
      setError(extractErrorMessage(reason))
    }
  }, [path])

  // 测试不要求先保存：输入框里的路径直接拿去启动，方便边选边试
  const test = useCallback(async (): Promise<void> => {
    const trimmed = path.trim()
    if (testing || trimmed.length === 0) {
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const version = await window.api.testPowerShellPath(trimmed)
      setTestResult({ ok: true, text: `可用，版本 ${version}` })
    } catch (reason) {
      setTestResult({ ok: false, text: extractErrorMessage(reason) })
    } finally {
      setTesting(false)
    }
  }, [path, testing])

  const openDownload = useCallback(async (): Promise<void> => {
    if (opening) {
      return
    }
    setOpening(true)
    setError(null)
    try {
      await window.api.openPowerShellDownload()
    } catch (reason) {
      setError(extractErrorMessage(reason))
    } finally {
      setOpening(false)
    }
  }, [opening])

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      if (saving) {
        return
      }
      setSaving(true)
      setError(null)
      try {
        // 主进程会再校验一遍，落库后的值才是最终值
        const applied = await window.api.saveTerminalSettings({ powershellPath: path.trim() })
        setPath(applied.powershellPath)
        setSaved(true)
      } catch (reason) {
        setError(extractErrorMessage(reason))
      } finally {
        setSaving(false)
      }
    },
    [path, saving]
  )

  const resetDefaults = useCallback((): void => {
    setPath(DEFAULT_TERMINAL_SETTINGS.powershellPath)
    setSaved(false)
    setTestResult(null)
    setError(null)
  }, [])

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">终端</h1>
        <p className="mt-1 leading-[1.6] text-dim">
          为内置终端与 AI 的命令工具指定 PowerShell 7。打开本页时会自动探测系统中的 pwsh.exe
          并填入路径；没有探测到时也可以手动选择，留空则一律使用 Windows 自带的 5.1。
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 leading-[1.6] text-danger">
          {error}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <Card className="gap-5 py-5">
          <CardHeader>
            <CardTitle className="text-sm">PowerShell 7</CardTitle>
            <CardDescription className="text-[12px]">
              自动探测到的 pwsh.exe 会预先填入；留空则回退系统自带的 PowerShell 5.1。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor="terminal-powershell-path">pwsh.exe 路径</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="terminal-powershell-path"
                    value={path}
                    placeholder="例如 C:\Program Files\PowerShell\7\pwsh.exe"
                    onChange={updatePath}
                    spellCheck={false}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    title="在文件资源管理器中显示并选中当前路径"
                    disabled={path.trim().length === 0}
                    onClick={() => void browse()}
                  >
                    浏览…
                  </Button>
                </div>
                <FieldDescription>
                  留空表示不使用 PowerShell 7，始终回退 Windows 自带的 5.1。打开本页时会自动填入
                  探测到的路径；「浏览…」会在系统文件管理器中显示并选中当前路径。修改后对之后打开的
                  终端与新的命令调用生效。
                </FieldDescription>
              </Field>

              <Field>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void test()}
                    disabled={testing || path.trim().length === 0}
                  >
                    {testing ? '测试中…' : '测试'}
                  </Button>
                  {testResult ? (
                    <span className={testResult.ok ? 'text-xs text-fg' : 'text-xs text-danger'}>
                      {testResult.text}
                    </span>
                  ) : null}
                </div>
                <FieldDescription>
                  会实际启动一次该 PowerShell 并读取版本号；未保存的路径也可以先测试。
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel>没有安装 PowerShell 7？</FieldLabel>
                <FieldDescription>
                  到 GitHub Releases 下载安装包或便携版，解压后在上方选择其中的 pwsh.exe。
                </FieldDescription>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto justify-start p-0 text-[12px]"
                  title={POWERSHELL_DOWNLOAD_URL}
                  disabled={opening}
                  onClick={() => void openDownload()}
                >
                  <ExternalLink />
                  <span className="truncate">{POWERSHELL_DOWNLOAD_URL}</span>
                </Button>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
          <Button type="button" variant="outline" onClick={resetDefaults} disabled={saving}>
            恢复默认
          </Button>
          {saved ? <span className="text-xs text-dim">已保存</span> : null}
        </div>
      </form>
    </div>
  )
}
