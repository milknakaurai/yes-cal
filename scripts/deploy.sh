#!/usr/bin/env bash
# Deploy ครบจบในสคริปต์เดียว — ต้องมี CLOUDFLARE_API_TOKEN ใน env
# (ถ้ามี GEMINI_API_KEY / DASHBOARD_KEY / LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN
#  อยู่ใน env ด้วย จะตั้งเป็น worker secret ให้อัตโนมัติ)
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?ต้องตั้ง CLOUDFLARE_API_TOKEN ก่อน}"
export WRANGLER_SEND_METRICS=false

[ -d node_modules ] || npm install

# เลือก account อัตโนมัติถ้า token เห็นได้บัญชีเดียว
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID=$(curl -sS https://api.cloudflare.com/client/v4/accounts \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    | node -pe "(JSON.parse(require('fs').readFileSync(0,'utf8')).result||[])[0]?.id ?? ''")
  export CLOUDFLARE_ACCOUNT_ID
  echo "account: $CLOUDFLARE_ACCOUNT_ID"
fi

# 1) สร้าง D1 ครั้งแรก แล้วเขียน database_id ลง wrangler.toml
if grep -q REPLACE_AFTER_D1_CREATE wrangler.toml; then
  echo "== creating D1 database: yes-cal =="
  npx wrangler d1 create yes-cal || true   # ถ้ามีอยู่แล้วให้ผ่านไปอ่าน id จาก list
  id=$(npx wrangler d1 list --json \
    | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).find(x=>x.name==='yes-cal')?.uuid ?? ''")
  [ -n "$id" ] || { echo "หา database id ของ yes-cal ไม่เจอ"; exit 1; }
  sed -i.bak "s/REPLACE_AFTER_D1_CREATE/$id/" wrangler.toml && rm -f wrangler.toml.bak
  echo "database_id = $id"
fi

# 2) สร้างตาราง (idempotent — รันซ้ำได้)
npx wrangler d1 execute yes-cal --remote --file=schema.sql -y

# 3) deploy worker + dashboard + cron
npx wrangler deploy

# 4) ตั้ง secrets จาก env ที่มี
for s in LINE_CHANNEL_SECRET LINE_CHANNEL_ACCESS_TOKEN GEMINI_API_KEY DASHBOARD_KEY; do
  v="${!s:-}"
  if [ -n "$v" ]; then
    echo "== secret: $s =="
    printf '%s' "$v" | npx wrangler secret put "$s"
  fi
done

echo
echo "เสร็จแล้ว ✅  อย่าลืมเอา URL ของ worker ไปตั้งเป็น Webhook URL ใน LINE Developers (ต่อท้ายด้วย /webhook)"
