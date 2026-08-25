// เชื่อมบัญชีนาฬิกา (WHOOP / Fitbit ผ่าน Google Health API) เข้ากับผู้ใช้ LINE
//
// ทำไมแยกไฟล์: src/index.js ยาวเกินไปแล้ว และ mapping ของแต่ละเจ้าจะต้องแก้บ่อยตอนเจอ
// response จริง อยู่ไฟล์เดียวจะหาง่ายกว่า
//
// ขั้นตอนการเชื่อม (ออกแบบให้ผูกกับ "คนใน LINE" ไม่ใช่ session บนเว็บ):
//   1. พิมพ์ "เชื่อมนาฬิกา" ในแชท → สร้าง link token อายุ 15 นาที → บอทตอบลิงก์ /connect?t=...
//   2. เปิดลิงก์ → เลือกยี่ห้อ → /oauth/{provider}/start?t=... → สร้าง state → เด้งไปหน้ายินยอม
//   3. /oauth/{provider}/callback → ตรวจ state → แลก code เป็น token → เก็บแบบเข้ารหัส
//
// โทเคนทั้งหมดเข้ารหัส AES-GCM ด้วย secret TOKEN_KEY ก่อนลง D1

const trim = (env, name) => (env[name] || "").trim();

export const PROVIDERS = {
  whoop: {
    label: "WHOOP",
    authUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
    tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
    // offline ต้องส่งไปเองตอน authorize — ไม่มีให้ติ๊กในหน้า dashboard
    // ถ้าไม่ใส่ WHOOP จะไม่คืน refresh_token มาให้ แปลว่าหมดอายุแล้วต้องให้ผู้ใช้ล็อกอินใหม่ทุกครั้ง
    scope: "read:workout read:sleep read:recovery read:profile offline",
    clientIdVar: "WHOOP_CLIENT_ID",
    clientSecretVar: "WHOOP_CLIENT_SECRET",
    extraAuthParams: {},
    // ยืนยันว่าโทเคนใช้ได้จริง — v2 เป็นตัวปัจจุบัน เผื่อ v1 ไว้กันเหนียว
    verifyUrls: [
      "https://api.prod.whoop.com/developer/v2/user/profile/basic",
      "https://api.prod.whoop.com/developer/v1/user/profile/basic",
    ],
  },
  google: {
    label: "Fitbit (Google Health)",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: [
      "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
      "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
      "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    ].join(" "),
    clientIdVar: "GOOGLE_CLIENT_ID",
    clientSecretVar: "GOOGLE_CLIENT_SECRET",
    // ไม่ใส่สองตัวนี้ Google จะไม่คืน refresh_token ในการยินยอมครั้งที่สองเป็นต้นไป
    extraAuthParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    verifyUrls: ["https://health.googleapis.com/v4/users/me/identity"],
  },
};

export const redirectUri = (origin, provider) => `${origin}/oauth/${provider}/callback`;

// ---------------------------------------------------------------- เข้ารหัสโทเคน

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(env) {
  const secret = trim(env, "TOKEN_KEY");
  if (!secret) throw new Error("TOKEN_KEY ยังไม่ได้ตั้ง — ตั้งด้วย: npx wrangler secret put TOKEN_KEY");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env, plain) {
  if (!plain) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(plain)
  );
  return b64(iv) + "." + b64(new Uint8Array(buf));
}

export async function decryptSecret(env, blob) {
  if (!blob) return null;
  const [ivPart, dataPart] = String(blob).split(".");
  if (!dataPart) return null;
  const buf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(ivPart) }, await aesKey(env), unb64(dataPart)
  );
  return new TextDecoder().decode(buf);
}

// ---------------------------------------------------------------- ตาราง

