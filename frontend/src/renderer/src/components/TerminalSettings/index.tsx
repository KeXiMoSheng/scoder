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
 * PS7 的安装位置随安装方式而异（MSI、Store、zip、自定义目录），不做自动探测；
 * 不配置时一律使用 Windows 自带的 5.1。
 */
export default function TerminalSettings(): React.JSX.Element {
  const [path, setPath] = useState(DEFAULT_TERMINAL_SETTINGS.powershellPath)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  // 首屏加载：在异步回调里更新状态，避免 effect 内同步触发级联渲染
  useEffect(() => {
    let active = true
    window.api
      .getTerminalSettings()
      .then((settings) => {
        if (active) {
          setPath(settings.powershellPath)
        }
      })
      .catch((reason) => {
        if (active) {
          setError(extractErrorMessage(reason))
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [])

  const updatePath = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    setPath(event.target.value)
    setSaved(false)
    setTestResult(null)
  }, [])

  const browse = useCallback(async (): Promise<void> => {
    if (browsing) {
      return
    }
    setBrowsing(true)
    setError(null)
    try {
      const picked = await window.api.browsePowerShellPath()
      if (picked !== null) {
        setPath(picked)
        setSaved(false)
        setTestResult(null)
      }
    } catch (reason) {
      setError(extractErrorMessage(reason))
    } finally {
      setBrowsing(false)
    }
  }, [browsing])

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
          为内置终端与 AI 的命令工具指定 PowerShell 7。安装位置随安装方式而异，请手动选择其中的
          pwsh.exe；不指定时一律使用 Windows 自带的 5.1。
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
              指定后，新打开的终端与之后发起的 AI 命令都会使用该 PowerShell。
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
                    onClick={() => void browse()}
                    disabled={browsing}
                  >
                    {browsing ? '选择中…' : '浏览…'}
                  </Button>
                </div>
                <FieldDescription>
                  留空表示不使用 PowerShell 7，始终回退 Windows 自带的
                  5.1。修改后对之后打开的终端与新的命令调用生效。
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
