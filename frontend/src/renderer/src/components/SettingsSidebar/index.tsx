import { Bot, Settings2 } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator
} from '../ui/sidebar'
import type { SettingsSection, SettingsSidebarProps } from './types'

/** 设置分区清单：后续新增分区（如聊天、快捷键）时在此追加即可 */
const SETTINGS_SECTIONS: readonly SettingsSection[] = [{ id: 'models', label: '模型', icon: Bot }]

/** 设置页左侧导航：顶部为页面标题，下方按分区清单渲染菜单 */
export default function SettingsSidebar({
  activeSection,
  onSelectSection
}: SettingsSidebarProps): React.JSX.Element {
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-selection">
            <Settings2 className="size-4" />
          </div>
          <span className="truncate text-sm font-semibold">系统配置</span>
        </div>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>配置</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    isActive={activeSection === id}
                    tooltip={label}
                    onClick={() => onSelectSection(id)}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
