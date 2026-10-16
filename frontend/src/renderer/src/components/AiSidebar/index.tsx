import type { AiSidebarProps } from './types'

/** 右侧边栏：为后续 AI 工具预留的容器，当前展示占位提示 */
export default function AiSidebar({ width }: AiSidebarProps): React.JSX.Element {
  return (
    <aside className="flex shrink-0 flex-col border-l border-line bg-elevated" style={{ width }}>
      <header className="shrink-0 border-b border-line px-3 py-2">AI 助手</header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <p className="m-0 text-center leading-[1.6] text-dim">AI 工具区域，后续功能将在此提供</p>
      </div>
    </aside>
  )
}
