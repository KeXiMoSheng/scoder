import { Pencil, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import type { ModelConfigCardProps } from './types'

/** 单个模型配置卡片：展示供应商、显示名、模型名与接口地址，并提供编辑/删除入口 */
export default function ModelConfigCard({
  config,
  onEdit,
  onDelete
}: ModelConfigCardProps): React.JSX.Element {
  return (
    <Card className="gap-4 py-4">
      <CardHeader>
        <CardTitle className="truncate text-[13px]" title={config.providerName}>
          {config.providerName}
        </CardTitle>
        <CardDescription className="truncate text-[12px]" title={config.displayName}>
          {config.displayName}
        </CardDescription>
        <CardAction className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="编辑模型"
            aria-label={`编辑 ${config.displayName}`}
            onClick={() => onEdit(config)}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="hover:bg-danger hover:text-accent-fg"
            title="删除模型"
            aria-label={`删除 ${config.displayName}`}
            onClick={() => onDelete(config)}
          >
            <Trash2 />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 text-[12px] leading-[1.6]">
        <div className="flex min-w-0 gap-2">
          <span className="shrink-0 text-dim">模型名称</span>
          <span className="truncate text-fg" title={config.modelName}>
            {config.modelName}
          </span>
        </div>
        <div className="flex min-w-0 gap-2">
          <span className="shrink-0 text-dim">模型地址</span>
          <span className="truncate text-fg" title={config.baseUrl}>
            {config.baseUrl}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
