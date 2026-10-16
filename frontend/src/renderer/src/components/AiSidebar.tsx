interface AiSidebarProps {
  /** 面板宽度（px），由父级的拖拽分隔条控制 */
  width: number
}

/** 右侧边栏：为后续 AI 工具预留的容器，当前展示占位提示 */
export default function AiSidebar({ width }: AiSidebarProps): React.JSX.Element {
  return (
    <aside className="ai-sidebar" style={{ width }}>
      <header className="ai-sidebar__header">AI 助手</header>
      <div className="ai-sidebar__body">
        <p className="ai-sidebar__hint">AI 工具区域，后续功能将在此提供</p>
      </div>
    </aside>
  )
}
