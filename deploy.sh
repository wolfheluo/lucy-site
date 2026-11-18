#!/usr/bin/env bash
# =====================================================================
#  lucy-site 部署：本地 build → releases/<sha> → current symlink → 冒煙
#
#  用法（主機位址一律以 env/參數提供，勿寫死進 repo——公開 repo 會洩漏 IP）：
#    SERVER=user@host ./deploy.sh
#    SMOKE_PASSWORD=xxx SERVER=user@host ./deploy.sh   # 含 auth 冒煙
#    KEEP_RELEASES=3 SERVER=user@host ./deploy.sh      # 保留幾版（預設 5）
#
#  伺服器上的 app 目錄長這樣（其餘一律不該存在，見 scripts/server-prune.sh）：
#    /www/wwwroot/lucy-site/
#    ├── releases/<sha>/{dist,dist-server,package.json,package-lock.json,node_modules}
#    ├── current -> releases/<sha>
#    └── .env                     ← 唯一從頭到尾不動的執行期設定（data/ 應在別處）
#
#  部署形狀：
#    - 每次部署只上傳 dist/、dist-server/、package.json、package-lock.json
#    - node_modules 由伺服器自己產生：lock 未變更 → 硬連結上一版；變更 → npm ci --omit=dev
#    - 切 current 後 health 失敗會自動切回上一版並 exit 1
#
#  前提（pm2 需手動設定一次）：
#    - cwd = /www/wwwroot/lucy-site（不能是 current/，否則 cwd/.env 讀不到）
#    - script = ./current/dist-server/server/index.js
#    - 本機可 ssh key 登入目標（ubuntu 免密 sudo）
# =====================================================================
set -euo pipefail

SERVER="${1:-${SERVER:-}}"
if [ -z "$SERVER" ]; then
  echo "錯誤：未指定目標主機。用法：SERVER=user@host ./deploy.sh" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="/www/wwwroot/lucy-site"
ECO="${ECOSYSTEM:-/www/ecosystem-lucy.config.cjs}"
KEEP="${KEEP_RELEASES:-5}"
NODE_BIN="/www/server/nodejs/v24.20.0/bin"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

say "[1/5] 本地 production build（tsc -b + vite + server，server 不含 sourcemap）"
cd "$ROOT"
npm run build

SHA="$(git rev-parse --short=12 HEAD)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  SHA="${SHA}-dirty-$(date +%Y%m%d%H%M%S)"
  echo "注意：工作區有未 commit 的變更 → release 名稱 $SHA"
fi

say "[2/5] 傳輸產物 → ${SERVER}:/tmp/lucy-deploy-${SHA}"
ssh "$SERVER" "rm -rf '/tmp/lucy-deploy-${SHA}' && mkdir -p '/tmp/lucy-deploy-${SHA}'"
scp -r -q dist dist-server package.json package-lock.json "$SERVER:/tmp/lucy-deploy-${SHA}/"

say "[3/5] 建立 releases/${SHA}（依賴按 lock 決定硬連結或 npm ci）"
set +e
ssh "$SERVER" "SHA='${SHA}' APP_DIR='${APP_DIR}' ECO='${ECO}' KEEP='${KEEP}' NODE_BIN='${NODE_BIN}' bash -s" <<'REMOTE'
set -euo pipefail
REL="$APP_DIR/releases/$SHA"
TMP="/tmp/lucy-deploy-$SHA"
# 用函式而不是字串：PATH 內含空格時 "$PM2 ..." 會被 word-split 拆爛
pm2c() { sudo env PATH="$NODE_BIN:$PATH" pm2 "$@"; }

# ── preflight：缺 .env 或 ecosystem 沒指向 current → 直接停手（不要弄壞線上）──
[ -f "$APP_DIR/.env" ] || { echo "缺少 $APP_DIR/.env（production 會拒絕啟動）"; exit 1; }
[ -f "$ECO" ] || { echo "缺少 pm2 ecosystem：$ECO"; exit 1; }
grep -q "current/dist-server/server/index.js" "$ECO" \
  || { echo "$ECO 的 script 尚未指向 ./current/dist-server/server/index.js"; \
       echo "請改 cwd=$APP_DIR、script=./current/dist-server/server/index.js 後再部署"; exit 1; }

