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

**ปกติไม่ต้อง deploy เอง** — `.github/workflows/deploy.yml` deploy ให้อัตโนมัติทุกครั้งที่ push
(รัน `scripts/e2e-test.mjs` ก่อน เทสไม่ผ่านจะไม่ deploy) ต้องมี repo secret `CLOUDFLARE_API_TOKEN`

### deploy เองด้วยมือ

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

- `PRETTY_PATHS` ใน `src/index.js` — แม็ป `/workout` `/calories` `/privacy` `/terms` ไปหาไฟล์จริง
- `src/index.js` — Worker ทั้งหมด: LINE webhook + Gemini + D1 + dashboard API (`/api/overview`) + cron 22:00 ไทย (15:00 UTC) เตือนกลุ่มชาเลนจ์
- `public/index.html` — **หน้าเว็บสาธารณะ** (`/`) เน้นเรื่องบอทชาเลนจ์ ไม่ต้องใส่รหัส
  มี `/privacy` กับ `/terms` คู่กัน — **จำเป็นต้องมี** เพราะ Whoop และ Google บังคับให้ใส่ URL สองอันนี้
  ตอนขอสร้างแอป และเอาไปโชว์ในหน้าขอสิทธิ์ให้ผู้ใช้อ่าน ห้ามเอาออกหรือย้าย URL
  สามหน้านี้ใช้ `public/site.css` + `public/site.js` ร่วมกัน สลับไทย/อังกฤษได้ (คนรีวิวแอปอ่านอังกฤษ)
  **อย่าสลับภาษาด้วย `el.style.display = ""`** — มันตกกลับไปโดน `[data-lang] { display: none }` ใน CSS
  ต้องใช้ attribute `data-active` บน `<html>` แล้วให้ CSS เป็นคนเปิด
- `public/calories.html` — dashboard ฝั่งแคลอรี่ (`/calories` — ย้ายมาจาก `/` ตอนทำหน้าเว็บสาธารณะ)
  ลิงก์เก่าแบบ `/?key=...` ยังใช้ได้ หน้าแรกจะ redirect ไป `/calories` ให้เอง
- `public/workout.html` — dashboard ฝั่งชาเลนจ์ (`/workout`) กินข้อมูลจาก `/api/challenge`
  แยกหน้า/แยก URL ตามที่เจ้าของขอ กลุ่มไหนเปิดโหมดชาเลนจ์จะโผล่ในหน้านี้เอง
  ชื่อกลุ่มไม่ได้เก็บใน D1 — `groupName()` ถาม LINE `/group/{id}/summary` ตอนเปิดหน้า (ไม่กินโควตา push)
  ทั้งสองหน้าใช้ `DASHBOARD_KEY` ตัวเดียวกัน เก็บใน localStorage คีย์ `yescal_key` และรับ `?key=` จาก URL ได้
- **แต่ละกลุ่มชาเลนจ์มีลิงก์ของตัวเอง** เจ้าของขอไว้ว่า 3 กลุ่มต้องไม่เห็นข้อมูลกัน
  โทเคนสุ่ม 32 ตัวอักษรต่อกลุ่ม เก็บในตาราง `chat_view_tokens` (worker สร้างตารางเองด้วย `ensureTokenTable`
  จะได้ไม่ต้องให้เจ้าของรัน migration) · `/workout?t=<token>` เปิดได้โดยไม่ต้องมี `DASHBOARD_KEY`
  พิมพ์ `เว็บ` ในกลุ่มเพื่อขอลิงก์ · `ลิงก์ใหม่` เพื่อหมุนโทเคนถ้าลิงก์หลุด
  **อย่าใช้ groupId เป็นพารามิเตอร์แทนโทเคน** — ใครมี `DASHBOARD_KEY` จะสลับดูกลุ่มอื่นได้หมด ผิดจุดประสงค์
- `src/food-reference.js` — ตารางค่าโภชนาการอาหารไทย ~40 เมนู ที่ให้ Gemini ยึดก่อนประเมินเอง
  และ `SUGGEST_POOL` คลังเมนู 25 รายการแบบมีโครงสร้าง (kcal/protein/มื้อ) สำหรับคำสั่ง `กินอะไรดี`
  ใช้ 2 ทาง: ส่งเป็นตัวเลือกตั้งต้นให้ Gemini และให้บอทเลือกเองตอนโควตาหมด
  **เพิ่มเมนูต้องเพิ่มทั้งสองที่** ไม่งั้นเลขตอนแนะนำกับตอนบันทึกจริงจะไม่ตรงกัน
- `src/jokes.js` — คลังมุกของบอท สุ่มทุกครั้ง (ล้อความขี้เกียจได้ ห้ามล้อรูปร่าง/น้ำหนัก)
  **ตอนเช็คอินห้ามชม** — สมาชิกบอกว่าโดนชมทุกครั้งแล้วอึดอัด แต่ตอบสั้นเกินก็ไม่ชอบ
  ทางออกคือใส่ "ข้อมูล" แทน "คำชม" และ**ไม่ใช้ประโยคสำเร็จรูปเลยตอนเช็คอิน**
  (ขึ้นต้นด้วยชื่อ+กิจกรรม+ตัวเลขจริง แล้วต่อด้วยสถิติ 7 วัน + สถานะกลุ่ม)
  เคยใช้ประโยคสุ่มแล้วโดนติว่า "พูดเหมือนกันเกินไป" เพราะสองคนติดกันได้ประโยคเดียวกัน
  ส่วนข้อความทวงตอน 22:00 ยังกวน ๆ ได้ตามเดิม
