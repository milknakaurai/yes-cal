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
  ];
  for (const sql of stmts) await env.DB.prepare(sql).run();
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
  },
};

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