sudo mkdir -p "$APP_DIR/releases"
sudo rm -rf "$REL"
sudo mkdir -p "$REL"
sudo rsync -a "$TMP/dist/" "$REL/dist/"
sudo rsync -a "$TMP/dist-server/" "$REL/dist-server/"
sudo cp "$TMP/package.json" "$TMP/package-lock.json" "$REL/"

LOCK="$(sha256sum "$TMP/package-lock.json" | cut -d' ' -f1)"
PREV="$(readlink "$APP_DIR/current" 2>/dev/null || true)"
PREV_REL=""
[ -n "$PREV" ] && PREV_REL="$APP_DIR/$PREV"

if [ -n "$PREV_REL" ] && [ -d "$PREV_REL/node_modules" ] \
   && [ -f "$PREV_REL/.lock.sha256" ] && [ "$(cat "$PREV_REL/.lock.sha256")" = "$LOCK" ]; then
  echo "deps: package-lock 未變更 → 硬連結 ${PREV_REL##*/}/node_modules（幾乎不佔空間）"
  sudo cp -al "$PREV_REL/node_modules" "$REL/node_modules"
else
  echo "deps: package-lock 變更或首次部署 → npm ci --omit=dev"
  ( cd "$REL" && sudo env PATH="$NODE_BIN:$PATH" npm ci --omit=dev --no-audit --no-fund )
fi
echo "$LOCK" | sudo tee "$REL/.lock.sha256" >/dev/null
sudo chown -R www:www "$REL"

# ── 切版 + health（失敗自動回滾）──
sudo ln -sfn "releases/$SHA" "$APP_DIR/current"
pm2c startOrReload "$ECO" --update-env >/dev/null

ok=0
for _ in $(seq 1 15); do
  if curl -sf http://127.0.0.1:3001/api/health >/dev/null; then ok=1; break; fi
  sleep 1
done

if [ "$ok" != "1" ]; then
  echo "health 失敗（$SHA）→ 回滾"
  if [ -n "$PREV" ]; then
    sudo ln -sfn "$PREV" "$APP_DIR/current"
    pm2c startOrReload "$ECO" --update-env >/dev/null
    for _ in $(seq 1 15); do
      curl -sf http://127.0.0.1:3001/api/health >/dev/null && { echo "已回滾到 ${PREV##*/}（health OK）"; break; }
      sleep 1
    done
    curl -sf http://127.0.0.1:3001/api/health >/dev/null \
      || echo "回滾後仍不健康 → 查 pm2 logs lucy-site，必要時手動 ln -sfn releases/<舊sha> current"
  else
    echo "沒有上一版可回滾"
  fi
  exit 1
fi
echo "health OK（$SHA）"

# ── prune：只留最新 KEEP 版，永不刪 current 指向的版本 ──
CUR="$(basename "$(readlink "$APP_DIR/current")")"
ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  name="$(basename "$old")"
  [ "$name" = "$CUR" ] && continue
  echo "prune releases/$name"
  sudo rm -rf "$old"
done

sudo rm -rf "$TMP"
echo "release ready: releases/$SHA（保留 ${KEEP} 版）"
REMOTE
REMOTE_RC=$?
set -e
if [ "$REMOTE_RC" -ne 0 ]; then
  echo "部署中止（伺服器步驟失敗，exit $REMOTE_RC）" >&2
  exit "$REMOTE_RC"
fi

if [ -n "${SMOKE_PASSWORD:-}" ]; then
say "[4/5] 遠端冒煙：login -> 上傳 -> 分享 -> 公開下載比對 -> 清理"
ssh "$SERVER" "SMOKE_PASSWORD='$SMOKE_PASSWORD' bash -s" <<'SMOKE'
set -e
cd /tmp
rm -f lc.txt smoke.txt smoke-dl.txt
IP="198.51.100.$((RANDOM % 200 + 1))"   # 隨機 XFF，避開 rate-limit
B=http://127.0.0.1:3001

