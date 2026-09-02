// 顯示輔助（大小 / 剩餘壽命）
export function fmtSize(n: number): string {
  let v = n;
  for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
    if (v < 1024 || unit === "TB") return unit === "B" ? `${v} B` : `${v.toFixed(1)} ${unit}`;
    v /= 1024;
  }
  return `${n} B`;
}

/** ttl 秒數 → 剩餘壽命字串 */
export function fmtTtl(sec: number): string {
  if (sec <= 0) return "EXPIRED";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** ttl < 1h 視為「即將湮滅」（紅） */
export function ttlUrgent(sec: number): boolean {
  return sec <= 3600;
}

export function shareUrl(shareId: string): string {
  return `${window.location.origin}/s/${shareId}`;
}

/** 組 curl 一鍵下載命令 */
export function curlCommand(shareId: string, pin: string, fileName: string): string {
  return `curl -X POST -F 'pin=${pin}' '${shareUrl(shareId)}' -o '${fileName}' -J`;
}
