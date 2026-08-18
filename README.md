# Yes Cal 🍚

LINE chatbot นับแคลอรี่สำหรับสองคน — พิมพ์หรือส่งรูปอาหารในกลุ่ม LINE แล้วบอทประเมินแคลให้ พร้อมหน้าเว็บดูสถิติ

```
LINE (กลุ่ม: เรา + แฟน + OA)
      │ webhook
      ▼
Cloudflare Worker ──► D1 (users, meals, weights)
      │           ──► Gemini API (ประเมินแคลจากข้อความ/รูป)
      ▼
ตอบกลับในแชท + push สรุปทุกวัน 21:00 (Cron Trigger)
      +
หน้าเว็บ dashboard (กราฟ 14 วัน, น้ำหนัก, มื้ออาหารวันนี้)
```

## ฟีเจอร์ / คำสั่งในแชท

| พิมพ์ | ผลลัพธ์ |
|---|---|
| `ตั้งเป้า` | ถามเพศ/อายุ/ส่วนสูง/น้ำหนัก/กิจกรรม/เป้าหมาย → คำนวณ TDEE (Mifflin-St Jeor) ตั้งเป้าแคล + โปรตีนรายวัน |
| `เป้าโปรตีน 140` | ตั้งเป้าโปรตีนเองแทนค่าที่คำนวณให้ |

เป้าหมายมี 4 แบบ (กำหนดทั้งแคลอรี่และโปรตีนต่อน้ำหนักตัว):

| เป้าหมาย | แคลอรี่ | โปรตีน |
|---|---|---|
| สุขภาพทั่วไป | TDEE พอดี | 0.9 g/กก. (ช่วงแนะนำ 0.8–1.0) |
| กระชับสัดส่วน/เฟิร์ม | TDEE พอดี | 1.4 g/กก. (1.2–1.6) |
| สร้างกล้ามเนื้อ | TDEE +400 | 1.9 g/กก. (1.6–2.2) |
| ลดไขมัน/ลีนหุ่น | TDEE −500 | 2.0 g/กก. (1.8–2.2) |
| `ข้าวมันไก่ 1 จาน` | ประเมินแคล + บันทึก + บอกว่าวันนี้เหลืออีกเท่าไหร่ |
| ส่งรูปอาหาร 📷 | Gemini vision ประเมินจากรูป |
| `น้ำหนัก 65.5` | บันทึกน้ำหนัก + เทียบครั้งก่อน |
| `สรุป` | ยอดวันนี้ของทั้งคู่ แยกคน + มื้ออาหาร |
| `สัปดาห์` | ย้อนหลัง 7 วัน + ค่าเฉลี่ย |
| `ลบล่าสุด` | ลบรายการอาหารล่าสุดของวันนี้ |
| `ล้างวันนี้` | ลบรายการอาหารวันนี้ทั้งหมดของตัวเอง (เริ่มนับใหม่) |
| `เป้าหมาย` | ดูเป้าที่ตั้งไว้ |
| `คำสั่ง` | วิธีใช้ |
| (อัตโนมัติ 21:00) | push สรุปประจำวันเข้ากลุ่ม |

บอทแยกว่าใครกินจาก userId ของ LINE ที่ติดมากับทุกข้อความ — ไม่ต้องพิมพ์ชื่อ
ข้อความคุยเล่นทั่วไปบอทจะเงียบ ไม่แทรกกลางแชท

## สิ่งที่ต้องเตรียม

1. **Cloudflare API token** — dash.cloudflare.com → My Profile → API Tokens → Create Token
   - ใช้ template **"Edit Cloudflare Workers"** แล้วเพิ่ม permission: **Account → D1 → Edit**
2. **LINE Messaging API channel** — [developers.line.biz/console](https://developers.line.biz/console) → provider เดิม → Create a Messaging API channel
   - เอา **Channel secret** (Basic settings) และ **Channel access token** (Messaging API tab → issue)
   - เปิด **Allow bot to join group chats** (Messaging API tab)
   - ปิด Auto-reply / Greeting message ใน [LINE Official Account Manager](https://manager.line.biz)
3. **Gemini API key** — [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (ฟรี ไม่ต้องผูกบัตร)

## ติดตั้ง

```bash
npm install

# 1) สร้างฐานข้อมูล D1 แล้วเอา database_id ที่ได้ไปใส่ใน wrangler.toml
npx wrangler d1 create yes-cal

# 2) สร้างตาราง
npm run db:migrate

# 3) ใส่ secrets
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put DASHBOARD_KEY     # รหัสเปิดหน้าเว็บ ตั้งอะไรก็ได้

# 4) deploy
npm run deploy
```

ได้ URL มาแล้ว (เช่น `https://yes-cal.xxx.workers.dev`):

1. ไปที่ LINE Developers → Messaging API tab → **Webhook URL** ใส่ `https://yes-cal.xxx.workers.dev/webhook` → Verify → เปิด **Use webhook**
2. สร้างกลุ่ม LINE แล้วเชิญ OA เข้ากลุ่ม
3. พิมพ์ `ตั้งเป้า` ในกลุ่ม เริ่มใช้ได้เลย
4. หน้าเว็บสถิติ: เปิด URL หลัก แล้วใส่ DASHBOARD_KEY

## ค่าใช้จ่าย

- Cloudflare Workers + D1 + Cron: **ฟรี** (free tier เหลือเฟือสำหรับ 2 คน)
- LINE OA: reply ฟรีไม่จำกัด / push มีโควตาฟรีต่อเดือน (ใช้แค่วันละ 1 ครั้งตอน 21:00)
- Gemini flash free tier: **ฟรี** สำหรับปริมาณระดับนี้

> ⚠️ ตัวเลขแคลจาก AI เป็นการประเมินคร่าว ๆ (คลาดเคลื่อน 20–30% โดยเฉพาะอาหารไทยที่น้ำมัน/กะทิไม่แน่นอน) ใช้ดูเทรนด์ได้ดี ไม่ใช่คำแนะนำทางการแพทย์
