# Yes Cal — คู่มือสำหรับ Claude session ถัดไป

LINE bot 2 โหมดในตัวเดียว รันบน Cloudflare Worker + D1 + Gemini
- **โหมดแคลอรี่** (ค่าเริ่มต้น) — นับแคล/โปรตีนจากข้อความและรูปอาหาร สำหรับกลุ่มบ้าน
- **โหมดชาเลนจ์** — เช็คอินออกกำลังกายจากรูป + ทวงคนที่ยังไม่ออกตอน 22:00 สำหรับกลุ่มเพื่อน
รายละเอียดคำสั่งทั้งหมดอยู่ใน `README.md`

## สถานะตอนนี้ (20 ส.ค. 2026)

**ใช้งานจริงแล้ว**: https://yes-cal.sales-a5c.workers.dev · secret ครบทั้ง 4 ตัว (`DASHBOARD_KEY` = yescal2569)
เจ้าของ deploy เองจากเครื่อง Windows ด้วย `wrangler login` (Command Prompt โฟลเดอร์ `yes-cal`)

ผู้ใช้โหมดแคลอรี่: Milk (muscle) · Charlie:P (fatloss) · Wisith (muscle)
โหมดชาเลนจ์: กำลังเริ่มกับกลุ่มเพื่อน 7 คน

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
3. เชิญ OA เข้ากลุ่ม LINE แล้วพิมพ์ `ตั้งเป้า` (กลุ่มชาเลนจ์พิมพ์ `ออกกำลังกาย` เพื่อสลับโหมดก่อน)

## โครงสร้าง

- `src/index.js` — Worker ทั้งหมด: LINE webhook + Gemini + D1 + dashboard API (`/api/overview`) + cron 22:00 ไทย (15:00 UTC) เตือนกลุ่มชาเลนจ์
- `public/index.html` — dashboard หน้าเดียว ไม่มี dependency ภายนอก รองรับ dark mode
- `src/food-reference.js` — ตารางค่าโภชนาการอาหารไทย ~40 เมนู ที่ให้ Gemini ยึดก่อนประเมินเอง
- `src/jokes.js` — คลังมุกของบอท สุ่มทุกครั้ง (ล้อความขี้เกียจได้ ห้ามล้อรูปร่าง/น้ำหนัก)
- `schema.sql` — users / meals / weights / chat_targets / challenge_members / workouts / api_usage
- `scripts/deploy.sh` — deploy ครบจบในสคริปต์เดียว

## หมายเหตุการออกแบบที่สำคัญ

- **push มีแค่ตัวเดียว** (ทวงชาเลนจ์ 22:00) ฝั่งแคลอรี่ตั้งใจไม่ push เพราะ LINE จำกัดโควตา push
  ส่วน reply ฟรีไม่จำกัด — ฟีเจอร์ใหม่ควรทำเป็น reply เสมอถ้าเลือกได้
- **Gemini free tier จำกัดต่อรุ่นต่อวัน** (2.5-flash = 20 ครั้ง/วัน) จึงใช้ `gemini-3.5-flash-lite` เป็นรุ่นหลัก
  และมีระบบสลับรุ่นสำรองอัตโนมัติเมื่อ 429 — ดูยอดใช้จริงที่ `/api/health` ฟิลด์ `usage_7d`
- ข้อความในกลุ่มชาเลนจ์ผ่านตัวกรองคำ (`WORKOUT_HINTS`) ก่อนถึง Gemini กันเปลืองโควตาในกลุ่มใหญ่
- การแท็กชื่อใช้ `mention.mentionees` ต้องวางแท็กไว้ต้นข้อความเสมอ (index นับเป็น UTF-16)
- **เช็คอินต้องมีตัวเลขเสมอ** ทั้งสองทาง (เจ้าของยืนยันหลายรอบว่าต้องเข้มเรื่องนี้)
  - รูป: ต้องได้ `has_screen_data` **หรือ** อ่าน `duration_min`/`kcal` ออกมาได้ (รูปบรรยากาศไม่นับ เคยทำให้นับซ้ำ)
    เกณฑ์ครอบคลุมหน้าจอที่ไม่มีแคลอรี่ด้วย เช่น Whoop ที่มีแต่ duration + HR zone + strain
  - ข้อความ: ต้องมีจำนวน (`hasAmount`) — "วิ่ง" หรือ "ออกกำลัง" ลอย ๆ ไม่นับ (`isVagueWorkoutWord`)
- **โหมดชาเลนจ์ไม่ประเมินเวลา/แคลอรี่ให้** แสดงเฉพาะที่เจ้าตัวบอกเองหรืออ่านจากหน้าจอในรูป
  (เคยมีตาราง MET ให้ประเมิน แต่ถอดออกแล้ว เพราะแต่ละคนใช้เวลาไม่เท่ากัน ตัวเลขที่เดาทำให้เข้าใจผิด)

## ข้อควรระวัง

- คุยกับเจ้าของเป็น**ภาษาไทย**
- ทำงานบน branch `claude/line-calorie-tracker-jmgcyz` เท่านั้น commit + push ทุกครั้งที่แก้เสร็จ
- อย่า commit ค่า secret ลง repo (มี `.gitignore` กัน `.dev.vars` ไว้แล้ว)
- **ทดสอบก่อน deploy ได้ด้วย `node scripts/e2e-test.mjs`** — จำลอง D1 ด้วย SQLite ในหน่วยความจำ (สร้างตารางจาก `schema.sql` จริง)
  แล้วยิง webhook event เหมือน LINE ส่งมา จับ SQL ผิด/ฟิลด์หายได้ทันที ควรรันทุกครั้งที่แก้ตรรกะโหมดชาเลนจ์
- ทดสอบ dashboard ในเครื่องได้โดยเสิร์ฟ `public/index.html` คู่กับ mock `/api/overview` — `wrangler dev` (workerd) รันไม่ขึ้นบนเครื่องเจ้าของ

## ถ้าเจ้าของบอกว่า "บอทไม่ทำงาน"

1. ให้เจ้าของเปิด `/api/health?key=<DASHBOARD_KEY>` แล้วส่งผลมา — บอกได้ทันทีว่า secret ตัวไหนหาย
2. เคยเจอ: **secret ของ LINE หายหลัง `wrangler deploy`** (19 ส.ค. 2026) ทั้งที่ `GEMINI_API_KEY` ยังอยู่
   อาการ = บอทเงียบสนิท เพราะ `verifyLineSignature` ไม่ผ่าน แล้วตอบ 403 ตั้งแต่ต้นทาง
   แก้โดยตั้ง secret ใหม่ทั้งชุด (ดูหัวข้อ "แก้ปัญหา" ใน README) แล้วยืนยันด้วย `/api/health` อีกรอบ
3. ตรวจฝั่งเซิร์ฟเวอร์เองได้ผ่าน Cloudflare MCP: `d1_database_query` (database_id `5d804c8a-a4ed-4a12-a2cc-93df2b3d5953`)
   ดูว่ามี meals เข้ามาวันนี้ไหม และ `workers_get_worker_code` ดูว่า deploy โค้ดล่าสุดหรือยัง
