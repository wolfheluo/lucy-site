// =====================================================================
//  VaultUI：檔案保險箱主介面
//  - dropzone（拖曳/點擊多檔）+ 上傳進度條
//  - 檔案列表（剩餘壽命即時倒數 / 分享狀態 / 操作）
//  - 分享 modal（/s/xxx + PIN + curl 一鍵下載）
// =====================================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { FileListItem, UploadResponse } from "../types";
import { vaultApi } from "./api";
import { curlCommand, fmtSize, fmtTtl, shareUrl, ttlUrgent } from "./util";

export default function VaultUI({ onLogout }: { onLogout: () => void }) {
  const [files, setFiles] = useState<FileListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<{ pct: number; names: string[] } | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResponse["files"] | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [shareFor, setShareFor] = useState<FileListItem | null>(null);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rm = useReducedMotion();

  const refresh = useCallback(async () => {
    try {
      setFiles(await vaultApi.list());
    } catch {
      /* session 失效由上層處理 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 剩餘壽命每秒刷新
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const doUpload = useCallback(
    async (list: FileList | File[]) => {
      const arr = Array.from(list);
      if (arr.length === 0 || uploading) return;
      setUploadResult(null);
      setUploadErr(null);
      const names = arr.map((f) => f.name);
      setUploading({ pct: 0, names });
      try {
        const res = await vaultApi.upload(arr, (pct) => setUploading({ pct, names }));
        setUploadResult(res.files);
        await refresh();
      } catch (e) {
        setUploadErr((e as Error).message);
      } finally {
        setUploading(null);
      }
    },
    [refresh, uploading]
  );

  const remove = async (f: FileListItem) => {
    if (!window.confirm(`確定銷毀「${f.originalName}」？此動作無法復原。`)) return;
    setBusyId(f.id);
    try {
      await vaultApi.remove(f.id);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const openShare = async (f: FileListItem) => {
    setBusyId(f.id);
    try {
      const share = await vaultApi.share(f.id);
      const updated = { ...f, share };
      setFiles((prev) => prev.map((x) => (x.id === f.id ? updated : x)));
      setShareFor(updated);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const okCount = uploadResult?.filter((r) => r.ok).length ?? 0;
  const failCount = (uploadResult?.length ?? 0) - okCount;
  const totalSize = files.reduce((acc, f) => acc + f.size, 0);

  return (
    <div className="vault">
      {/* ── 頂列 ─────────────────────────────────────────────── */}
      <div className="vault-bar">
        <div className="vault-bar-left">
          <span className="vault-status-dot" />
          <span className="vault-status-text">VAULT ONLINE // {files.length} FILE{files.length === 1 ? "" : "S"}</span>
        </div>
        <button className="vault-link" onClick={onLogout}>
          [ LOGOUT ]
        </button>
      </div>

      {/* ── Dropzone ─────────────────────────────────────────── */}
      <div
        className={`vault-drop${dragOver ? " over" : ""}${uploading ? " busy" : ""}`}
        onClick={() => !uploading && inputRef.current?.click()}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current++;
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragOver(false);
          void doUpload(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !uploading) inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void doUpload(e.target.files);
            e.target.value = "";
          }}
        />
        <div className="vault-drop-icon">⬇</div>
        {uploading ? (
          <>
            <div className="vault-drop-title">
              UPLOADING // {uploading.names.length} FILE{uploading.names.length === 1 ? "" : "S"}
            </div>
            <div className="vault-upload-progress">
              <i style={{ width: `${uploading.pct}%` }} />
            </div>
            <div className="vault-drop-pct">{String(uploading.pct).padStart(3, "0")}%</div>
          </>
        ) : (
          <>
            <div className="vault-drop-title">{dragOver ? "RELEASE TO UPLOAD" : "DRAG & DROP FILES"}</div>
            <div className="vault-drop-sub">拖曳檔案至此，或點擊選取（多檔）// 72h 後自動湮滅</div>
          </>
        )}
      </div>

      {/* 上傳結果 / 錯誤 */}
      <AnimatePresence>
        {uploadResult && (
          <motion.div
            key="ures"
            initial={rm ? false : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`vault-msg ${failCount > 0 ? "err" : "ok"}`}
            onClick={() => setUploadResult(null)}
          >
            {failCount > 0
              ? `⚠ ${okCount} 成功 / ${failCount} 失敗：${uploadResult
                  .filter((r) => !r.ok)
                  .map((r) => r.error)
                  .join("；")}`
              : `✓ ${okCount} 個檔案已存入保險箱（點擊關閉）`}
          </motion.div>
        )}
        {uploadErr && (
          <motion.div
            key="uerr"
            initial={rm ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="vault-msg err"
            onClick={() => setUploadErr(null)}
          >
            ✕ {uploadErr}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 檔案列表 ─────────────────────────────────────────── */}
      <div className="vault-list-head">
        <span>STORED FILES</span>
        <span className="dim">
          {totalSize > 0 ? `${fmtSize(totalSize)} TOTAL` : ""}
        </span>
      </div>

      {loading ? (
        <div className="vault-empty">SCANNING VAULT…</div>
      ) : files.length === 0 ? (
        <div className="vault-empty">
          <div className="vault-empty-title">VAULT EMPTY</div>
          <div className="vault-empty-sub">保險箱是空的——上傳第一個檔案開始</div>
        </div>
      ) : (
        <ul className="vault-files">
          {files.map((f) => {
            const ttl = Math.max(0, Math.round((f.expireTime - now) / 1000));
            const urgent = ttlUrgent(ttl);
            return (
              <li key={f.id} className="vault-file glass">
                <div className="vault-file-main">
                  <div className="vault-file-name" title={f.originalName}>
                    {f.originalName}
                  </div>
                  <div className="vault-file-meta">
                    <span>{fmtSize(f.size)}</span>
                    <span className="sep">//</span>
                    <span className={urgent ? "ttl-urgent" : ""}>
                      {ttl <= 0 ? "SELF-DESTRUCTED" : `湮滅倒數 ${fmtTtl(ttl)}`}
                    </span>
                    {f.share && (
                      <>
                        <span className="sep">//</span>
                        <span className="share-linked">SHARE: /s/{f.share.shareId}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="vault-file-actions">
                  {!f.share && (
                    <button
                      className="vault-action share"
                      disabled={busyId === f.id}
                      onClick={() => void openShare(f)}
                    >
                      SHARE
                    </button>
                  )}
                  {f.share && (
                    <button className="vault-action share" onClick={() => setShareFor(f)}>
                      LINK
                    </button>
                  )}
                  <a className="vault-action dl" href={vaultApi.downloadUrl(f.id)} data-hover>
                    GET
                  </a>
                  <button
                    className="vault-action del"
                    disabled={busyId === f.id}
                    onClick={() => void remove(f)}
                  >
                    BURN
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ── 分享 modal ───────────────────────────────────────── */}
      <AnimatePresence>
        {shareFor?.share && (
          <ShareModal
            file={shareFor}
            onClose={() => setShareFor(null)}
            onRevoked={async () => {
              await refresh();
              setShareFor(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------------- ShareModal ---------------- */
function ShareModal({
  file,
  onClose,
  onRevoked,
}: {
  file: FileListItem;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const share = file.share!;
  const url = shareUrl(share.shareId);
  const curl = curlCommand(share.shareId, share.pin, file.originalName);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      alert(`複製失敗：${label}`);
    }
  };

  const revoke = async () => {
    if (!window.confirm("撤銷後此分享連結立即失效，確定？")) return;
    setRevoking(true);
    try {
      await vaultApi.revoke(file.id);
      await onRevoked();
    } finally {
      setRevoking(false);
    }
  };

  return (
    <motion.div
      className="vault-modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="vault-modal glass"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="vault-modal-title">SHARE LINK ESTABLISHED // 分享已建立</div>
        <div className="vault-modal-file">{file.originalName}</div>

        <div className="vault-share-url" onClick={() => void copy(url, "連結")} title="點擊複製連結">
          {url}
          <span className="vault-copy-hint">COPY</span>
        </div>

        <div className="vault-pin-row">
          <div className="vault-pin-label">PIN</div>
          <div className="vault-pin" onClick={() => void copy(share.pin, "PIN")} title="點擊複製 PIN">
            {share.pin}
          </div>
        </div>

        <div className="vault-curl">
          <div className="vault-curl-head">
            <span>CURL 一鍵下載</span>
            <button onClick={() => void copy(curl, "curl 命令")}>
              {copied ? "COPIED ✓" : "COPY"}
            </button>
          </div>
          <pre>{curl}</pre>
        </div>

        <div className="vault-modal-foot">
          <button className="vault-action del" disabled={revoking} onClick={() => void revoke()}>
            {revoking ? "REVOKING…" : "REVOKE 撤銷"}
          </button>
          <button className="vault-btn vault-btn-primary" onClick={onClose}>
            CLOSE
          </button>
        </div>
        <div className="vault-modal-note">分享連結與檔案將於 72 小時後自動湮滅</div>
      </motion.div>
    </motion.div>
  );
}
