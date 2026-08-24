-- Yes Cal — D1 schema
-- ใช้ครั้งแรก: npx wrangler d1 execute yes-cal --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  line_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  sex TEXT,                 -- 'male' | 'female'
  age INTEGER,
  height_cm REAL,
  weight_kg REAL,
  activity REAL,            -- 1.2 - 1.9
  goal_type TEXT,           -- 'lose' | 'maintain' | 'gain'
  target_kcal INTEGER,
  target_protein_g INTEGER, -- เป้าโปรตีน/วัน (NULL = คำนวณจากน้ำหนัก×เป้าหมายให้อัตโนมัติ)
  setup_state TEXT,         -- ขั้นตอนที่ค้างอยู่ของ flow ตั้งเป้า (NULL = ไม่ได้อยู่ใน flow)
  setup_draft TEXT,         -- JSON คำตอบสะสมระหว่าง flow
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kcal INTEGER NOT NULL,
  protein_g REAL,
  carb_g REAL,
  fat_g REAL,
  source TEXT DEFAULT 'text',   -- 'text' | 'image'
  eaten_date TEXT NOT NULL,     -- YYYY-MM-DD (เวลาไทย)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(line_user_id, eaten_date);

CREATE TABLE IF NOT EXISTS weights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL,
  weight_kg REAL NOT NULL,
  logged_date TEXT NOT NULL,    -- YYYY-MM-DD (เวลาไทย)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_weights_user_date ON weights(line_user_id, logged_date);

-- ห้องแชทที่บอทอยู่ (ไว้ push สรุปตอน 21:00)
CREATE TABLE IF NOT EXISTS chat_targets (
  id TEXT PRIMARY KEY,          -- groupId หรือ userId
  type TEXT NOT NULL,           -- 'group' | 'room' | 'user'
  mode TEXT DEFAULT 'calorie',  -- 'calorie' (นับแคล) | 'challenge' (ชาเลนจ์ออกกำลังกาย)
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============ โหมดชาเลนจ์ออกกำลังกาย (workout challenge) ============
-- กลุ่มไหนพิมพ์ "โหมดชาเลนจ์" จะสลับมาโหมดนี้ (เก็บใน chat_targets.mode)

-- สมาชิกที่เข้าร่วมชาเลนจ์ในแต่ละกลุ่ม (ต้องพิมพ์ "เข้าร่วม" เอง
-- เพราะ LINE ให้ดึงรายชื่อสมาชิกกลุ่มได้เฉพาะ OA ที่ verified)
CREATE TABLE IF NOT EXISTS challenge_members (
  chat_id TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  display_name TEXT,
  active INTEGER DEFAULT 1,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, line_user_id)
);

CREATE TABLE IF NOT EXISTS workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  activity TEXT NOT NULL,
  duration_min INTEGER,
  kcal INTEGER,
  source TEXT DEFAULT 'image',   -- 'image' | 'text'
  message_id TEXT,               -- id ข้อความ LINE ที่ทำให้เกิดรายการนี้ (ไว้ reply มาแก้วันที่)
  reply_message_id TEXT,         -- id ข้อความที่บอทตอบกลับ (reply ที่ข้อความบอทก็แก้วันที่ได้)
  logged_date TEXT NOT NULL,     -- YYYY-MM-DD (เวลาไทย)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workouts_chat_date ON workouts(chat_id, logged_date);
CREATE INDEX IF NOT EXISTS idx_workouts_member ON workouts(chat_id, line_user_id, logged_date);

-- ลิงก์หน้าสถิติเฉพาะกลุ่ม — แต่ละกลุ่มมีโทเคนของตัวเอง เปิดได้เฉพาะข้อมูลกลุ่มตัวเอง
-- worker สร้างตารางนี้ให้เองถ้ายังไม่มี (ensureTokenTable) ไม่ต้องรัน migration เอง
CREATE TABLE IF NOT EXISTS chat_view_tokens (
  chat_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============ เชื่อมบัญชีนาฬิกา (WHOOP / Fitbit ผ่าน Google Health) ============
-- worker สร้างสามตารางนี้ให้เองตอนใช้งานครั้งแรก (ensureWearableTables) ไม่ต้องรัน migration
-- โทเคนถูกเข้ารหัส AES-GCM ด้วย secret TOKEN_KEY ก่อนเขียนลงมา ไม่ได้เก็บเป็น plain text

-- ลิงก์ผูกบัญชีที่บอทออกให้ในแชท อายุ 15 นาที ใช้ได้ครั้งเดียว
CREATE TABLE IF NOT EXISTS oauth_links (
  token TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  chat_id TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- state กัน CSRF ระหว่างเด้งไปหน้ายินยอมของผู้ให้บริการ (WHOOP บังคับยาว >= 8 ตัวอักษร)
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  chat_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS device_links (
  line_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,          -- 'whoop' | 'google'
  access_token TEXT NOT NULL,      -- เข้ารหัสแล้ว
  refresh_token TEXT,              -- เข้ารหัสแล้ว
  expires_at TEXT,
  scope TEXT,
  provider_user_id TEXT,
  display_name TEXT,
  connected_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT,
  PRIMARY KEY (line_user_id, provider)
);

-- นับการเรียก API รายวัน ไว้ดูว่าใช้โควตาฟรีไปเท่าไหร่ (ดูผลที่ /api/health)
CREATE TABLE IF NOT EXISTS api_usage (
  day TEXT NOT NULL,            -- YYYY-MM-DD (เวลาไทย)
  kind TEXT NOT NULL,           -- 'gemini' | 'push'
  label TEXT NOT NULL DEFAULT '',-- ชื่อรุ่น Gemini / ประเภท push
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, label)
);

-- เก็บ id ข้อความ LINE ของรายการเช็คอิน เพื่อให้ reply กลับไปที่ข้อความนั้นแล้วแก้วันที่ได้
-- ตารางที่มีอยู่แล้วให้รันเพิ่ม:
--   ALTER TABLE workouts ADD COLUMN message_id TEXT;
--   ALTER TABLE workouts ADD COLUMN reply_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_workouts_message ON workouts(chat_id, message_id);
CREATE INDEX IF NOT EXISTS idx_workouts_reply ON workouts(chat_id, reply_message_id);