let tablesReady = false;
export async function ensureWearableTables(env) {
  if (tablesReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS oauth_links (
       token TEXT PRIMARY KEY, line_user_id TEXT NOT NULL, chat_id TEXT,
       expires_at TEXT NOT NULL, used_at TEXT,
       created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS oauth_states (
       state TEXT PRIMARY KEY, provider TEXT NOT NULL, line_user_id TEXT NOT NULL,
       chat_id TEXT, expires_at TEXT NOT NULL,
       created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS device_links (
       line_user_id TEXT NOT NULL, provider TEXT NOT NULL,
       access_token TEXT NOT NULL, refresh_token TEXT,
       expires_at TEXT, scope TEXT, provider_user_id TEXT, display_name TEXT,
       connected_at TEXT DEFAULT (datetime('now')), updated_at TEXT,
       PRIMARY KEY (line_user_id, provider))`,
    // คะแนนการนอนที่ผู้ใช้กรอกเอง — API ไม่มีให้ดึง แต่สูตร readiness ต้องใช้
    `CREATE TABLE IF NOT EXISTS sleep_scores (
       line_user_id TEXT NOT NULL, date TEXT NOT NULL, score INTEGER NOT NULL,
       created_at TEXT DEFAULT (datetime('now')),
       PRIMARY KEY (line_user_id, date))`,
  ];
  for (const sql of stmts) await env.DB.prepare(sql).run();

  // เก็บ id ของรายการฝั่งผู้ให้บริการไว้แยกจาก message_id ของ LINE
  // (message_id ต้องคงไว้ ไม่งั้น reply ที่รูปแล้วสั่งย้ายวันจะหารายการไม่เจอ)
  // ตารางมีอยู่ก่อนแล้วจึงต้องเติมคอลัมน์ทีหลัง — รันซ้ำได้ ถ้ามีแล้วจะ throw แล้วข้ามไป
  for (const sql of [
    `ALTER TABLE workouts ADD COLUMN device_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_workouts_device ON workouts(chat_id, device_id)`,
  ]) {
    try { await env.DB.prepare(sql).run(); } catch { /* มีอยู่แล้ว */ }
  }
  tablesReady = true;
}

const randomToken = () => crypto.randomUUID().replace(/-/g, "");
const inMinutes = (n) => new Date(Date.now() + n * 60000).toISOString();
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- ลิงก์ผูกบัญชี (ใช้ครั้งเดียว)

export async function createLinkToken(env, lineUserId, chatId) {
  await ensureWearableTables(env);
  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO oauth_links (token, line_user_id, chat_id, expires_at) VALUES (?, ?, ?, ?)`
  ).bind(token, lineUserId, chatId || null, inMinutes(15)).run();
  return token;
}

export async function readLinkToken(env, token) {
  if (!token) return null;
  await ensureWearableTables(env);
  const row = await env.DB.prepare(
    `SELECT line_user_id, chat_id FROM oauth_links
     WHERE token = ? AND used_at IS NULL AND expires_at > ?`
  ).bind(token, nowIso()).first();
  return row || null;
}

// ปิดลิงก์หลังเชื่อมสำเร็จ จะได้ใช้ซ้ำไม่ได้
export async function consumeLinkToken(env, token) {
  await env.DB.prepare(`UPDATE oauth_links SET used_at = ? WHERE token = ?`)
    .bind(nowIso(), token).run();
}

// ---------------------------------------------------------------- state (กัน CSRF)

// WHOOP บังคับว่า state ต้องยาวอย่างน้อย 8 ตัวอักษร — 32 ตัวนี้ผ่านสบาย
export async function createState(env, provider, lineUserId, chatId) {
  await ensureWearableTables(env);
  const state = randomToken();
  await env.DB.prepare(
    `INSERT INTO oauth_states (state, provider, line_user_id, chat_id, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(state, provider, lineUserId, chatId || null, inMinutes(15)).run();
  return state;
}

export async function consumeState(env, state) {
  if (!state) return null;
  await ensureWearableTables(env);
  const row = await env.DB.prepare(
    `SELECT provider, line_user_id, chat_id FROM oauth_states WHERE state = ? AND expires_at > ?`
  ).bind(state, nowIso()).first();
  if (row) await env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(state).run();
  return row || null;
}

// ---------------------------------------------------------------- OAuth

export function buildAuthUrl(env, provider, origin, state) {
  const p = PROVIDERS[provider];
  const url = new URL(p.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", trim(env, p.clientIdVar));
  url.searchParams.set("redirect_uri", redirectUri(origin, provider));
  url.searchParams.set("scope", p.scope);
  url.searchParams.set("state", state);
  for (const [k, v] of Object.entries(p.extraAuthParams)) url.searchParams.set(k, v);
  return url.toString();
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ผู้ให้บริการตอบไม่เป็น JSON */ }
  if (!res.ok) {
    throw new Error(`${url} → ${res.status} ${text.slice(0, 200)}`);
  }
  return json;
}

export async function exchangeCode(env, provider, origin, code) {
  const p = PROVIDERS[provider];
  return postForm(p.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(origin, provider),
    client_id: trim(env, p.clientIdVar),
    client_secret: trim(env, p.clientSecretVar),
  });
}

async function refreshTokens(env, provider, refreshToken) {
  const p = PROVIDERS[provider];
  const body = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: trim(env, p.clientIdVar),
    client_secret: trim(env, p.clientSecretVar),
  };
  // WHOOP ต้องส่ง scope offline ซ้ำตอน refresh ไม่งั้นจะไม่ได้ refresh_token อันใหม่กลับมา
  if (provider === "whoop") body.scope = "offline";
  return postForm(p.tokenUrl, body);
}

// ---------------------------------------------------------------- เก็บ / อ่านโทเคน

export async function saveTokens(env, lineUserId, provider, tokens, extra = {}) {
  await ensureWearableTables(env);
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
    : null;
  const existing = await env.DB.prepare(
    `SELECT refresh_token FROM device_links WHERE line_user_id = ? AND provider = ?`
  ).bind(lineUserId, provider).first();

  // Google ไม่คืน refresh_token ซ้ำในการยินยอมครั้งถัด ๆ ไป — เก็บของเดิมไว้อย่าทับด้วย null
  const refresh = tokens.refresh_token
    ? await encryptSecret(env, tokens.refresh_token)
    : existing?.refresh_token || null;

  await env.DB.prepare(
    `INSERT INTO device_links
       (line_user_id, provider, access_token, refresh_token, expires_at, scope, provider_user_id, display_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(line_user_id, provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       provider_user_id = COALESCE(excluded.provider_user_id, device_links.provider_user_id),
       display_name = COALESCE(excluded.display_name, device_links.display_name),
       updated_at = excluded.updated_at`
  ).bind(
    lineUserId, provider,
    await encryptSecret(env, tokens.access_token),
    refresh, expiresAt, tokens.scope || PROVIDERS[provider].scope,
    extra.providerUserId || null, extra.displayName || null, nowIso()
  ).run();
}

// คืน access token ที่ใช้ได้จริง ต่ออายุให้เองถ้าใกล้หมด
// คืน null ถ้ายังไม่ได้เชื่อม หรือ refresh ไม่ผ่าน (ผู้ใช้ถอนสิทธิ์แล้ว)
export async function getAccessToken(env, lineUserId, provider) {
  await ensureWearableTables(env);
  const row = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM device_links
     WHERE line_user_id = ? AND provider = ?`
  ).bind(lineUserId, provider).first();
  if (!row) return null;

  const stillGood = !row.expires_at || new Date(row.expires_at).getTime() - Date.now() > 60000;
  if (stillGood) return decryptSecret(env, row.access_token);

  if (!row.refresh_token) return null;
  try {
    const refreshed = await refreshTokens(env, provider, await decryptSecret(env, row.refresh_token));
    await saveTokens(env, lineUserId, provider, refreshed);
    return refreshed.access_token;
  } catch (e) {
    console.error(`refresh ${provider} ล้มเหลว`, e.message);
    return null;
  }
}

export async function listConnections(env, lineUserId) {
  await ensureWearableTables(env);
  return (await env.DB.prepare(
    `SELECT provider, display_name, connected_at, expires_at FROM device_links
     WHERE line_user_id = ? ORDER BY connected_at`
  ).bind(lineUserId).all()).results;
}

export async function disconnect(env, lineUserId, provider) {
  await ensureWearableTables(env);
  const r = await env.DB.prepare(
    `DELETE FROM device_links WHERE line_user_id = ? AND provider = ?`
  ).bind(lineUserId, provider).run();
  return r;
}

// เรียก endpoint เบา ๆ ของผู้ให้บริการ เพื่อพิสูจน์ว่าโทเคนใช้ได้จริงตั้งแต่ตอนเชื่อมเสร็จ
// ไม่ให้ล้มทั้งกระบวนการถ้าพลาด — เชื่อมสำเร็จแล้วยังไงก็เก็บโทเคนไว้ก่อน
export async function verifyConnection(env, provider, accessToken) {
  for (const url of PROVIDERS[provider].verifyUrls) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) continue;
      const data = await res.json();
      return {
        ok: true,
        providerUserId: String(data.user_id || data.userId || data.name || "") || null,
        displayName: [data.first_name, data.last_name].filter(Boolean).join(" ") || null,
      };
    } catch (e) {
      console.error(`verify ${provider} ${url}`, e.message);
    }
  }
  return { ok: false };
}

// ---------------------------------------------------------------- แปลงข้อมูลให้อยู่รูปเดียวกัน

// ชื่อกีฬาที่ WHOOP ส่งมาเป็น slug อังกฤษ — แปลเท่าที่เจอบ่อย ที่เหลือแค่เอาขีดออก
const SPORT_TH = {
  weightlifting: "เวทเทรนนิ่ง", walking: "เดิน", running: "วิ่ง", cycling: "ปั่นจักรยาน",
  swimming: "ว่ายน้ำ", yoga: "โยคะ", pilates: "พิลาทิส", "reformer-pilates": "พิลาทิส (reformer)",
  "functional-fitness": "ฟังก์ชันนัลเทรนนิ่ง", hiit: "HIIT", boxing: "ชกมวย", golf: "กอล์ฟ",
  tennis: "เทนนิส", badminton: "แบดมินตัน", basketball: "บาสเกตบอล", soccer: "ฟุตบอล",
  rowing: "เรือพาย", elliptical: "เครื่องเดินวงรี", stairmaster: "เครื่องเดินขั้นบันได",
  "jump-rope": "กระโดดเชือก", hiking: "เดินป่า", dancing: "เต้น", "martial-arts": "ศิลปะการต่อสู้",
  activity: "กิจกรรมทั่วไป", meditation: "นั่งสมาธิ",
  // ชื่อที่ Fitbit/Google ส่งมา (displayName กับ exerciseType)
  workout: "ออกกำลังกาย", walk: "เดิน", run: "วิ่ง", spinning: "ปั่นจักรยาน (สปิน)",
  bike: "ปั่นจักรยาน", treadmill: "ลู่วิ่ง", "weights": "เวทเทรนนิ่ง", sport: "เล่นกีฬา",
  aerobic_workout: "แอโรบิก", "elliptical-trainer": "เครื่องเดินวงรี", swim: "ว่ายน้ำ",
};
const sportLabel = (slug) => SPORT_TH[slug] || String(slug || "ออกกำลังกาย").replace(/-/g, " ");

// วันที่แบบไทยจากเวลา UTC (ทั้งระบบใช้ UTC+7 อยู่แล้ว)
const bkkDateOf = (iso) => new Date(new Date(iso).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// WHOOP v2 — ยืนยันจาก response จริงเมื่อ 24 ส.ค. 2026
//   { records: [{ id, start, end, timezone_offset, sport_name, score_state,
//                 score: { strain, average_heart_rate, max_heart_rate, kilojoule, distance_meter } }] }
// ไม่มีฟิลด์ระยะเวลา ต้องคิดจาก end - start เอง · แคลอรี่ต้องแปลงจาก kJ
export function normalizeWhoopWorkouts(body) {
  return (body?.records || []).map((r) => {
    const score = r.score_state === "SCORED" ? r.score || {} : {};
    return {
      provider: "whoop",
      external_id: r.id,
      sport: r.sport_name || null,
      activity: sportLabel(r.sport_name),
      date: bkkDateOf(r.start),
      start: r.start,
      end: r.end,
      duration_min: Math.round((new Date(r.end) - new Date(r.start)) / 60000),
      kcal: score.kilojoule != null ? Math.round(score.kilojoule / 4.184) : null,
      avg_hr: score.average_heart_rate ?? null,
      max_hr: score.max_heart_rate ?? null,
      distance_m: score.distance_meter != null ? Math.round(score.distance_meter) : null,
      steps: null,
      active_zone_min: null,
      strain: score.strain != null ? Math.round(score.strain * 10) / 10 : null,
      // WHOOP ไม่บอกว่าผู้ใช้กดเริ่มเองไหม ต้องดูที่ strain แทน
      actively_started: null,
      device: "WHOOP",
      scored: r.score_state === "SCORED",
    };
  });
}

// Google Health API v4 — ยืนยันจาก discovery document
//   { dataPoints: [{ exercise: { displayName, exerciseType, activeDuration,
//       interval: { startTime, endTime },
//       metricsSummary: { caloriesKcal, averageHeartRateBeatsPerMinute, distanceMillimeters } } }] }
// ระวัง: averageHeartRateBeatsPerMinute กับ steps ส่งมาเป็น string ต้องแปลงก่อนใช้
export function normalizeGoogleWorkouts(body) {
  return (body?.dataPoints || [])
    .filter((d) => d.exercise)
    .map((d) => {
      const ex = d.exercise;
      const m = ex.metricsSummary || {};
      const src = d.dataSource || {};
      const start = ex.interval?.startTime;
      const end = ex.interval?.endTime;
      // activeDuration มาเป็น duration string เช่น "1800s" — ถ้าไม่มีก็คิดจากช่วงเวลาแทน
      const activeSec = ex.activeDuration ? parseFloat(String(ex.activeDuration).replace("s", "")) : null;
      return {
        provider: "google",
        external_id: d.name || `${start}-${ex.exerciseType || ""}`,
        sport: String(ex.exerciseType || "").toLowerCase() || null,
        activity: googleActivityLabel(ex),
        // ACTIVELY_MEASURED = กดเริ่มเอง · PASSIVELY_MEASURED = นาฬิกาจับให้เอง
        // ใช้ตัดสินเช็คอินอัตโนมัติ ตรงกว่าการเดาจากชื่อกีฬา
        actively_started: src.recordingMethod === "ACTIVELY_MEASURED",
        device: src.device?.displayName || null,
        date: bkkDateOf(start),
        start,
        end,
        duration_min: activeSec != null
          ? Math.round(activeSec / 60)
          : start && end ? Math.round((new Date(end) - new Date(start)) / 60000) : null,
        kcal: m.caloriesKcal != null ? Math.round(m.caloriesKcal) : null,
        avg_hr: num(m.averageHeartRateBeatsPerMinute),
        max_hr: null,
        distance_m: m.distanceMillimeters != null ? Math.round(m.distanceMillimeters / 1000) : null,
        steps: num(m.steps),
        active_zone_min: num(m.activeZoneMinutes),
        strain: null,
        scored: true,
      };
    });
}

// displayName ของ Fitbit บางทีเจาะจงกว่า exerciseType (เช่น "Spinning" ทั้งที่ type เป็น WORKOUT)
// บางทีก็กว้างกว่า ("Workout") — เลือกอันที่แปลไทยได้ก่อน ถ้าไม่มีค่อยใช้ชื่ออังกฤษเดิม
function googleActivityLabel(ex) {
  const shown = String(ex.displayName || "").trim();
  const type = String(ex.exerciseType || "").toLowerCase();
  const shownKey = shown.toLowerCase().replace(/\s+/g, "-");
  if (shownKey && SPORT_TH[shownKey] && shownKey !== type) return SPORT_TH[shownKey];
  if (SPORT_TH[type]) return SPORT_TH[type];
  if (SPORT_TH[shownKey]) return SPORT_TH[shownKey];
  return shown || sportLabel(type);
}

// หลายฟิลด์ของ Google เป็น string ทั้งที่เป็นตัวเลข
function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- การนอน / recovery

const mins = (milli) => (milli == null ? null : Math.round(milli / 60000));

// WHOOP /v2/activity/sleep
// ⚠️ ยังไม่ได้เห็น response จริง — เข้าถึงฟิลด์แบบกันพัง ถ้าชื่อไม่ตรงจะได้ null ไม่ใช่ error
export function normalizeWhoopSleep(body) {
  const r = (body?.records || []).filter((x) => !x.nap)[0] || (body?.records || [])[0];
  if (!r) return null;
  const sc = r.score_state === "SCORED" ? r.score || {} : {};
  const st = sc.stage_summary || {};
  const inBed = mins(st.total_in_bed_time_milli);
  const awake = mins(st.total_awake_time_milli);
  const asleep = inBed != null && awake != null ? inBed - awake : null;
  return {
    provider: "whoop",
    date: bkkDateOf(r.end || r.start),
    start: r.start || null,
    end: r.end || null,
    asleep_min: asleep,
    in_bed_min: inBed,
    awake_min: awake,
    performance_pct: sc.sleep_performance_percentage ?? null,
    efficiency_pct: sc.sleep_efficiency_percentage ?? null,
    deep_min: mins(st.total_slow_wave_sleep_time_milli),
    rem_min: mins(st.total_rem_sleep_time_milli),
    light_min: mins(st.total_light_sleep_time_milli),
    scored: r.score_state === "SCORED",
  };
}

// Google Health — ยืนยันจาก discovery document (minutesAsleep ฯลฯ เป็น string)
//
// ⚠️ API **ไม่มี Sleep score และไม่มี Readiness** ที่แอป Google Health โชว์
// ค้นทั้ง discovery document แล้ว คำว่า readiness ปรากฏ 0 ครั้ง ไม่มีฟิลด์ score ที่ไหนเลย
// สองค่านั้นแอปคำนวณเอง ไม่ได้เปิดให้ดึง — อย่าไปกุตัวเลขขึ้นมาแทน
export function normalizeGoogleSleep(body) {
  const points = (body?.dataPoints || []).filter((x) => x.sleep);
  // mainSleep บอกเองว่าอันไหนคือการนอนหลักของคืนนั้น ไม่ต้องเดา
  const d = points.find((x) => x.sleep.metadata?.mainSleep) || points[0];
  if (!d) return null;
  const sum = d.sleep.summary || {};
  const asleep = num(sum.minutesAsleep);
  const inBed = num(sum.minutesInSleepPeriod);
  // stagesSummary: [{ type: "DEEP" | "REM" | "LIGHT" | "AWAKE", minutes, count }]
  const stage = (t) => {
    const hit = (sum.stagesSummary || []).find((x) => String(x.type).toUpperCase() === t);
    return hit ? num(hit.minutes) : null;
  };
  return {
    provider: "google",
    date: bkkDateOf(d.sleep.interval?.endTime || d.sleep.interval?.startTime),
    start: d.sleep.interval?.startTime || null,
    end: d.sleep.interval?.endTime || null,
    asleep_min: asleep,
    in_bed_min: inBed,
    awake_min: num(sum.minutesAwake),
    performance_pct: null,
    efficiency_pct: asleep && inBed ? Math.round((asleep / inBed) * 100) : null,
    deep_min: stage("DEEP"),
    rem_min: stage("REM"),
    light_min: stage("LIGHT"),
    scored: true,
  };
}

// WHOOP /v2/recovery — ⚠️ ยังไม่ได้เห็น response จริงเช่นกัน
export function normalizeWhoopRecovery(body) {
  const r = (body?.records || [])[0];
  if (!r) return null;
  const sc = r.score_state === "SCORED" ? r.score || {} : {};
  return {
    provider: "whoop",
    recovery_pct: sc.recovery_score != null ? Math.round(sc.recovery_score) : null,
    resting_hr: sc.resting_heart_rate ?? null,
    hrv_ms: sc.hrv_rmssd_milli != null ? Math.round(sc.hrv_rmssd_milli) : null,
    scored: r.score_state === "SCORED",
  };
}

// Google ไม่มีคะแนน recovery — ประกอบเองจากหัวใจขณะพัก + HRV รายวัน (คนละ endpoint)
export function normalizeGoogleRecovery(rhrBody, hrvBody) {
  const rhr = (rhrBody?.dataPoints || []).filter((d) => d.dailyRestingHeartRate)[0];
  const hrv = (hrvBody?.dataPoints || []).filter((d) => d.dailyHeartRateVariability)[0];
  if (!rhr && !hrv) return null;
  const ms = hrv?.dailyHeartRateVariability?.averageHeartRateVariabilityMilliseconds;
  return {
    provider: "google",
    recovery_pct: null,
    resting_hr: num(rhr?.dailyRestingHeartRate?.beatsPerMinute),
    hrv_ms: ms != null ? Math.round(ms) : null,
    scored: true,
  };
}

// ---------------------------------------------------------------- Readiness (ฝั่ง Fitbit)
//
// Google Health API ไม่มี Readiness ให้ดึง (คำนี้ไม่ปรากฏใน discovery document เลย)
// เจ้าของจึงให้สูตรคำนวณมาเอง — ส่วนนี้คือสูตรนั้นแบบตรงตัว
//
// ⚠️ ตัวแปร sleep_score ในสูตรใช้ "ค่าจาก API" ไม่ได้ เพราะ API ไม่มีคะแนนการนอนเช่นกัน
//    ถ้าไม่มีคะแนนจริงส่งเข้ามา จะใช้ค่าประมาณจาก estimateSleepScore() แทน
//    และตั้งธง sleep_score_estimated ไว้ให้รู้ว่าเลขนี้ไม่ใช่ของ Fitbit จริง
export function readinessScore({ todayHrv, baselineHrv, sleepScore, prevDayAzm }) {
  if (todayHrv == null || !baselineHrv || sleepScore == null) return null;

  const hrvRatio = todayHrv / baselineHrv;
  const hrvComp = hrvRatio >= 1.0
    ? Math.min(100, 85 + (hrvRatio - 1.0) * 50)
    : Math.max(0, 85 - (1.0 - hrvRatio) * 120);

  const sleepComp = sleepScore;

  const azm = prevDayAzm ?? 0;
  const activityComp = azm <= 40 ? 100 : Math.max(40, 100 - (azm - 40) * 0.8);

  return Math.round(hrvComp * 0.45 + sleepComp * 0.35 + activityComp * 0.20);
}

// ค่าประมาณคะแนนการนอน ใช้เฉพาะตอนไม่มีคะแนนจริง
// อิงสัดส่วนที่ Fitbit ใช้: ระยะเวลา 50% · คุณภาพ (หลับลึก+REM) 25% · ความต่อเนื่อง 25%
// **ไม่ใช่ Sleep score ของ Fitbit** ตัวเลขจะสูงกว่าของจริงอยู่พอสมควร
export function estimateSleepScore(sleep) {
  if (!sleep?.asleep_min) return null;
  const duration = Math.min(100, (sleep.asleep_min / 480) * 100);
  const restorative = (sleep.deep_min || 0) + (sleep.rem_min || 0);
  const quality = restorative
    ? Math.min(100, (restorative / sleep.asleep_min / 0.4) * 100)
    : duration;
  const continuity = sleep.efficiency_pct ?? 90;
  return Math.round(duration * 0.5 + quality * 0.25 + continuity * 0.25);
}

// HRV วันนี้ + ค่าฐานจากวันก่อน ๆ (ไม่รวมวันนี้ ไม่งั้นค่าฐานจะวิ่งตามตัวเอง)
export function hrvSeries(body) {
  const days = (body?.dataPoints || [])
    .filter((d) => d.dailyHeartRateVariability?.averageHeartRateVariabilityMilliseconds != null)
    .map((d) => d.dailyHeartRateVariability.averageHeartRateVariabilityMilliseconds);
  if (!days.length) return { today: null, baseline: null, days: 0 };
  const rest = days.slice(1);
  const baseline = rest.length
    ? rest.reduce((a, b) => a + b, 0) / rest.length
    : days[0];
  return { today: days[0], baseline, days: days.length };
}

// รวม active zone minutes ของ "เมื่อวาน" — ข้อมูลมาเป็นช่วง ๆ ต้องบวกเอง
export function azmForDate(body, date) {
  const points = (body?.dataPoints || []).filter((d) => d.activeZoneMinutes);
  let total = 0;
  let found = false;
  for (const d of points) {
    const start = d.activeZoneMinutes.interval?.startTime;
    if (!start || bkkDateOf(start) !== date) continue;
    found = true;
    total += num(d.activeZoneMinutes.activeZoneMinutes) || 0;
  }
  return found ? Math.round(total) : null;
}

export async function setSleepScore(env, lineUserId, date, score) {
  await ensureWearableTables(env);
  await env.DB.prepare(
    `INSERT INTO sleep_scores (line_user_id, date, score) VALUES (?, ?, ?)
     ON CONFLICT(line_user_id, date) DO UPDATE SET score = excluded.score`
  ).bind(lineUserId, date, score).run();
}

export async function getSleepScore(env, lineUserId, date) {
  await ensureWearableTables(env);
  const row = await env.DB.prepare(
    `SELECT score FROM sleep_scores WHERE line_user_id = ? AND date = ?`
  ).bind(lineUserId, date).first();
  return row?.score ?? null;
}

// ดึงการนอน + recovery ของคืนล่าสุดของคนคนเดียว
// คืน null ถ้ายังไม่ได้เชื่อมนาฬิกา · ฟิลด์ไหนดึงไม่ได้ก็เป็น null ไม่ให้ทั้งก้อนพัง
export async function getNightSummary(env, lineUserId) {
  await ensureWearableTables(env);
  const link = await env.DB.prepare(
    `SELECT provider FROM device_links WHERE line_user_id = ? ORDER BY updated_at DESC LIMIT 1`
  ).bind(lineUserId).first();
  if (!link) return null;

  const provider = link.provider;
  const token = await getAccessToken(env, lineUserId, provider);
  if (!token) return { provider, error: "โทเคนใช้ไม่ได้แล้ว ต้องเชื่อมนาฬิกาใหม่" };

  const get = async (kind) => {
    const url = DATA_URLS[provider]?.[kind];
    if (!url) return null;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return res.ok ? await res.json() : null;
    } catch (e) {
      console.error(`ดึง ${provider}/${kind} ไม่ได้`, e.message);
      return null;
    }
  };

  if (provider === "whoop") {
    const [sleepBody, recBody] = await Promise.all([get("sleep"), get("recovery")]);
    return {
      provider,
      sleep: sleepBody ? normalizeWhoopSleep(sleepBody) : null,
      recovery: recBody ? normalizeWhoopRecovery(recBody) : null,
    };
  }
  const [sleepBody, rhrBody, hrvBody, azmBody] = await Promise.all([
    get("sleep"), get("recovery"), get("hrv"), get("azm"),
  ]);
  const sleep = sleepBody ? normalizeGoogleSleep(sleepBody) : null;
  const recovery = normalizeGoogleRecovery(rhrBody, hrvBody) || {
    provider: "google", recovery_pct: null, resting_hr: null, hrv_ms: null, scored: true,
  };

  // Fitbit ไม่มี Readiness ให้ดึง — คำนวณตามสูตรที่เจ้าของกำหนด
  const hrv = hrvSeries(hrvBody);
  const yesterday = bkkDateOffsetLocal(-1);
  const azm = azmForDate(azmBody, yesterday);

  // คะแนนการนอนจริงที่ผู้ใช้กรอกไว้มาก่อนค่าประมาณเสมอ
  const real = sleep?.date ? await getSleepScore(env, lineUserId, sleep.date) : null;
  const sleepScore = real ?? estimateSleepScore(sleep);

  recovery.readiness = readinessScore({
    todayHrv: hrv.today, baselineHrv: hrv.baseline, sleepScore, prevDayAzm: azm,
  });
  recovery.readiness_inputs = {
    hrv_today: hrv.today != null ? Math.round(hrv.today * 10) / 10 : null,
    hrv_baseline: hrv.baseline != null ? Math.round(hrv.baseline * 10) / 10 : null,
    hrv_days: hrv.days,
    sleep_score: sleepScore,
    sleep_score_estimated: real == null,
    prev_day_azm: azm,
  };
  if (sleep) sleep.score_for_readiness = sleepScore;
  return { provider, sleep, recovery };
}

const bkkDateOffsetLocal = (n) =>
  new Date(Date.now() + 7 * 3600 * 1000 + n * 86400 * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- เกณฑ์เช็คอินอัตโนมัติ
//
// เจ้าของเลือกไว้: นับทุกอย่างที่นาฬิกาจับได้ แต่ "เดิน" ต้องหนักพอถึงนับ
// เพราะกีฬาอย่างเวท/พิลาทิสคือตั้งใจไปทำ ส่วนเดินนาฬิกาจับเองแม้ตอนเดินไปเข้าห้องน้ำ
// (ข้อมูลจริง 22 ส.ค. มีรายการ "เดิน 40 นาที strain 1.4 หัวใจเฉลี่ย 86" ซึ่งแทบไม่ต่างจากตอนพัก)
//
// ตัดสินด้วย strain เท่านั้น **ห้ามใช้ระยะทางมาเป็นเกณฑ์** — WHOOP ไม่มี GPS ในตัว
// ระยะทางมาจากมือถือ ไม่ได้พกไปก็เป็น null หรือน้อยผิดปกติ ทั้งที่เดินจริง
// ส่วน strain คิดจากหัวใจที่ข้อมือ วัดได้เสมอไม่ว่าจะพกมือถือหรือไม่
//
// อยากเข้ม/ผ่อนกว่านี้ แก้สองค่านี้ที่เดียวจบ
export const WALK_MIN_STRAIN = 4.0;   // ใช้กับ WHOOP ที่มี strain ให้
export const WALK_MIN_MINUTES = 20;   // ใช้กับ Google ที่ไม่มี strain

const WALK_SPORTS = new Set(["walking", "walk"]);

// คืน { ok, why } — why ไว้บอกในแชทได้ว่าทำไมรายการนั้นไม่ถูกนับ
export function countsAsCheckin(w) {
  if (!w.scored) return { ok: false, why: "นาฬิกายังคำนวณคะแนนไม่เสร็จ" };
  if (!w.duration_min) return { ok: false, why: "ไม่มีระยะเวลา" };

  // กดเริ่มเอง = ตั้งใจไปออกกำลังกาย นับเลยไม่ต้องดูอย่างอื่น
  if (w.actively_started === true) return { ok: true };
  // นาฬิกาจับให้เองและไม่ใช่การเดิน (เช่น Fitbit จับว่าวิ่ง) ก็นับ
  if (!WALK_SPORTS.has(w.sport)) return { ok: true };

  if (w.strain != null) {
    return w.strain >= WALK_MIN_STRAIN
      ? { ok: true }
      : { ok: false, why: `เดินเบาเกินไป (strain ${w.strain}) ไม่นับเป็นการออกกำลังกาย` };
  }
  // ฝั่ง Fitbit ไม่มี strain — ใช้เวลา หรือ active zone minutes (นาทีที่หัวใจขึ้นโซนจริง) แทน
  if ((w.duration_min || 0) >= WALK_MIN_MINUTES) return { ok: true };
  if ((w.active_zone_min || 0) >= 15) return { ok: true };
  return { ok: false, why: `เดินสั้นเกินไป (${w.duration_min} นาที)` };
}

export const normalizeWorkouts = (provider, body) =>
  provider === "whoop" ? normalizeWhoopWorkouts(body) : normalizeGoogleWorkouts(body);

// ดึงรายการออกกำลังกายล่าสุดของคนคนเดียว แปลงเป็นรูปแบบกลางแล้ว
// คืน [] ถ้าเชื่อมไม่ได้ — ให้ตัวเรียกทำงานต่อกับคนอื่นได้ ไม่ล้มทั้งรอบ
export async function recentWorkouts(env, lineUserId, provider) {
  const token = await getAccessToken(env, lineUserId, provider);
  if (!token) return [];
  try {
    const res = await fetch(DATA_URLS[provider].workout, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`ดึง workout ของ ${provider} ไม่ได้: ${res.status}`);
      return [];
    }
    return normalizeWorkouts(provider, await res.json());
  } catch (e) {
    console.error(`ดึง workout ของ ${provider} พัง`, e.message);
    return [];
  }
}

// ---------------------------------------------------------------- ดูข้อมูลดิบ (ไว้ debug)

// endpoint ที่ผู้ให้บริการใช้ดึงข้อมูลจริง — ฝั่ง Google ยืนยันจาก discovery doc แล้ว
// ฝั่ง WHOOP ยังไม่ได้เทียบกับของจริง (developer.whoop.com เข้าไม่ได้จาก session ที่เขียนโค้ดนี้)
export const DATA_URLS = {
  whoop: {
    workout: "https://api.prod.whoop.com/developer/v2/activity/workout?limit=5",
    sleep: "https://api.prod.whoop.com/developer/v2/activity/sleep?limit=5",
    recovery: "https://api.prod.whoop.com/developer/v2/recovery?limit=5",
  },
  google: {
    workout: "https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints?pageSize=5",
    sleep: "https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints?pageSize=5",
    recovery:
      "https://health.googleapis.com/v4/users/me/dataTypes/daily-resting-heart-rate/dataPoints?pageSize=5",
    hrv: "https://health.googleapis.com/v4/users/me/dataTypes/daily-heart-rate-variability/dataPoints?pageSize=30",
    azm: "https://health.googleapis.com/v4/users/me/dataTypes/active-zone-minutes/dataPoints?pageSize=300",
  },
};

// ทั้งสองเจ้าคืนรายการใหม่สุดมาก่อน จึงหยิบตัวแรกได้เลย ไม่ต้องยุ่งกับ filter ตามวันที่

// เจ้าของเรียกดูได้ว่าผู้ให้บริการส่งอะไรกลับมาจริง ๆ ไว้ใช้แมปฟิลด์ให้ถูก
// ไม่ได้ตั้งใจให้ใช้ประจำ — ต้องมี DASHBOARD_KEY ถึงเรียกได้
export async function peekRaw(env, provider, kind, lineUserId) {
  await ensureWearableTables(env);
  const url = DATA_URLS[provider]?.[kind];
  if (!url) return { error: `ไม่รู้จัก provider/kind: ${provider}/${kind}` };

  let userId = lineUserId;
  if (!userId) {
    const row = await env.DB.prepare(
      `SELECT line_user_id FROM device_links WHERE provider = ? ORDER BY updated_at DESC LIMIT 1`
    ).bind(provider).first();
    userId = row?.line_user_id;
  }
  if (!userId) return { error: `ยังไม่มีใครเชื่อม ${provider} ไว้` };

  const token = await getAccessToken(env, userId, provider);
  if (!token) return { error: "ไม่มีโทเคนที่ใช้ได้ (ยังไม่เชื่อม หรือถูกถอนสิทธิ์ไปแล้ว)" };

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 800); }
  return { url, status: res.status, body };
}

