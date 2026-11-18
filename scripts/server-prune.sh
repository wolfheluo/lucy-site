#!/usr/bin/env bash
# =====================================================================
#  server-prune.sh —— 清掉 app 目錄裡「不是執行期必需」的東西
#
#  新部署結構下，/www/wwwroot/lucy-site 只應該有：
#    releases/<sha>/    每次部署的完整一版（dist + dist-server + package*.json + node_modules）
#    current -> releases/<sha>
#    .env               唯一不動的執行期設定（data/ 必須在 VAULT_DATA_DIR，不在這裡）
#
#  用法（在伺服器上跑，預設 dry-run）：
#    ./server-prune.sh                 # 只列出會被刪的東西 + 大小，不動手
#    sudo ./server-prune.sh --apply    # 真的刪
#    sudo ./server-prune.sh --apply --delete-data   # 連 data/ 一起刪（確認已搬走）
#
#  環境變數：APP_DIR（預設 /www/wwwroot/lucy-site）
# =====================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/www/wwwroot/lucy-site}"
APPLY=0
DELETE_DATA=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --delete-data) DELETE_DATA=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知參數：$arg（用 --apply / --delete-data）" >&2; exit 2 ;;
  esac
done

[ -d "$APP_DIR" ] || { echo "找不到 app 目錄：$APP_DIR" >&2; exit 1; }

if [ ! -e "$APP_DIR/current" ]; then
  echo "警告：$APP_DIR/current 不存在 —— 這一台還沒走過新部署流程。"
  echo "      現在 --apply 會刪掉舊版 dist/、dist-server/、src/ 等目前線上正在用的東西，"
  echo "      請先跑一次 ./deploy.sh 讓 releases/ 與 current 出現，再回來清。"
  echo
fi

candidates=()
for entry in "$APP_DIR"/* "$APP_DIR"/.[!.]*; do
  [ -e "$entry" ] || continue
  name="$(basename "$entry")"
  case "$name" in
    releases|current|.env) continue ;;
    data)
      if [ "$DELETE_DATA" -eq 1 ]; then
        candidates+=("$entry")
      else
        echo "保留 data/：請先確認 .env 的 VAULT_DATA_DIR 已指向別處，要刪再加 --delete-data"
      fi
      ;;
    *) candidates+=("$entry") ;;
  esac
done

if [ "${#candidates[@]}" -eq 0 ]; then
  echo "乾淨：$APP_DIR 沒有非執行期檔案。"
  exit 0
fi

echo "以下 $((${#candidates[@]})) 項不屬於執行期（大小為 du -sh）："
for c in "${candidates[@]}"; do
  size="$(du -sh "$c" 2>/dev/null | cut -f1)"
  printf '  %6s  %s\n' "$size" "$c"
done
echo

if [ "$APPLY" -eq 0 ]; then
  echo "dry-run：甚麼都沒刪。確認無誤後執行：sudo $0 --apply"
  exit 0
fi

for c in "${candidates[@]}"; do
  echo "刪除 $c"
  rm -rf -- "$c"
done
echo "完成。剩下："
ls -A "$APP_DIR"
