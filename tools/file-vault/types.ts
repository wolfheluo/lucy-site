// =====================================================================
//  FILE VAULT 共享型別（type-only，client/server 皆可 import）
// =====================================================================

/** 檔案記錄（SQLite vault_files 一列） */
export interface VaultFile {
  id: string;
  originalName: string;
  storedName: string;
  size: number;
  /** epoch ms */
  uploadTime: number;
  /** epoch ms（預設 +72h） */
  expireTime: number;
  share: ShareInfo | null;
}

export interface ShareInfo {
  shareId: string;
  pin: string;
  createdAt: number;
}

/** 管理 API 上傳回應（單檔） */
export interface UploadResultItem {
  ok: boolean;
  file?: VaultFile;
  error?: string;
}

export interface UploadResponse {
  ok: boolean;
  files: UploadResultItem[];
}

/** 管理 API 檔案列表元素（client 顯示用） */
export interface FileListItem {
  id: string;
  originalName: string;
  size: number;
  uploadTime: number;
  expireTime: number;
  /** 剩餘秒數（<=0 表示已過期待清理） */
  ttlSec: number;
  share: ShareInfo | null;
}
