# Yes Cal — คู่มือสำหรับ Claude session ถัดไป

LINE chatbot นับแคลอรี่สำหรับสองคน (เจ้าของ repo + แฟน) รันบน Cloudflare Worker + D1 + Gemini
รายละเอียดฟีเจอร์และคำสั่งในแชทอยู่ใน `README.md`

## สถานะตอนนี้

โค้ดเสร็จหมดแล้ว ทดสอบแล้ว **ยังไม่ได้ deploy** — เหลือแค่รัน deploy กับตั้ง LINE webhook

| ของที่ต้องใช้ | สถานะ |
|---|---|
| Cloudflare API token | ✅ มีแล้ว (ต้องอยู่ใน env `CLOUDFLARE_API_TOKEN`) |
| Gemini API key | ✅ มีแล้ว ทดสอบยิงจริงผ่าน (ต้องอยู่ใน env `GEMINI_API_KEY`) |
| LINE Channel secret / access token | ⛔ เจ้าของยังไม่ได้สร้าง Messaging API channel |

## วิธี deploy

ต้องการ network access ถึง `api.cloudflare.com` และ `*.workers.dev`
(ถ้า session ถูกบล็อก 403 จาก proxy = environment ยังตั้ง network เป็น Trusted อยู่ ต้องให้เจ้าของเปลี่ยนเป็น Full หรือ Custom ก่อน — แก้จากข้างในไม่ได้)

```bash
export CLOUDFLARE_API_TOKEN=...   # ถ้ายังไม่ได้ตั้งไว้ใน environment variables
export GEMINI_API_KEY=...
export DASHBOARD_KEY=...          # ตั้งอะไรก็ได้ ไว้กันคนอื่นเปิดหน้า dashboard
bash scripts/deploy.sh
```

สคริปต์จะทำให้ครบ: สร้าง D1 → เขียน `database_id` ลง `wrangler.toml` → สร้างตารางจาก `schema.sql` → `wrangler deploy` → ตั้ง secrets ที่มีใน env
รันซ้ำได้ปลอดภัย (idempotent) — **ถ้า `wrangler.toml` ถูกแก้ `database_id` ต้อง commit + push ด้วย**

## หลัง deploy เสร็จ ต้องบอกเจ้าของให้ทำ

1. เอา URL ของ worker ต่อท้าย `/webhook` ไปใส่ที่ LINE Developers → Messaging API → Webhook URL → Verify → เปิด Use webhook
2. เปิด "Allow bot to join group chats" และปิด Auto-reply / Greeting ใน LINE Official Account Manager
3. เชิญ OA เข้ากลุ่ม LINE แล้วพิมพ์ `ตั้งเป้า`

## โครงสร้าง

- `src/index.js` — Worker ทั้งหมด: LINE webhook + Gemini + D1 + dashboard API (`/api/overview`) + cron 21:00 ไทย (14:00 UTC)
- `public/index.html` — dashboard หน้าเดียว ไม่มี dependency ภายนอก รองรับ dark mode
- `schema.sql` — ตาราง users / meals / weights / chat_targets
- `scripts/deploy.sh` — deploy ครบจบในสคริปต์เดียว

## ข้อควรระวัง

- คุยกับเจ้าของเป็น**ภาษาไทย**
- ทำงานบน branch `claude/line-calorie-tracker-jmgcyz` เท่านั้น commit + push ทุกครั้งที่แก้เสร็จ
- อย่า commit ค่า secret ลง repo (มี `.gitignore` กัน `.dev.vars` ไว้แล้ว)
- ทดสอบ dashboard ในเครื่องได้โดยเสิร์ฟ `public/index.html` คู่กับ mock `/api/overview` — `wrangler dev` (workerd) รันไม่ขึ้นบนเครื่องเจ้าของ
