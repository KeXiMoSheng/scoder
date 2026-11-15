/** 文件系统域：主进程返回、渲染进程消费的条目标结构 */

import type { EncodingCandidate, TextEncodingId } from './encoding'

/** 目录单层条目（文件树懒加载的数据源） */
export interface FileEntry {
  /** 条目名称（不含路径） */
  name: string
  /** 绝对路径（同时作为文件树节点唯一标识） */
  path: string
  /** 是否为目录 */
  isDirectory: boolean
}

/** 文件搜索（按名称子串匹配）的结果 */
export interface SearchResult {
  /** 命中的条目（目录与文件） */
  entries: FileEntry[]
  /** 结果是否因达到上限被截断 */
  truncated: boolean
}

/** 打开文本读取流的结果：大文件按块拉取，避免整份内容挤进一次 IPC 消息 */
export interface TextStreamOpenResult {
  /** 会话标识，后续按块拉取与释放都带上它 */
  streamId: string
  /** 打开时观测到的文件字节数（用于进度展示） */
  size: number
  /** 本次读取使用的编码；编辑器记录它，保存时按同一编码写回 */
  encoding: TextEncodingId
  /** 自动识别的候选编码（含实际采用的第一条）：状态栏菜单据此标注最可能的编码 */
  candidates: EncodingCandidate[]
}

/** 一次文本流拉取的结果 */
export interface TextStreamChunk {
  /** 本块解码后的文本；空文件或仅剩不完整字节时可为空串 */
  text: string
  /** 文件已读完；会话由主进程自动释放，无需再 close */
  done: boolean
  /** 本块实际读取的字节数（用于进度累计） */
  bytesRead: number
}

/** 打开文本写入流的结果：大文件按块写入同目录临时文件，完成后原子替换目标 */
export interface TextWriteOpenResult {
  /** 会话标识，后续追加块、完成与放弃都带上它 */
  writeId: string
}

/**
 * 已加载目录的磁盘变更推送：目录内条目发生增删或改名时由主进程发出。
 * 只包含「目录」而非具体条目：渲染进程重读该目录即可拿到准确的增删结果。
 */
export interface DirectoriesChangedEvent {
  /** 发生变化的目录绝对路径（同一批事件已去重合并） */
  dirs: string[]
}

/**
 * 已打开文件的磁盘变更推送：文件内容被外部修改、或被原子替换（临时文件 + rename）时由主进程发出。
 * 渲染进程按路径重查 stat 自行判定（自身保存也会产生事件，需用 mtime 基线排除）。
 */
export interface FilesChangedEvent {
  /** 发生变化的文件绝对路径（同一批事件已去重合并） */
  paths: string[]
}

/** 文件观测：只 stat + 采样文件头，不读全文，用于超限提示与二进制判定 */
export interface FileStat {
  /** 文件字节数 */
  size: number
  /** 文件头 8 KB 内是否含 NUL 字节（二进制文件不进编辑器，也不参与大小限制提示 ） */
  binary: boolean
  /** 最后修改时间（毫秒时间戳）：编辑器据此区分自身保存与外部修改 */
  mtimeMs: number
}