curl -sf -c lc.txt -X POST -H "Content-Type: application/json" -H "x-forwarded-for: $IP" \
  -d "{\"password\":\"$SMOKE_PASSWORD\"}" "$B/api/auth/login" -o /dev/null || { echo "login 失敗"; exit 1; }
echo "  ok login"

# ── dy-monitor（P1：登入牆 + 引擎在跑 + DB 有開）──
CODE_ANON=$(curl -s -o /dev/null -w '%{http_code}' "$B/api/tools/dy-monitor/health")
[ "$CODE_ANON" = "401" ] || { echo "dy-monitor 未登入竟回 $CODE_ANON（應為 401）"; exit 1; }
DYH=$(curl -sf -b lc.txt -H "x-forwarded-for: $IP" "$B/api/tools/dy-monitor/health") \
  || { echo "dy-monitor health 失敗"; exit 1; }
echo "$DYH" | grep -q '"ok":true' || { echo "dy-monitor health 非 ok：$DYH"; exit 1; }
echo "  ok dy-monitor（未登入 401 / health 200）"

echo "smoke $(date +%s)" > smoke.txt
FID=$(curl -sf -b lc.txt -H "x-forwarded-for: $IP" -F "file=@smoke.txt" \
  "$B/api/tools/file-vault/upload" | grep -oP '"id":"\K[a-f0-9-]{36}' | head -1)
[ -n "$FID" ] || { echo "upload 失敗"; exit 1; }
echo "  ok upload"

SID=$(curl -sf -b lc.txt -H "x-forwarded-for: $IP" -X POST \
  "$B/api/tools/file-vault/share/$FID" | grep -oP '"shareId":"\K[a-z]{4}')
PIN=$(curl -sf -b lc.txt -H "x-forwarded-for: $IP" "$B/api/tools/file-vault/files" \
  | grep -oP '"pin":"\K[0-9]{4}' | head -1)
[ -n "$SID" ] && [ -n "$PIN" ] || { echo "share 失敗"; exit 1; }
echo "  ok share ($SID)"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -F 'pin=0000' -H "x-forwarded-for: 203.0.113.$((RANDOM % 200 + 1))" "$B/s/$SID")
[ "$CODE" = "401" ] || { echo "錯 pin 預期 401 拿到 $CODE"; exit 1; }
echo "  ok 錯 pin 401"

curl -sf -X POST -F "pin=$PIN" -H "x-forwarded-for: 203.0.113.$((RANDOM % 200 + 1))" \
  "$B/s/$SID" -o smoke-dl.txt || { echo "下載失敗"; exit 1; }
cmp -s smoke.txt smoke-dl.txt || { echo "內容不一致"; exit 1; }
echo "  ok 公開下載內容一致"

curl -sf -b lc.txt -H "x-forwarded-for: $IP" -X DELETE \
  "$B/api/tools/file-vault/delete/$FID" -o /dev/null
rm -f lc.txt smoke.txt smoke-dl.txt
echo "  ok 清理"
SMOKE
else
  say "[4/5] 略過 auth 冒煙（未設 SMOKE_PASSWORD；可用 SMOKE_PASSWORD=xxx ./deploy.sh 開啟）"
fi

say "[5/5] 伺服器殘留檢查（dry-run，只報告不動手）"
ssh "$SERVER" "APP_DIR='${APP_DIR}' bash -s" <<'PRUNE'
set -euo pipefail
for entry in "$APP_DIR"/* "$APP_DIR"/.[!.]*; do
  [ -e "$entry" ] || continue
  case "$(basename "$entry")" in releases|current|.env) continue;; esac
  echo "  非執行期殘留：${entry}（./scripts/server-prune.sh --apply 可清）"
done
PRUNE

printf '\n\033[1;32m✅ 部署完成（%s -> %s）release %s\033[0m\n' "$ROOT" "$SERVER" "$SHA"