// เช็คว่าตั้ง secret ครบไหม ใช้ตอบใน /api/health และกันไม่ให้เริ่ม flow ทั้งที่ยังตั้งไม่ครบ
// ระวัง: บอกได้แค่ว่า "ไม่ว่าง" ไม่ได้แปลว่า "ค่าถูก" — ดูของจริงที่ providerDiagnostics()
export function providerReady(env, provider) {
  const p = PROVIDERS[provider];
  return Boolean(p && trim(env, p.clientIdVar) && trim(env, p.clientSecretVar) && trim(env, "TOKEN_KEY"));
}

// รายละเอียดไว้ไล่ปัญหาตอนผู้ให้บริการตอบ invalid_client
// client_id ไม่ใช่ความลับ (ถูกส่งเป็น query string ในหน้าขอสิทธิ์อยู่แล้ว) จึงโชว์เต็มได้
// ส่วน client_secret โชว์แค่ความยาว ห้ามโชว์ค่าจริงเด็ดขาด
export function providerDiagnostics(env, provider) {
  const p = PROVIDERS[provider];
  const id = trim(env, p.clientIdVar);
  const raw = env[p.clientIdVar] || "";
  const secret = trim(env, p.clientSecretVar);
  return {
    ready: providerReady(env, provider),
    problem: configProblem(env, provider),
    client_id: id || null,
    client_id_length: id.length,
    // ตั้งผ่าน echo บน Windows แล้วมี \r หรือช่องว่างติดมาบ่อย
    client_id_had_whitespace: raw !== id,
    client_id_looks_like_uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    client_secret_length: secret.length,
    // สลับค่ากันบ่อย — UUID ในช่อง secret แปลว่าน่าจะใส่สลับ
    client_secret_looks_like_uuid:
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secret),
    // วางในหน้าต่าง Command Prompt ที่ซ่อนตัวอักษร แล้ว Ctrl+V กลายเป็นอักขระควบคุม
    // หรือแป้นพิมพ์ค้างโหมดไทย แล้วได้ตัวอักษรไทยแทน — เจอมาแล้วทั้งสองแบบ
    client_id_has_bad_chars: hasBadChars(id),
    client_secret_has_bad_chars: hasBadChars(secret),
  };
}

