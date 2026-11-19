import { useCallback, useEffect, useState } from 'react'
import { extractErrorMessage } from '../../lib/errorMessage'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Skeleton } from '../ui/skeleton'
import { DEFAULT_GIT_SETTINGS } from '@shared/git/settings'
import type { ChangeEvent, FormEvent } from 'react'

/** 测试按钮的结果：成功展示版本号，失败展示原因 */
interface TestResult {
  ok: boolean
  text: string
}

/**
 * Git 设置分区：指定 git 可执行文件，并提供版本测试。
 *
 * 打开本页时会自动探测系统中的 git 并预填路径；留空仍表示使用 PATH 上的 git，
 * 只有想固定某个版本（或 PATH 里没有 git）时才需要手动指定。
 */
export default function GitSettings(): React.JSX.Element {
  const [path, setPath] = useState(DEFAULT_GIT_SETTINGS.gitPath)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  // 首屏加载：没有保存路径时用自动探测结果预填，方便用户看到实际使用的 git
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const settings = await window.api.getGitSettings()
        if (!active) {
          return
        }
        if (settings.gitPath.trim().length > 0) {
          setPath(settings.gitPath)
          return
        }
        // 探测只是辅助：失败时保持留空，仍可在 PATH 上自动使用 git
        const detected = await window.api.detectGitPath().catch(() => null)
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

  // 测试不要求先保存：输入框里的路径直接拿去运行，方便边选边试；留空时测试自动探测的 git
  const test = useCallback(async (): Promise<void> => {
    if (testing) {
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const info = await window.api.testGitPath(path.trim())
      setTestResult({ ok: true, text: `可用，版本 ${info.version}（${info.file}）` })
    } catch (reason) {
      setTestResult({ ok: false, text: extractErrorMessage(reason) })
    } finally {
      setTesting(false)
    }
  }, [path, testing])

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
        const applied = await window.api.saveGitSettings({ gitPath: path.trim() })
        setPath(applied.gitPath)
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
    setPath(DEFAULT_GIT_SETTINGS.gitPath)
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
        <h1 className="text-lg font-semibold text-fg">Git</h1>
        <p className="mt-1 leading-[1.6] text-dim">
          文件树会用 Git 标记新增、修改与删除的文件。打开本页时会自动探测系统中的 git
          并填入路径；留空仍表示使用 PATH 上的 git，也可以手动指定可执行文件。
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
            <CardTitle className="text-sm">Git 可执行文件</CardTitle>
            <CardDescription className="text-[12px]">
              自动探测到的路径会预先填入；留空则使用 PATH 上的 git。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor="git-executable-path">git 路径</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="git-executable-path"
                    value={path}
                    placeholder="留空自动探测；例如 C:\Program Files\Git\cmd\git.exe"
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
                  留空表示使用 PATH 上的 git；打开本页时会自动填入探测到的路径。「浏览…」会在系统
                  文件管理器中显示并选中当前路径。修改后，文件树的 Git
                  标记会在下一次自动检测时生效。
                </FieldDescription>
              </Field>

              <Field>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void test()}
                    disabled={testing}
                  >
                    {testing ? '测试中…' : '测试版本'}
                  </Button>
                  {testResult ? (
                    <span className={testResult.ok ? 'text-xs text-fg' : 'text-xs text-danger'}>
                      {testResult.text}
                    </span>
                  ) : null}
                </div>
                <FieldDescription>
                  会实际运行一次 git --version；未保存的路径也可以先测试，留空时测试自动探测的 git。
                </FieldDescription>
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
