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
  created_at TEXT DEFAULT (datetime('now'))
);
