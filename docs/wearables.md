# เชื่อมข้อมูลนาฬิกา (Whoop + Fitbit) — สเปกและแผนงาน

บันทึกจากการตรวจสอบเมื่อ 24 ส.ค. 2026 · ทำเพื่อให้ Milk (Whoop) กับแฟน (Fitbit) เห็นข้อมูลกัน

## ข้อสรุปสำคัญ 3 ข้อ

1. **Fitbit API เดิมตายเดือน ก.ย. 2026** ห้ามเขียนต่อ ต้องใช้ Google Health API v4 เท่านั้น
2. **Google Health API อ่านข้อมูล Whoop ไม่ได้** ต้องต่อ Whoop แยกอีกทาง (เหตุผลข้อถัดไป)
3. Whoop ส่งข้อมูลเข้า **Health Connect** ได้ก็จริง แต่ Health Connect เป็น **ที่เก็บบนเครื่อง ไม่มี cloud API**
   Worker ที่รันบน Cloudflare จึงอ่านไม่ได้เลย ไม่ว่าจะทำยังไง

→ **ต้องมี 2 การเชื่อมต่อ** แต่โค้ดส่วนใหญ่ (state, เก็บโทเคน, refresh, แปลงหน่วย) ใช้ร่วมกันได้

---

## ฝั่ง Fitbit — Google Health API v4

ตรวจสอบจาก discovery document จริง: `https://health.googleapis.com/$discovery/rest?version=v4`
(ดึงมาได้จริง ไม่ได้เดา — หน้า developers.google.com ถูกบล็อกจาก session แต่ discovery doc เปิดได้)

- Base URL: `https://health.googleapis.com/`
- Auth: Google OAuth 2.0 ปกติ

### Scope ที่ต้องขอ (readonly ทั้งหมด)

```
https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
https://www.googleapis.com/auth/googlehealth.sleep.readonly
https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
```

ทั้งหมดเป็น **Restricted scope** → ถ้าจะเปิดสาธารณะต้องผ่านรีวิวของ Google
แต่บ้านเราใช้กันแค่ 2–3 คน ให้เก็บแอปไว้โหมด **Testing** แล้วใส่อีเมลเป็น test user (ได้ถึง 100 คน)
ไม่ต้องยื่นรีวิว แลกกับหน้าเตือน "unverified app" ตอนกดยินยอมครั้งแรก

### Endpoint ที่ใช้

| อยากได้ | เรียก |
|---|---|
| รายการออกกำลังกาย | `GET v4/users/me/dataTypes/exercise/dataPoints` |
| การนอน | `GET v4/users/me/dataTypes/sleep/dataPoints` |
| หัวใจขณะพักรายวัน | `GET v4/users/me/dataTypes/daily-resting-heart-rate/dataPoints` |
| HRV รายวัน | `GET v4/users/me/dataTypes/daily-heart-rate-variability/dataPoints` |
| ก้าว | `GET v4/users/me/dataTypes/steps/dataPoints` |
| แคลที่เผา | `GET v4/users/me/dataTypes/active-energy-burned/dataPoints` |

กรองช่วงเวลาด้วยพารามิเตอร์ `filter` (รูปแบบ AIP-160):

```
exercise.interval.start_time >= "2026-08-24T00:00:00Z" AND exercise.interval.start_time < "2026-08-25T00:00:00Z"
```

หรือใช้เวลาท้องถิ่นก็ได้ ซึ่งเหมาะกับเราที่คิดวันแบบไทย:
`exercise.interval.civil_start_time >= "2026-08-24" AND ... < "2026-08-25"`

`pageSize` ได้ถึง 10000 · ต่อหน้าถัดไปด้วย `pageToken`

### ฟิลด์ที่ต้องอ่าน

```
DataPoint.exercise
  .displayName                                ชื่อกิจกรรม
  .exerciseType                               ประเภท
  .activeDuration                             เวลาที่ออกจริง (duration string เช่น "1800s")
  .interval.startTime / .endTime               ช่วงเวลา (RFC-3339)
  .metricsSummary.caloriesKcal                 แคลอรี่
  .metricsSummary.averageHeartRateBeatsPerMinute
  .metricsSummary.distanceMillimeters
  .metricsSummary.steps

DataPoint.sleep
  .interval.startTime / .endTime
  .summary.minutesAsleep                       นาทีที่หลับจริง
  .summary.minutesAwake
  .summary.minutesInSleepPeriod

DataPoint.dailyRestingHeartRate.beatsPerMinute
DataPoint.dailyHeartRateVariability.averageHeartRateVariabilityMilliseconds
```

ระวัง: หลายฟิลด์เป็น **string** ไม่ใช่ number (`beatsPerMinute`, `minutesAsleep`,
`averageHeartRateBeatsPerMinute`, `steps`) ต้อง `Number()` ก่อนใช้

### Webhook

มี — `projects.subscribers.subscriptions` ใน API เดียวกัน ยังไม่ต้องใช้รอบแรก ดึงเป็นรอบ ๆ ก่อน

---

## ฝั่ง Whoop — WHOOP API v2

⚠️ **ส่วนนี้ยังไม่ได้ยืนยันจากเอกสารตรง ๆ** — `developer.whoop.com` และ `api.prod.whoop.com`
ถูกบล็อกจาก session นี้ ข้อมูลด้านล่างมาจากผลค้นหาและต้องเทียบกับ response จริงอีกครั้งตอนต่อได้แล้ว

