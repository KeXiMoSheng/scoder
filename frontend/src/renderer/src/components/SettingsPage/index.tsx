import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import ModelSettings from '../ModelSettings'
import SettingsSidebar from '../SettingsSidebar'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from '../ui/breadcrumb'
import { Button } from '../ui/button'
import { Separator } from '../ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '../ui/sidebar'
import type { SettingsPageProps } from './types'
import type { SettingsSectionId } from '../SettingsSidebar/types'

/** 面包屑中展示的分区名：与 SettingsSidebar 的菜单文案保持一致 */
const SECTION_LABELS: Record<SettingsSectionId, string> = { models: '模型' }

/** 系统配置页：左侧分区导航 + 右侧设置内容，嵌入在标题栏下方的工作区位置 */
export default function SettingsPage({ onClose }: SettingsPageProps): React.JSX.Element {
  const [section, setSection] = useState<SettingsSectionId>('models')

  return (
    <SidebarProvider className="relative min-h-0 flex-1">
      <SettingsSidebar activeSection={section} onSelectSection={setSection} />
      <SidebarInset className="min-h-0">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">系统配置</BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>{SECTION_LABELS[section]}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
            <ArrowLeft />
            返回工作区
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {section === 'models' ? <ModelSettings /> : null}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