- `schema.sql` — users / meals / weights / chat_targets / challenge_members / workouts / api_usage
- `scripts/deploy.sh` — deploy ครบจบในสคริปต์เดียว
- `src/wearables.js` — OAuth + เก็บโทเคนของ WHOOP และ Google Health (แยกไฟล์เพราะ index.js ยาวเกินแล้ว)
  **ทั้ง 3 ข้อนี้พลาดแล้วพังเงียบ ๆ อย่าเอาออก**
  1. WHOOP ต้องมี scope `offline` ใน authorize URL ไม่งั้นไม่คืน `refresh_token` และต้องส่ง `scope=offline` ตอน refresh ด้วย
  2. WHOOP บังคับ `state` ยาว >= 8 ตัวอักษร (เราใช้ 32)
  3. Google ต้องมี `access_type=offline` + `prompt=consent` ไม่งั้นการยินยอมครั้งที่ 2 เป็นต้นไปจะไม่คืน refresh_token
     — `saveTokens` เลยต้องไม่ทับ refresh_token เดิมด้วย null
  **ตั้ง secret บน Windows ระวังค่าเพี้ยน** — เคยเจอจริง 24 ส.ค.: `WHOOP_CLIENT_ID` กลายเป็น `\u0016`
  (กด Ctrl+V ในหน้าต่างที่ซ่อนตัวอักษร Command Prompt รับเป็นอักขระควบคุมแทนการวาง)
  และ `GOOGLE_CLIENT_ID` กลายเป็นภาษาไทย (แป้นพิมพ์ค้างโหมดไทย)
  `configProblem()` จับสองอาการนี้แล้ว และ `/api/health` โชว์ `client_id` เต็ม ๆ ให้เทียบได้
  (client_id ไม่ใช่ความลับ ส่วน secret โชว์แค่ความยาว มีเทสคุมว่าห้ามหลุด)
  **ทางที่ชัวร์ที่สุดคือตั้งผ่านหน้าเว็บ Cloudflare** ไม่ใช่ command line
- `docs/wearables.md` — สเปกการเชื่อม Whoop + Fitbit
  **Fitbit API เดิมตาย ก.ย. 2026** ต้องใช้ Google Health API v4 เท่านั้น
  **Google Health API อ่านข้อมูล Whoop ไม่ได้** — Whoop เข้า Health Connect ซึ่งเป็นที่เก็บบนเครื่อง ไม่มี cloud API
  สเปกฝั่ง Google ยืนยันแล้วจาก discovery doc จริง · ฝั่ง Whoop ยังต้องเทียบกับ response จริง

## หมายเหตุการออกแบบที่สำคัญ

- **push มีแค่ตัวเดียว** (ทวงชาเลนจ์ 22:00) ฝั่งแคลอรี่ตั้งใจไม่ push เพราะ LINE จำกัดโควตา push
  ส่วน reply ฟรีไม่จำกัด — ฟีเจอร์ใหม่ควรทำเป็น reply เสมอถ้าเลือกได้
- **Gemini free tier จำกัดต่อรุ่นต่อวัน** (2.5-flash = 20 ครั้ง/วัน) จึงใช้ `gemini-3.5-flash-lite` เป็นรุ่นหลัก
  และมีระบบสลับรุ่นสำรองอัตโนมัติเมื่อ 429 — ดูยอดใช้จริงที่ `/api/health` ฟิลด์ `usage_7d`
- ข้อความในกลุ่มชาเลนจ์ผ่านตัวกรองคำ (`WORKOUT_HINTS`) ก่อนถึง Gemini กันเปลืองโควตาในกลุ่มใหญ่
- การแท็กชื่อใช้ `mention.mentionees` ต้องวางแท็กไว้ต้นข้อความเสมอ (index นับเป็น UTF-16)
- **ถูกแท็กต้องตอบเสมอ** (`getBotUserId` เทียบกับ mentionees) — เคยเงียบใส่คนที่เรียกหาแล้วโดนล้อว่าดองแชท
  ถ้า reply มาที่รูปด้วย จะโหลดรูปนั้นมาอ่านให้ (ใช้ `quotedMessageId` กับ endpoint `/message/{id}/content`)
- LINE ไม่รองรับ markdown — อย่าใส่ `**ตัวหนา**` ในข้อความบอท จะโชว์ดาวเป็นตัวอักษร
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
- **หน้าเว็บห้ามผูก `onkeydown` แบบ `(e) => e.key === "Enter" && go()`** — คีย์อื่นจะได้ค่า `false`
  ซึ่งใน handler แบบ DOM0 แปลว่า preventDefault ผลคือ**พิมพ์ในช่องไม่ได้เลย** (เคยทำให้ล็อกอิน dashboard ไม่ได้)
  ใช้ `<form onsubmit>` แทน ได้ทั้ง Enter และปุ่ม แถมมือถือขึ้นปุ่ม Go ให้ด้วย
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