- สร้างแอปเองที่ developer.whoop.com → Dashboard (ได้ Client ID/Secret ทันที ไม่ต้องรออนุมัติ · ทำได้ 5 แอป)
- OAuth 2.0 · ต้องระบุ redirect URL ให้ตรงกับที่ตั้งใน dashboard · ต้องขออย่างน้อย 1 scope
- มี webhook แจ้งเมื่อมีข้อมูลใหม่

| อยากได้ | เรียก |
|---|---|
| ออกกำลังกาย | `GET /v2/activity/workout` |
| การนอน | `GET /v2/activity/sleep` |
| Recovery | `GET /v2/recovery` |

ฟิลด์ที่คาดว่าจะใช้ (ต้องตรวจกับของจริง):
`score.strain`, `score.average_heart_rate`, `score.kilojoule` (→ แคล = kJ ÷ 4.184),
`score.sleep_performance_percentage`, `score.recovery_score`, `score.resting_heart_rate`,
`score.hrv_rmssd_milli` · ทุก object มี `score_state` ต้องเช็คว่าเป็น `SCORED` ก่อนใช้ค่า

---

## ตัวเลขที่เอามาเทียบกันได้จริง

Whoop ไม่มีจำนวนก้าว · Fitbit ไม่มี Strain/Recovery แบบเดียวกัน
**ห้ามเอามาบวกกันหรือจัดอันดับข้ามกัน** นอกจาก 5 ตัวนี้:

| ตัวชี้วัดร่วม | Whoop | Google Health |
|---|---|---|
| เวลาออกกำลังกาย | `start`/`end` | `exercise.activeDuration` |
| แคลอรี่ที่เผา | `score.kilojoule` ÷ 4.184 | `metricsSummary.caloriesKcal` |
| หัวใจเฉลี่ยตอนออก | `score.average_heart_rate` | `metricsSummary.averageHeartRateBeatsPerMinute` |
| ชั่วโมงนอน | `score.stage_summary` | `sleep.summary.minutesAsleep` |
| หัวใจขณะพัก | `score.resting_heart_rate` | `daily-resting-heart-rate.beatsPerMinute` |

ค่าที่มีข้างเดียว (Strain, Recovery %, ก้าว) ให้โชว์แยกเป็นของใครของมัน ไม่ต้องเทียบ

---

## สิ่งที่เจ้าของต้องไปตั้งเอง (ทำก่อนถึงจะเขียนโค้ดต่อได้)

ทั้งสองที่ต้องใส่ **redirect URI** ให้ตรงเป๊ะ:

```
https://yes-cal.sales-a5c.workers.dev/oauth/whoop/callback
https://yes-cal.sales-a5c.workers.dev/oauth/google/callback
```

URL ที่ฟอร์มขอ (ทำเสร็จแล้ว เสิร์ฟจาก worker เดียวกัน):

```
Homepage        https://yes-cal.sales-a5c.workers.dev/
Privacy Policy  https://yes-cal.sales-a5c.workers.dev/privacy
Terms of Service https://yes-cal.sales-a5c.workers.dev/terms
```

⚠️ **ต้องกรอกอีเมลติดต่อในหัวข้อ 9 ของหน้า privacy ก่อนส่งฟอร์ม** ตอนนี้ยังเป็นที่ว่างอยู่

**Whoop** — developer.whoop.com → Dashboard → Create App
ขอ scope: `read:workout` `read:sleep` `read:recovery` `read:profile`

**Google** — console.cloud.google.com → สร้างโปรเจกต์ → เปิด Google Health API
→ OAuth consent screen แบบ External, **เก็บไว้โหมด Testing**, ใส่อีเมลของทั้งสองคนเป็น Test user
→ Credentials → OAuth client ID แบบ Web application

เสร็จแล้วตั้ง secret 5 ตัว:

```
npx wrangler secret put WHOOP_CLIENT_ID
npx wrangler secret put WHOOP_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOKEN_KEY        # สุ่มเอง 32+ ตัวอักษร ใช้เข้ารหัส refresh token ก่อนลง D1
```

---

## แผนการเขียน

1. ตาราง `device_links` (โทเคนเข้ารหัส AES-GCM ด้วย `TOKEN_KEY`) + `device_daily` (ข้อมูลที่แปลงหน่วยแล้ว)
2. คำสั่ง `เชื่อมนาฬิกา` ในแชท → ลิงก์ผูกบัญชีแบบใช้ครั้งเดียว → หน้าเลือก Whoop/Fitbit → OAuth
3. `src/wearables.js` — adapter แยกรายเจ้า **แก้ mapping ที่เดียวจบ** ตอนเจอว่าฟิลด์จริงไม่ตรง
4. Cron ดึงข้อมูลย้อนหลัง 2 วันทุกรอบ (กันข้อมูลมาช้า) แล้ว upsert ลง `device_daily`
5. เจอ workout ของสมาชิกชาเลนจ์ → เช็คอินอัตโนมัติ (`workouts.source = 'device'`)
6. หน้า dashboard เพิ่มส่วนนอน/recovery + คำสั่ง `นอน` ในแชท

**ไม่ทำ**: ไม่เอาแคลที่เผาไปหักในโหมดนับแคล (เจ้าของเลือกไม่เอา — TDEE คิดค่ากิจกรรมไว้แล้ว หักซ้ำจะเบิ้ล)
