import { useEffect, useState } from 'react'
import { Settings, Terminal } from 'lucide-react'
import { basename } from '../../lib/filePath'
import { APP_THEMES } from '../../lib/theme'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarTrigger
} from '../ui/menubar'
import type { TitleBarProps } from './types'

/** 最小化图标：底部一条横线 */
function MinimizeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

/** 最大化图标：单个方框 */
function MaximizeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <rect
        x="2.5"
        y="2.5"
        width="7"
        height="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  )
}

/** 还原图标：两个叠放的方框，表示当前处于最大化状态 */
function RestoreIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <rect x="2" y="4" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M4 4 V2 H10 V8 H8" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

/** 关闭图标：叉 */
function CloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

/** AI 侧边栏切换图标：外框 + 右侧分栏，展开时右侧区域着色加深 */
function SidebarRightIcon({ active }: { active: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" />
      <rect
        x="10.5"
        y="2.5"
        width="4"
        height="11"
        fill="currentColor"
        opacity={active ? 0.45 : 0.12}
      />
      <line x1="10.5" y1="2.5" x2="10.5" y2="13.5" stroke="currentColor" />
    </svg>
  )
}

/** 窗口控制按钮：占满标题栏高度，关闭键悬停用危险色 */
const WINDOW_BUTTON_CLASS = 'h-8 w-11 rounded-none text-fg [&_svg]:size-3'
/** 顶部菜单触发器：与标题栏同高，悬停/展开时用选中底色 */
const MENU_TRIGGER_CLASS =
  'h-full rounded-none px-2.5 text-[12px] font-normal text-fg hover:bg-selection'
/** 下拉菜单项：紧凑行高，与 IDE 菜单密度一致 */
const MENU_ITEM_CLASS = 'px-2.5 py-1 text-[12px]'

/**
 * 无边框窗口（frame: false）的自绘标题栏，同时充当应用菜单栏：
 * 左侧为「文件 / 主题」菜单，中间展示当前工作区名称，右侧为面板开关与窗口控制。
 * 整条栏通过 CSS `-webkit-app-region: drag` 可拖动窗口，交互元素设为 no-drag 以保持可点击。
 */
export default function TitleBar({
  projectPath,
  themeId,
  terminalVisible,
  aiPanelVisible,
  settingsOpen,
  onOpenFolder,
  onCloseFolder,
  onThemeChange,
  onNewTerminal,
  onToggleAiPanel,
  onToggleSettings
}: TitleBarProps): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    // 标题栏挂载时先回查当前状态（应用启动即最大化），再订阅后续变化
    let mounted = true
    void window.api.isWindowMaximized().then((value) => {
      if (mounted) {
        setMaximized(value)
      }
    })
    const unsubscribe = window.api.onWindowMaximizeChange((value) => {
      if (mounted) {
        setMaximized(value)
      }
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  /** 右侧面板开关的选中态样式：展开时用选中底色，收起时弱化 */
  const toggleButtonClass = (active: boolean): string =>
    cn('h-7 w-7 rounded-sm', active ? 'bg-selection text-fg' : 'text-dim')

  return (
    <div className="flex h-8 shrink-0 items-stretch border-b border-line bg-elevated [-webkit-app-region:drag] select-none">
      <Menubar className="h-full items-stretch gap-0 rounded-none border-0 bg-transparent p-0 shadow-none [-webkit-app-region:no-drag]">
        <MenubarMenu>
          <MenubarTrigger className={MENU_TRIGGER_CLASS}>文件</MenubarTrigger>
          <MenubarContent sideOffset={2} alignOffset={0} className="min-w-[168px]">
            <MenubarItem className={MENU_ITEM_CLASS} onSelect={onOpenFolder}>
              打开文件夹…
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem
              className={MENU_ITEM_CLASS}
              disabled={!projectPath}
              onSelect={onCloseFolder}
            >
              关闭文件夹
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger className={MENU_TRIGGER_CLASS}>主题</MenubarTrigger>
          <MenubarContent sideOffset={2} alignOffset={0} className="min-w-[180px]">
            <MenubarRadioGroup value={themeId} onValueChange={onThemeChange}>
              {APP_THEMES.map((theme) => (
                <MenubarRadioItem
                  key={theme.id}
                  value={theme.id}
                  className={cn(MENU_ITEM_CLASS, 'pl-8')}
                >
                  {theme.label}
                </MenubarRadioItem>
              ))}
            </MenubarRadioGroup>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      <div className="flex min-w-0 flex-1 items-center justify-center px-3">
        {projectPath ? (
          <span className="pointer-events-none truncate text-[12px] text-dim" title={projectPath}>
            {basename(projectPath) || projectPath}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 px-1 [-webkit-app-region:no-drag]">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={toggleButtonClass(terminalVisible)}
          onClick={onNewTerminal}
          title="新建终端（Ctrl+Shift+`，切换面板：Ctrl+` / Ctrl+J）"
          aria-label="新建终端"
        >
          <Terminal className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={toggleButtonClass(aiPanelVisible)}
          onClick={onToggleAiPanel}
          title="切换 AI 侧边栏（Ctrl+Alt+B）"
          aria-label="切换 AI 侧边栏"
          aria-pressed={aiPanelVisible}
        >
          <SidebarRightIcon active={aiPanelVisible} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={toggleButtonClass(settingsOpen)}
          onClick={onToggleSettings}
          title="系统配置"
          aria-label="系统配置"
          aria-pressed={settingsOpen}
        >
          <Settings className="size-4" />
        </Button>
      </div>
      <div className="ml-1 flex shrink-0 items-stretch [-webkit-app-region:no-drag]">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={WINDOW_BUTTON_CLASS}
          onClick={() => window.api.windowMinimize()}
          title="最小化"
          aria-label="最小化"
        >
          <MinimizeIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={WINDOW_BUTTON_CLASS}
          onClick={() => window.api.windowToggleMaximize()}
          title={maximized ? '向下还原' : '最大化'}
          aria-label={maximized ? '向下还原' : '最大化'}
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(WINDOW_BUTTON_CLASS, 'hover:bg-danger hover:text-accent-fg')}
          onClick={() => window.api.windowClose()}
          title="关闭"
          aria-label="关闭"
        >
          <CloseIcon />
        </Button>
      </div>
    </div>
  )
}
