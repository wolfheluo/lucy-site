// =====================================================================
//  FILE VAULT client API（同源 cookie 自動帶）
// =====================================================================
import type { FileListItem, ShareInfo, UploadResponse } from "../types";

export type { FileListItem, ShareInfo, UploadResponse };

const BASE = "/api/tools/file-vault";

async function j<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body as T;
}

export class VaultApi {
  /** 目前登入狀態 */
  async me(): Promise<boolean> {
    const res = await fetch("/api/auth/me");
    const body = (await res.json()) as { authed: boolean };
    return body.authed;
  }

  /** 登入（401 錯密碼 / 429 鎖定） */
  async login(password: string): Promise<void> {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    await j<{ ok: boolean }>(res);
  }

  async logout(): Promise<void> {
    await fetch("/api/auth/logout", { method: "POST" });
  }

  async list(): Promise<FileListItem[]> {
    const res = await fetch(`${BASE}/files`);
    const body = await j<{ ok: boolean; files: FileListItem[] }>(res);
    return body.files;
  }

  /**
   * 上傳多檔。onProgress(percent 0-100) 為總體進度。
   * 用 XMLHttpRequest —— fetch 沒有 upload progress 事件。
   */
  upload(files: File[], onProgress?: (percent: number) => void): Promise<UploadResponse> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BASE}/upload`);
      xhr.responseType = "text";

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText) as UploadResponse;
          if (xhr.status >= 400) {
            const msg = (body as { error?: string }).error ?? `HTTP ${xhr.status}`;
            reject(new Error(msg));
            return;
          }
          resolve(body);
        } catch {
          reject(new Error(`上傳失敗（HTTP ${xhr.status}）`));
        }
      };
      xhr.onerror = () => reject(new Error("網路錯誤，上傳中斷"));
      xhr.ontimeout = () => reject(new Error("上傳逾時"));
      xhr.timeout = 0;

      const fd = new FormData();
      for (const f of files) fd.append("file", f, f.name);
      xhr.send(fd);
    });
  }

  downloadUrl(id: string): string {
    return `${BASE}/download/${id}`;
  }

  async remove(id: string): Promise<void> {
    const res = await fetch(`${BASE}/delete/${id}`, { method: "DELETE" });
    await j<{ ok: boolean }>(res);
  }

  async share(id: string): Promise<ShareInfo> {
    const res = await fetch(`${BASE}/share/${id}`, { method: "POST" });
    const body = await j<{ ok: boolean; share?: ShareInfo }>(res);
    if (!body.share) throw new Error("建立分享失敗");
    return body.share;
  }

  async revoke(id: string): Promise<void> {
    const res = await fetch(`${BASE}/share/${id}`, { method: "DELETE" });
    await j<{ ok: boolean }>(res);
  }
}

export const vaultApi = new VaultApi();
