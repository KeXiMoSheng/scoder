import { useCallback, useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { extractErrorMessage } from '../../lib/errorMessage'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Skeleton } from '../ui/skeleton'
import type { AppInfo } from '@shared/app/types'

/** 关于分区：展示当前软件版本与官方仓库地址，点击地址后由系统浏览器打开 */
export default function AboutSettings(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  // 首屏加载：版本号只有主进程能读到，在异步回调里更新状态避免级联渲染
  useEffect(() => {
    let active = true
    window.api
      .getAppInfo()
      .then((value) => {
        if (active) {
          setInfo(value)
        }
      })
      .catch((reason) => {
        if (active) {
          setError(extractErrorMessage(reason))
        }
      })
    return () => {
      active = false
    }
  }, [])

  /** 跳转仓库：固定由主进程打开，这里只负责防重复点击与错误提示 */
  const openRepository = useCallback(async (): Promise<void> => {
    if (opening) {
      return
    }
    setOpening(true)
    setError(null)
    try {
      await window.api.openRepository()
    } catch (reason) {
      setError(extractErrorMessage(reason))
    } finally {
      setOpening(false)
    }
  }, [opening])

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">关于</h1>
        <p className="mt-1 leading-[1.6] text-dim">查看当前软件版本与源码仓库。</p>
      </div>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 leading-[1.6] text-danger">
          {error}
        </div>
      ) : null}

      <Card className="gap-5 py-5">
        <CardHeader>
          <CardTitle className="text-sm">软件信息</CardTitle>
          <CardDescription className="text-[12px]">
            版本号读取自当前安装包，仓库地址点击后在系统浏览器中打开。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {info ? (
            <div className="rounded-md border border-line">
              <div className="flex items-center gap-4 border-b border-line px-3 py-2.5 text-[12px]">
                <span className="w-24 shrink-0 text-dim">版本号</span>
                <span className="min-w-0 flex-1 truncate text-fg" title={info.version}>
                  v{info.version}
                </span>
              </div>
              <div className="flex items-center gap-4 px-3 py-2 text-[12px]">
                <span className="w-24 shrink-0 text-dim">GitHub 仓库</span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto min-w-0 justify-start p-0 text-[12px]"
                  title={info.repositoryUrl}
                  disabled={opening}
                  onClick={() => void openRepository()}
                >
                  <ExternalLink />
                  <span className="truncate">{info.repositoryUrl}</span>
                </Button>
              </div>
            </div>
          ) : error ? (
            <p className="leading-[1.6] text-dim">软件信息读取失败，请稍后重试。</p>
          ) : (
            <Skeleton className="h-24 rounded-md" />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
