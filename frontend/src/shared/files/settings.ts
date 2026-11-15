/**
 * 文件相关的限制：设置页可调，打开文件时读取。
 * 默认值同时给主进程兜底与渲染进程表单初值，避免两处维护两套数字。
 */

/** 设置页可调的文件限制 */
export interface FileSettings {
  /** 编辑器打开普通文本文件的体积上限（MB）；超过则先提示 */
  maxEditorFileMegabytes: number
}

/** 默认值：与接入设置前的硬编码上限一致 */
export const DEFAULT_FILE_SETTINGS: FileSettings = {
  maxEditorFileMegabytes: 1024
}

/** 表单允许的取值范围：只设下限，上限不设（按需配置，实际受进程内存约束） */
export const FILE_SETTINGS_LIMITS = {
  maxEditorFileMegabytes: { min: 1 }
} as const

/** 设置读写通道：数据落在主进程 SQLite 的 app_settings 表 */
export const FILE_SETTINGS_CHANNELS = {
  get: 'fileSettings:get',
  save: 'fileSettings:save'
} as const

/** MB → 字节：主进程按字节做体积判断，界面只展示 MB */
export function megabytesToBytes(megabytes: number): number {
  return megabytes * 1024 * 1024
}

/**
 * V8 单字符串最大长度（0x1fffffe8），一次性 getValue/toString 越过它必然抛
 * ERR_STRING_TOO_LONG。编辑器载入已改为流式增量灌入、不受此限；
 * 保存时用它作为切换「一次性写入 / snapshot 流式写入」的阈值。
 */
export const MAX_EDITOR_TEXT_BYTES = 0x1fffffe8
