/**
 * 导入主题的 IPC 通道：弹文件选择框、转换并落盘，设置页与启动引导只读结果。
 * 主题文件解析与转换在 import.ts，持久化在 store.ts，这里只负责窗口交互与错误聚合。
 */
import {
  BrowserWindow,
  dialog,
  ipcMain,
  type MessageBoxOptions,
  type OpenDialogOptions
} from 'electron'
import { basename } from 'path'
import { THEME_CHANNELS } from '../../shared/theme/events'
import type { ImportedTheme, ThemeImportError, ThemeImportResult } from '../../shared/theme/types'
import { importThemeFile, type ThemeDraft } from './import'
import { deleteImportedTheme, listImportedThemes, saveImportedThemes } from './store'

/** 注册导入主题通道（不依赖数据库，窗口创建前即可注册） */
export function registerThemeHandlers(): void {
  ipcMain.handle(THEME_CHANNELS.listImported, (): Promise<ImportedTheme[]> => listImportedThemes())

  ipcMain.handle(THEME_CHANNELS.importThemes, async (event): Promise<ThemeImportResult> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '导入 VS Code 主题',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'VS Code 主题 / 主题扩展包', extensions: ['json', 'jsonc', 'vsix', 'zip'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const selected = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (selected.canceled || selected.filePaths.length === 0) {
      return { canceled: true, themes: [], errors: [] }
    }

    const drafts: ThemeDraft[] = []
    const errors: ThemeImportError[] = []
    for (const filePath of selected.filePaths) {
      try {
        const result = await importThemeFile(filePath)
        drafts.push(...result.drafts)
        errors.push(...result.errors)
      } catch (error) {
        errors.push({
          file: basename(filePath),
          message: error instanceof Error ? error.message : String(error)
        })
        console.warn(`导入主题失败：${filePath}`, error)
      }
    }

    if (drafts.length === 0) {
      return { canceled: false, themes: [], errors }
    }
    const themes = await saveImportedThemes(drafts)
    return { canceled: false, themes, errors }
  })

  ipcMain.handle(THEME_CHANNELS.deleteImported, async (event, id: string): Promise<boolean> => {
    if (typeof id !== 'string') {
      throw new Error('主题 id 无效')
    }
    // 先确认记录存在，避免对不存在的 id 弹确认框
    const theme = (await listImportedThemes()).find((item) => item.id === id)
    if (!theme) {
      return false
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: MessageBoxOptions = {
      type: 'warning',
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
      title: '删除主题',
      message: `确定要删除导入的主题「${theme.label}」吗？`,
      detail: '只删除本机导入的这份主题，不影响原 VS Code 主题文件。'
    }
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
    if (result.response !== 1) {
      return false
    }
    return deleteImportedTheme(id)
  })
}