// client id/secret ของทั้งสองเจ้าเป็น ASCII ที่พิมพ์ได้ล้วน อะไรนอกเหนือจากนี้คือพิมพ์/วางพลาด
const hasBadChars = (v) => Boolean(v) && /[^\x20-\x7E]/.test(v);

// คืนข้อความอธิบายถ้าค่าที่ตั้งไว้ดูผิดตั้งแต่ต้น จะได้บอกผู้ใช้ก่อนส่งไปให้ผู้ให้บริการปฏิเสธ
export function configProblem(env, provider) {
  const p = PROVIDERS[provider];
  const id = trim(env, p.clientIdVar);
  const secret = trim(env, p.clientSecretVar);
  if (!id || !secret) return `ยังไม่ได้ตั้ง ${p.clientIdVar} หรือ ${p.clientSecretVar}`;
  if (hasBadChars(id) || hasBadChars(secret)) {
    return `ค่าที่ตั้งไว้มีอักขระแปลกปลอม (วางไม่ติดใน Command Prompt หรือแป้นพิมพ์ค้างโหมดไทย) — ตั้ง ${p.clientIdVar} และ ${p.clientSecretVar} ใหม่`;
  }
  if (id.length < 8) return `${p.clientIdVar} สั้นผิดปกติ (${id.length} ตัวอักษร) น่าจะวางไม่ครบ`;
  if (secret.length < 16) return `${p.clientSecretVar} สั้นผิดปกติ (${secret.length} ตัวอักษร) น่าจะวางไม่ครบ`;
  return null;
}
