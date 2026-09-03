#!/usr/bin/env bash
# =====================================================================
#  lucy-site 一鍵部署：本地 build → 推送編譯產物 → pm2 restart → 冒煙
#
#  用法（主機位址一律以 env/參數提供，勿寫死進 repo——公開 repo 會洩漏 IP）：
#    SERVER=user@host ./deploy.sh
#    SMOKE_PASSWORD=xxx SERVER=user@host ./deploy.sh   # 含 auth 冒煙
#
#  前提：
#    - 本機可 ssh key 登入目標（ubuntu 免密 sudo）
#    - 目標已配置 pm2 ecosystem（/www/ecosystem-lucy.config.cjs）
#    - dist/、dist-server/ 為 gitignored 編譯產物（不入 git）
# =====================================================================
set -euo pipefail

SERVER="${1:-${SERVER:-}}"
if [ -z "$SERVER" ]; then
  echo "錯誤：未指定目標主機。用法：SERVER=user@host ./deploy.sh" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="/www/wwwroot/lucy-site"
PM2="sudo env PATH=/www/server/nodejs/v24.20.0/bin:\$PATH pm2"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

say "[1/5] 本地 production build（tsc -b + vite + server）"
cd "$ROOT"
npm run build

say "[2/5] 傳輸 dist + dist-server → ${SERVER}:/tmp"
ssh "$SERVER" "rm -rf /tmp/lucy-deploy-dist /tmp/lucy-deploy-dist-server"
scp -r -q dist "$SERVER:/tmp/lucy-deploy-dist"
scp -r -q dist-server "$SERVER:/tmp/lucy-deploy-dist-server"

say "[3/5] 伺服器搬移（--delete 清舊產物）+ chown www"
ssh "$SERVER" "sudo rsync -a --delete /tmp/lucy-deploy-dist/ ${APP_DIR}/dist/ \
  && sudo rsync -a --delete /tmp/lucy-deploy-dist-server/ ${APP_DIR}/dist-server/ \
  && sudo chown -R www:www ${APP_DIR}/dist ${APP_DIR}/dist-server \
  && sudo rm -rf /tmp/lucy-deploy-dist /tmp/lucy-deploy-dist-server \
  && echo moved"

say "[4/5] pm2 restart + health"
ssh "$SERVER" "${PM2} restart lucy-site --update-env >/dev/null && sleep 2 \
  && curl -sf http://127.0.0.1:3001/api/health && echo ' <- health OK'"

if [ -n "${SMOKE_PASSWORD:-}" ]; then
say "[5/5] 遠端冒煙：login -> 上傳 -> 分享 -> 公開下載比對 -> 清理"
ssh "$SERVER" "SMOKE_PASSWORD='$SMOKE_PASSWORD' bash -s" <<'SMOKE'
set -e
cd /tmp
rm -f lc.txt smoke.txt smoke-dl.txt
IP="198.51.100.$((RANDOM % 200 + 1))"   # 隨機 XFF，避開 rate-limit
B=http://127.0.0.1:3001

curl -sf -c lc.txt -X POST -H "Content-Type: application/json" -H "x-forwarded-for: $IP" \
  -d "{\"password\":\"$SMOKE_PASSWORD\"}" "$B/api/auth/login" -o /dev/null || { echo "login 失敗"; exit 1; }
echo "  ok login"

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
  say "[5/5] 略過 auth 冒煙（未設 SMOKE_PASSWORD；可用 SMOKE_PASSWORD=xxx ./deploy.sh 開啟）"
fi

printf '\n\033[1;32m✅ 部署完成（%s -> %s）\033[0m\n' "$ROOT" "$SERVER"
