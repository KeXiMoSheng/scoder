import { ElectronAPI } from '@electron-toolkit/preload'
import type { ScoderAPI } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: ScoderAPI
  }
}
