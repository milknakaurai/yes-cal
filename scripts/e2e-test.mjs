// ทดสอบ worker แบบ end-to-end โดยไม่ต้อง deploy
//   node scripts/e2e-test.mjs
// ใช้ SQLite ในหน่วยความจำแทน D1 (สร้างตารางจาก schema.sql จริง) และดัก fetch ของ LINE/Gemini
// ทำให้จับ SQL ผิด/ฟิลด์ผิดได้ก่อนขึ้นของจริง — เพิ่มเคสใหม่ได้ที่ท้ายไฟล์
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const db = new DatabaseSync(':memory:');
const sqlText = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
  .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
for (const stmt of sqlText.split(';')) {
  const s = stmt.trim();
  if (s) { try { db.exec(s + ';'); } catch (e) { console.error('SCHEMA FAIL:', e.message, '::', s.slice(0,70)); } }
}
console.log('ตารางที่สร้าง:', db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name).join(', '));

// ---- shim ให้เหมือน D1 ----
const wrap = (sql) => ({
  bind: (...args) => ({
    first: async () => { try { return db.prepare(sql).get(...args) ?? null; } catch (e) { throw new Error(`SQL(first) ${e.message} :: ${sql.slice(0,90)}`); } },
    all:   async () => { try { return { results: db.prepare(sql).all(...args) }; } catch (e) { throw new Error(`SQL(all) ${e.message} :: ${sql.slice(0,90)}`); } },
    run:   async () => { try { db.prepare(sql).run(...args); return { success: true }; } catch (e) { throw new Error(`SQL(run) ${e.message} :: ${sql.slice(0,90)}`); } },
  }),
  first: async () => db.prepare(sql).get() ?? null,
  all:   async () => ({ results: db.prepare(sql).all() }),
  run:   async () => { db.prepare(sql).run(); return { success: true }; },
});
const SECRET = 'testsecret';
const env = {
  DB: { prepare: wrap, batch: async (stmts) => { for (const s of stmts) await s.run(); } },
  LINE_CHANNEL_SECRET: SECRET,
  LINE_CHANNEL_ACCESS_TOKEN: 'token'.padEnd(172, 'x'),
  GEMINI_API_KEY: 'key',
  DASHBOARD_KEY: 'dash',
  TOKEN_KEY: 'a-very-secret-key-for-tests-0123456789',
  // ความยาวใกล้เคียงของจริง เพราะ configProblem() ตีตกค่าที่สั้นผิดปกติ
  WHOOP_CLIENT_ID: '0c03ac1e-3bfa-4da0-8a1a-66608ff1a9bf',
  WHOOP_CLIENT_SECRET: 'w'.repeat(64),
  GOOGLE_CLIENT_ID: '1234567890-abcdef.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'GOCSPX-' + 'g'.repeat(28),
  ASSETS: { fetch: async (u) => new Response('<!DOCTYPE html>' + String(u), { status: 200 }) },
};

// ---- ดัก fetch ----
const replies = [];
let geminiReply = null;
let suggestReply = null;
let correctionReply = null;
let lastGeminiPrompt = '';
// fixture เก็บวันที่จริง (19-23 ส.ค.) แต่ตัวซิงก์รับเฉพาะย้อนหลัง 2 วัน —
// เลื่อนเวลาทุกรายการให้รายการใหม่สุดกลายเป็น "วันนี้" เทสจะได้ไม่เน่าตามปฏิทิน
const whoopWorkoutFixture = (() => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/whoop-workout.json', import.meta.url), 'utf8'));
  const bkkDate = (iso) => new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 10);
  const newest = raw.records.map((r) => bkkDate(r.end)).sort().at(-1);
  const shiftDays = Math.round((new Date(bkkDate(new Date().toISOString())) - new Date(newest)) / 86400e3);
  const shift = (iso) => iso && new Date(new Date(iso).getTime() + shiftDays * 86400e3).toISOString();
  return { ...raw, records: raw.records.map((r) => ({ ...r, start: shift(r.start), end: shift(r.end) })) };
})();
let lastTokenRequest = null;
let tokenSeq = 0;
let tokenFails = false;
let geminiDown = false;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('generativelanguage')) {
    if (geminiDown) return { ok: false, status: 429, text: async () => 'quota', json: async () => ({}) };
    lastGeminiPrompt = String(opts?.body || '');
    const wantsSuggestion = lastGeminiPrompt.includes('ผู้ช่วยด้านโภชนาการ');
    const wantsCorrection = lastGeminiPrompt.includes('ก่อนหน้านี้ผู้ใช้บันทึกไว้ว่ากิน');
    const payload = wantsSuggestion && suggestReply ? suggestReply
      : wantsCorrection && correctionReply ? correctionReply
      : geminiReply;
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }) };
  }
  if (u.includes('whoop.com/oauth/oauth2/token') || u === 'https://oauth2.googleapis.com/token') {
    lastTokenRequest = { url: u, body: String(opts?.body || '') };
    if (tokenFails) return { ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' };
    return { ok: true, status: 200, text: async () => JSON.stringify({
      access_token: 'AT-' + (++tokenSeq), refresh_token: 'RT-' + tokenSeq, expires_in: 3600, scope: 'read:workout' }) };
  }
  if (u.includes('/developer/v2/activity/workout')) {
    return { ok: true, status: 200,
      json: async () => whoopWorkoutFixture,
      text: async () => JSON.stringify(whoopWorkoutFixture) };
  }
  if (u.includes('/user/profile/basic') || u.endsWith('/v4/users/me/identity')) {
    return { ok: true, status: 200, json: async () => ({ user_id: 42, first_name: 'Milk', last_name: 'N' }) };
  }
  if (u.includes('/content')) {
    return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(16) };
  }
  if (u.includes('/message/reply') || u.includes('/message/push')) {
    const body = JSON.parse(opts.body);
    replies.push(body.messages[0]);
    const id = 'bot' + (++botSeq);
    lastBotMessageId = id;
    return { ok: true, status: 200, text: async () => '', json: async () => ({ sentMessages: [{ id }] }) };
  }
  if (u.endsWith('/v2/bot/info')) {
    return { ok: true, status: 200, json: async () => ({ userId: 'U_BOT' }) };
  }
  if (u.includes('/member/') || u.includes('/profile/')) {
    return { ok: true, status: 200, json: async () => ({ displayName: CURRENT_NAME }) };
  }
  const summary = u.match(/\/group\/([^/]+)\/summary$/);
  if (summary) {
    return { ok: true, status: 200, json: async () => ({ groupName: 'กลุ่ม ' + summary[1] }) };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};
let CURRENT_NAME = 'ใครสักคน';
let botSeq = 0;
export let lastBotMessageId = null;

const worker = (await import(new URL('../src/index.js', import.meta.url))).default;
const WN = await import(new URL('../src/wearables.js', import.meta.url));
let failed = 0;
const check = (label, ok) => { console.log(`  ${ok ? 'OK ' : 'พัง'} ${label}`); if (!ok) failed++; };
// เก็บงานเบื้องหลังที่ worker ฝากไว้ แล้วให้ settle() รอจนจบจริง ๆ
// (เดิม waitUntil คืน promise เฉย ๆ ไม่มีใครรอ เทสเลยตรวจผลก่อนงานเสร็จ)
const pending = [];
const ctx = { waitUntil: (p) => { pending.push(Promise.resolve(p).catch((e) => console.error('waitUntil พัง', e))); return p; } };

async function send(event) {
  replies.length = 0;
  const body = JSON.stringify({ events: [event] });
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64');
  const res = await worker.fetch(new Request('https://x/webhook', { method: 'POST', headers: { 'x-line-signature': sig }, body }), env, ctx);
  await settle();
  if (res.status !== 200) throw new Error('webhook status ' + res.status);
  return replies.map(m => m.text);
}
// รอให้งานเบื้องหลังทั้งหมดจบก่อนตรวจผล — งานหนึ่งอาจฝากงานใหม่ต่อ จึงวนจนไม่เหลือ
const settle = async () => {
  for (let i = 0; i < 50 && pending.length; i++) await Promise.all(pending.splice(0));
  await new Promise((r) => setImmediate(r));
};

let msgSeq = 1000;
const textEventIn = (groupId, userId, text, extra = {}) => ({
  type: 'message', replyToken: 'rt', source: { type: 'group', groupId, userId },
  message: { type: 'text', id: 'm' + (++msgSeq), text, ...extra },
});
const textEvent = (userId, text, extra = {}) => textEventIn('G1', userId, text, extra);
const imageEvent = (userId) => ({
  type: 'message', replyToken: 'rt', source: { type: 'group', groupId: 'G1', userId },
  message: { type: 'image', id: 'm' + (++msgSeq) },
});
const show = (label, out) => { console.log(`\n▶ ${label}`); out.forEach(t => console.log('  ' + t.replace(/\n/g, '\n  '))); if (!out.length) console.log('  (บอทเงียบ)'); };

// ================= เริ่มทดสอบ =================
CURRENT_NAME = 'Milk';
show('Milk พิมพ์ "ออกกำลังกาย" (เปิดโหมด)', await send(textEvent('U_MILK', 'ออกกำลังกาย')));
show('Milk พิมพ์ "สมาชิก" (ต้องยังไม่มีใคร)', await send(textEvent('U_MILK', 'สมาชิก')));

CURRENT_NAME = 'Peach';
show('Peach พิมพ์ "เข้าร่วม"', await send(textEvent('U_PEACH', 'เข้าร่วม')));

CURRENT_NAME = 'Erk Sasin';
geminiReply = { is_workout: true, activity: 'กอล์ฟ', duration_min: 60, kcal: 240, has_screen_data: true };
const erkImg = imageEvent('U_ERK');
show('Erk ส่งรูปกอล์ฟ (ยังไม่ได้สมัคร → เพิ่มให้อัตโนมัติ)', await send(erkImg));

CURRENT_NAME = 'Milk';
show('Milk พิมพ์ "วันนี้"', await send(textEvent('U_MILK', 'วันนี้')));
show('Milk แท็ก "@Erk Sasin เมื่อวาน"', await send(textEvent('U_MILK', '@Erk Sasin เมื่อวาน', {
  mention: { mentionees: [{ index: 0, length: 10, userId: 'U_ERK', type: 'user' }] },
})));
show('Milk พิมพ์ "วันนี้" อีกครั้ง (Erk ต้องกลับไปอยู่ฝั่งยังไม่ออก)', await send(textEvent('U_MILK', 'วันนี้')));

CURRENT_NAME = 'Erk Sasin';
geminiReply = { is_workout: true, activity: 'วิ่ง', duration_min: 30, kcal: 300, has_screen_data: true };
const erkImg2 = imageEvent('U_ERK');
show('Erk ส่งรูปวิ่ง (ของวันนี้)', await send(erkImg2));
show('Milk reply ที่รูปวิ่ง + "อันนี้คือเมื่อคืน"', await send(textEvent('U_MILK', 'อันนี้คือเมื่อคืน', { quotedMessageId: erkImg2.message.id })));

CURRENT_NAME = 'Peach';
geminiReply = { is_workout: true, activity: 'ว่ายน้ำ', duration_min: 40, kcal: 320, has_screen_data: true };
await send(imageEvent('U_PEACH'));
const botMsgId = lastBotMessageId;
CURRENT_NAME = 'Milk';
show('Milk reply ที่ "ข้อความของบอท" + "เมื่อวาน"', await send(textEvent('U_MILK', 'เมื่อวาน', { quotedMessageId: botMsgId })));

CURRENT_NAME = 'Peach';
geminiReply = { is_workout: true, activity: 'เวทเทรนนิ่ง', duration_min: 45, kcal: 280, has_screen_data: true };
show('Peach พิมพ์ "เล่นเวท 45 นาที"', await send(textEvent('U_PEACH', 'เล่นเวท 45 นาที')));
show('Peach พิมพ์ "สวัสดีตอนเช้า" (ต้องเงียบ)', await send(textEvent('U_PEACH', 'สวัสดีตอนเช้า')));
show('Peach พิมพ์ "กินข้าวเมื่อวานอร่อยมาก" (ต้องเงียบ ไม่ย้ายวัน)', await send(textEvent('U_PEACH', 'กินข้าวเมื่อวานอร่อยมาก')));
show('Peach พิมพ์ "ออกกำลังกาย" ในโหมดชาเลนจ์ (ต้องขอรายละเอียด ไม่เช็คอิน)', await send(textEvent('U_PEACH', 'ออกกำลังกาย')));
show('Peach พิมพ์ "ออกกำลัง" (คำสั้นกว่า ต้องกันได้เหมือนกัน)', await send(textEvent('U_PEACH', 'ออกกำลัง')));

CURRENT_NAME = 'Pream';
geminiReply = { is_workout: true, activity: 'วิ่ง' };
show('Pream พิมพ์ "วิ่ง" เฉย ๆ (ไม่บอกจำนวน → ต้องขอรายละเอียด)', await send(textEvent('U_PREAM', 'วิ่ง')));
geminiReply = { is_workout: true, activity: 'วิ่ง 5 กม.' };
show('Pream พิมพ์ "วิ่ง 5 กม." (มีจำนวน → เช็คอินได้)', await send(textEvent('U_PREAM', 'วิ่ง 5 กม.')));
CURRENT_NAME = 'Peach';

CURRENT_NAME = 'Lek';
geminiReply = { is_workout: true, activity: 'วิ่ง', has_screen_data: false };
show('Lek ส่งรูปลู่วิ่งเปล่า ๆ (ไม่มีตัวเลข → ต้องไม่เช็คอิน)', await send(imageEvent('U_LEK')));

geminiReply = { is_workout: true, activity: 'ยกน้ำหนัก', duration_min: 50, has_screen_data: false };
show('Lek ส่งหน้าจอ Whoop (flag ผิดแต่อ่านเวลาได้ → ต้องเช็คอินให้)', await send(imageEvent('U_LEK')));

// จำลองสถานการณ์จริง: Lek มี 2 รายการวันนี้ (รูปรองเท้าที่หลุดเข้ามาก่อนหน้า + หน้าจอนาฬิกา)
geminiReply = { is_workout: true, activity: 'วิ่ง', has_screen_data: true };
const lekShoe = imageEvent('U_LEK'); await send(lekShoe);
geminiReply = { is_workout: true, activity: 'วิ่งลู่วิ่ง', duration_min: 35, kcal: 305, has_screen_data: true };
await send(imageEvent('U_LEK'));
CURRENT_NAME = 'Milk';
show('Milk แท็ก "@Lek ลบ" (Lek มี 2 รายการ → ต้องให้เลือกหมายเลข)', await send(textEvent('U_MILK', '@Lek ลบ', {
  mention: { mentionees: [{ index: 0, length: 4, userId: 'U_LEK', type: 'user' }] } })));
show('Milk พิมพ์ "@Lek ลบ 1" (ลบรายการแรก)', await send(textEvent('U_MILK', '@Lek ลบ 1', {
  mention: { mentionees: [{ index: 0, length: 4, userId: 'U_LEK', type: 'user' }] } })));
show('Milk reply ที่รูปรองเท้า + "ลบ" (อีกวิธี)', await send(textEvent('U_MILK', 'ลบ', { quotedMessageId: lekShoe.message.id })));
CURRENT_NAME = 'Lek';
show('Milk พิมพ์ "วันนี้" (Lek ต้องยังไม่ถูกนับ)', await send(textEvent('U_MILK', 'วันนี้')));

CURRENT_NAME = 'Peach';
show('Peach แท็ก "@Yes Cal อ่านๆ" เฉย ๆ (ต้องตอบ ไม่เงียบ)', await send(textEvent('U_PEACH', '@Yes Cal อ่านๆ', {
  mention: { mentionees: [{ index: 0, length: 8, userId: 'U_BOT', type: 'user' }] } })));

geminiReply = { is_workout: false, activity: 'ข้อมูลการนอน' };
const sleepImg = imageEvent('U_PEACH'); await send(sleepImg);
show('Peach reply ที่รูปการนอน + แท็กบอท (ต้องบอกว่าอ่านแล้วแต่ไม่นับ)', await send(textEvent('U_PEACH', '@Yes Cal อ่านๆ', {
  quotedMessageId: sleepImg.message.id,
  mention: { mentionees: [{ index: 0, length: 8, userId: 'U_BOT', type: 'user' }] } })));

geminiReply = { is_workout: true, activity: 'วิ่ง', duration_min: 30, kcal: 250, has_screen_data: true };
const runImg = imageEvent('U_PEACH'); await send(runImg);
show('Peach reply ที่รูปนาฬิกา + แท็กบอท (ต้องเช็คอินให้)', await send(textEvent('U_PEACH', '@Yes Cal อ่านให้หน่อย', {
  quotedMessageId: runImg.message.id,
  mention: { mentionees: [{ index: 0, length: 8, userId: 'U_BOT', type: 'user' }] } })));

// แท็กบอทพร้อมเล่าว่าออกอะไรมา (เคสจริงของ Erk 24 ส.ค.) — ต้องบันทึกเลย ไม่ใช่ตอบงง
CURRENT_NAME = 'Erk Sasin';
geminiReply = { is_workout: true, activity: 'เดิน + ไดร์ฟกอล์ฟ', duration_min: 60, kcal: 700 };
const tagLog = await send(textEvent('U_ERK', '@Yes Cal เมื่อวานเดิน 5 km + ไดร์ฟกอล์ฟ น่าจะ 700 แคล รวมแล้ว', {
  mention: { mentionees: [{ index: 0, length: 8, userId: 'U_BOT', type: 'user' }] } }));
show('Erk แท็กบอท "เมื่อวานเดิน 5 km + ไดร์ฟกอล์ฟ 700 แคล"', tagLog);
check('แท็กพร้อมรายละเอียด → เช็คอินให้เลย', !tagLog[0]?.includes('ยังไม่เข้าใจ'));
const tagged = db.prepare(
  `SELECT activity, kcal, logged_date FROM workouts WHERE line_user_id='U_ERK' ORDER BY id DESC LIMIT 1`).get();
check('บันทึกกิจกรรมและแคลตามที่บอก', tagged?.kcal === 700);
check('คำว่า "เมื่อวาน" ทำให้ลงวันที่เมื่อวาน',
  tagged?.logged_date === new Date(Date.now() + 7 * 3600e3 - 86400e3).toISOString().slice(0, 10));

// แท็กมาคุยเล่น → ยังตอบช่วยเหลือเหมือนเดิม ไม่เผลอบันทึกมั่ว
geminiReply = { is_workout: false };
const tagChat = await send(textEvent('U_ERK', '@Yes Cal เก่งมากเลยวันนี้ 55 ขำ ๆ', {
  mention: { mentionees: [{ index: 0, length: 8, userId: 'U_BOT', type: 'user' }] } }));
check('แท็กคุยเล่น → ตอบช่วยเหลือ ไม่บันทึก', tagChat[0]?.includes('เรียกผมเหรอครับ'));

// บันทึกย้อนหลังหลายวัน ไม่ใช่แค่เมื่อวาน
const dayAgo = (n) => new Date(Date.now() + 7 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
CURRENT_NAME = 'Lek';
geminiReply = { is_workout: true, activity: 'ตีกอล์ฟ', duration_min: 90, kcal: 400 };
show('Lek พิมพ์ "3 วันที่แล้ว ตีกอล์ฟ 2 ถาด"', await send(textEvent('U_LEK', '3 วันที่แล้ว ตีกอล์ฟ 2 ถาด')));
check('ย้อนหลัง 3 วันลงวันที่ถูก',
  db.prepare(`SELECT logged_date FROM workouts WHERE line_user_id='U_LEK' ORDER BY id DESC LIMIT 1`).get()
    ?.logged_date === dayAgo(3));

geminiReply = { is_workout: true, activity: 'ว่ายน้ำ', duration_min: 30, kcal: 250 };
await send(textEvent('U_LEK', 'เมื่อสองวันก่อนว่ายน้ำ 30 นาที'));
check('เลขไทย "สองวันก่อน" ก็อ่านออก',
  db.prepare(`SELECT logged_date FROM workouts WHERE line_user_id='U_LEK' ORDER BY id DESC LIMIT 1`).get()
    ?.logged_date === dayAgo(2));

geminiReply = { is_workout: true, activity: 'เล่นเวท', duration_min: 60, kcal: 300 };
await send(textEvent('U_LEK', 'วานซืนเล่นเวท 1 ชม.'));
check('"วานซืน" = 2 วันที่แล้ว',
  db.prepare(`SELECT logged_date FROM workouts WHERE line_user_id='U_LEK' ORDER BY id DESC LIMIT 1`).get()
    ?.logged_date === dayAgo(2));

// เลขที่บอกวันต้องไม่ถูกนับเป็นปริมาณการออกกำลังกาย
geminiReply = { is_workout: true, activity: 'วิ่ง', duration_min: 0, kcal: 0 };
const vague = await send(textEvent('U_LEK', '3 วันที่แล้ววิ่ง'));
show('Lek พิมพ์ "3 วันที่แล้ววิ่ง" (ไม่บอกว่าเท่าไหร่)', vague);
check('เลขบอกวันไม่นับเป็นตัวเลขออกกำลังกาย',
  !!vague[0] && !vague[0].includes('บันทึกย้อนหลัง'));

// ย้ายรายการเก่าไปหลายวันก่อน — เหลือรายการเดียวก่อน ไม่งั้นเข้าเงื่อนไข "กำกวม" (ที่ตั้งใจ)
db.prepare(`DELETE FROM workouts WHERE line_user_id='U_LEK'`).run();
geminiReply = { is_workout: true, activity: 'วิ่งลู่', duration_min: 40, kcal: 350 };
await send(textEvent('U_LEK', 'วิ่งลู่ 40 นาที'));
show('Lek พิมพ์ "4 วันที่แล้ว" เฉย ๆ (ย้ายรายการล่าสุด)', await send(textEvent('U_LEK', '4 วันที่แล้ว')));
check('ย้ายรายการล่าสุดไป 4 วันที่แล้ว',
  db.prepare(`SELECT logged_date FROM workouts WHERE line_user_id='U_LEK' AND activity='วิ่งลู่'`).get()
    ?.logged_date === dayAgo(4));

// ย้ายรายการที่บันทึกไว้เมื่อวาน (เดิมมองแค่ของวันนี้ เลยหาไม่เจอ)
{
  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_LEK'`).run();
  db.prepare(`INSERT INTO workouts (chat_id, line_user_id, activity, duration_min, kcal, source, message_id, logged_date)
              VALUES ('G1','U_LEK','ปั่นจักรยาน',45,300,'text','m-bike',?)`).run(dayAgo(1));
  CURRENT_NAME = 'Lek';
  show('Lek พิมพ์ "3 วันที่แล้ว" (รายการล่าสุดอยู่เมื่อวาน)', await send(textEvent('U_LEK', '3 วันที่แล้ว')));
  check('ย้ายรายการของเมื่อวานได้ ไม่ใช่เฉพาะของวันนี้',
    db.prepare(`SELECT logged_date FROM workouts WHERE message_id='m-bike'`).get()?.logged_date === dayAgo(3));
}

// แอดมินพิมพ์แทนเพื่อนที่ขี้เกียจ (เคสจริง Erk 25 ส.ค.)
{
  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_ERK'`).run();
  CURRENT_NAME = 'Milk';
  geminiReply = { is_workout: true, activity: 'เดิน + ไดร์ฟกอล์ฟ', duration_min: 60, kcal: 700 };
  const t = '@Erk Sasin 2 วันที่แล้วเดิน 5 กม. + ไดร์ฟกอล์ฟ 700 แคล';
  const onBehalf = await send(textEvent('U_MILK', t, {
    mention: { mentionees: [{ index: 0, length: 10, userId: 'U_ERK', type: 'user' }] } }));
  show('Milk แท็ก Erk + เล่าว่าเขาออกอะไร', onBehalf);
  const saved = db.prepare(
    `SELECT line_user_id, activity, kcal, logged_date FROM workouts ORDER BY id DESC LIMIT 1`).get();
  check('บันทึกเป็นของ Erk ไม่ใช่ของคนพิมพ์', saved?.line_user_id === 'U_ERK');
  check('ลงวันที่ตามที่บอก', saved?.logged_date === dayAgo(2));
  check('เก็บตัวเลขครบ', saved?.kcal === 700);
  check('บอกในกลุ่มว่าใครบันทึกแทน', onBehalf[0].includes('Milk บันทึกแทน'));

  // ไม่มีตัวเลข = ไม่ผ่านเหมือนกับบันทึกให้ตัวเอง
  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_ERK'`).run();
  geminiReply = { is_workout: true, activity: 'วิ่ง', duration_min: 0, kcal: 0 };
  const noAmount = await send(textEvent('U_MILK', '@Erk Sasin เมื่อวานวิ่ง', {
    mention: { mentionees: [{ index: 0, length: 10, userId: 'U_ERK', type: 'user' }] } }));
  check('บันทึกแทนก็ต้องมีตัวเลข', db.prepare(
    `SELECT COUNT(*) AS n FROM workouts WHERE line_user_id='U_ERK'`).get().n === 0);
  check('ทวงตัวเลขโดยเรียกชื่อคนที่ถูกแท็ก', noAmount[0].includes('Erk Sasin'));

  // แท็กคนที่ยังไม่เข้าร่วม
  geminiReply = { is_workout: true, activity: 'วิ่ง', duration_min: 30, kcal: 250 };
  const notMember = await send(textEvent('U_MILK', '@Nobody วิ่ง 5 กม.', {
    mention: { mentionees: [{ index: 0, length: 7, userId: 'U_GHOST', type: 'user' }] } }));
  check('แท็กคนที่ยังไม่เข้าร่วม → บอกให้สมัครก่อน', notMember[0].includes('ยังไม่ได้เข้าร่วม'));
}

// มีหลายรายการ = กำกวม ต้องไม่เดา (เคสจริง 25 ส.ค. เดาผิดไปย้ายบาสแทนเดิน)
{
  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_ERK'`).run();
  db.prepare(`INSERT INTO workouts (chat_id, line_user_id, activity, duration_min, source, message_id, logged_date)
              VALUES ('G1','U_ERK','เดิน',30,'text','m-walk',?)`).run(dayAgo(1));
  db.prepare(`INSERT INTO workouts (chat_id, line_user_id, activity, duration_min, source, message_id, logged_date)
              VALUES ('G1','U_ERK','บาสเกตบอล',105,'image','m-basket',?)`).run(dayAgo(0));
  CURRENT_NAME = 'Milk';
  const ambiguous = await send(textEvent('U_MILK', '2 วันที่แล้ว @Erk Sasin', {
    mention: { mentionees: [{ index: 13, length: 10, userId: 'U_ERK', type: 'user' }] } }));
  show('Milk แท็ก Erk + "2 วันที่แล้ว" ทั้งที่ Erk มี 2 รายการ', ambiguous);
  check('มีหลายรายการ → ไม่ย้าย ถามก่อน', ambiguous[0].includes('ไม่กล้าเดา'));
  check('ไม่แตะข้อมูลเลย',
    db.prepare(`SELECT logged_date FROM workouts WHERE message_id='m-basket'`).get()?.logged_date === dayAgo(0));
  check('ลิสต์รายการให้เลือก', ambiguous[0].includes('บาสเกตบอล') && ambiguous[0].includes('เดิน'));

  // reply เจาะจงมาที่รายการไหน ย้ายอันนั้น ไม่ถามซ้ำ
  const moved = await send(textEvent('U_MILK', '2 วันที่แล้ว', { quotedMessageId: 'm-walk' }));
  check('reply เจาะจง → ย้ายได้เลย', moved[0].includes('ย้าย "เดิน"'));
  check('ย้ายอันที่ reply มา ไม่ใช่อันล่าสุด',
    db.prepare(`SELECT logged_date FROM workouts WHERE message_id='m-walk'`).get()?.logged_date === dayAgo(2));
  check('บอกวิธีกู้คืนไว้ในข้อความ', moved[0].includes('ย้ายกลับ'));

  // กู้คืน
  show('Milk พิมพ์ "ย้ายกลับ"', await send(textEvent('U_MILK', 'ย้ายกลับ')));
  check('กู้คืนวันเดิมได้',
    db.prepare(`SELECT logged_date FROM workouts WHERE message_id='m-walk'`).get()?.logged_date === dayAgo(1));
  // เคลียร์ประวัติการย้ายที่ค้างจากเทสก่อนหน้าออกก่อน แล้วค่อยเช็คว่า "ไม่มีอะไรให้กู้"
  db.prepare(`UPDATE workouts SET prev_date = NULL, moved_at = NULL`).run();
  check('ไม่มีการย้ายค้างอยู่ → บอกตรง ๆ',
    (await send(textEvent('U_MILK', 'ย้ายกลับ')))[0].includes('ไม่มีการย้าย'));
  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_ERK'`).run();
}

// reply ไปที่ข้อความที่ไม่เคยถูกเช็คอิน — ต้องบอกให้ชัดว่าทำไมไม่มีอะไรให้ย้าย (เคสจริง Erk 25 ส.ค.)
{
  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_LEK'`).run();
  const out = await send(textEvent('U_LEK', '2 วันที่แล้ว', { quotedMessageId: 'ไม่เคยเช็คอิน' }));
  show('Lek reply ที่ข้อความที่ไม่เคยเช็คอิน แล้วพิมพ์ "2 วันที่แล้ว"', out);
  check('บอกว่าข้อความนั้นไม่เคยถูกเช็คอิน', out[0].includes('ไม่เคยถูกเช็คอิน'));
  check('แนะนำวิธีที่ทำได้จริง', out[0].includes('2 วันที่แล้วเดิน 5 กม.'));
}

CURRENT_NAME = 'Milk';
show('Milk พิมพ์ "เตือน" (แท็กคนที่ยังไม่ออก)', await send(textEvent('U_MILK', 'เตือน')));
show('Milk พิมพ์ "อันดับ"', await send(textEvent('U_MILK', 'อันดับ')));
show('Milk พิมพ์ "สมาชิก"', await send(textEvent('U_MILK', 'สมาชิก')));

console.log('\n\n===== ข้อมูลในฐานข้อมูล =====');
console.log('workouts:', JSON.stringify(db.prepare('SELECT line_user_id, activity, logged_date, message_id, reply_message_id FROM workouts').all(), null, 0));
console.log('members :', JSON.stringify(db.prepare('SELECT line_user_id, display_name, active FROM challenge_members').all(), null, 0));
console.log('usage   :', JSON.stringify(db.prepare('SELECT kind, label, n FROM api_usage').all(), null, 0));

// ---- API ของหน้า dashboard — จับ SQL ผิดในหน้าเว็บก่อนขึ้นของจริง ----
async function api(path) {
  const res = await worker.fetch(new Request('https://x' + path), env, ctx);
  if (res.status !== 200) throw new Error(`${path} → status ${res.status}`);
  return res.json();
}

// ---- แนะนำเมนู "กินอะไรดี" (โหมดแคลอรี่ คุยตัวต่อตัวกับบอท) ----
const dmEvent = (userId, text) => ({
  type: 'message', replyToken: 'rt', source: { type: 'user', userId },
  message: { type: 'text', id: 'm' + (++msgSeq), text },
});
CURRENT_NAME = 'Milk';
db.prepare(`INSERT OR REPLACE INTO users
  (line_user_id, display_name, sex, age, height_cm, weight_kg, activity, goal_type, target_kcal, target_protein_g)
  VALUES ('U_DM', 'Milk', 'male', 34, 175, 72, 1.55, 'muscle', 2600, 140)`).run();
const dmToday = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
db.prepare(`INSERT INTO meals (line_user_id, name, kcal, protein_g, eaten_date)
  VALUES ('U_DM', 'ข้าวมันไก่ 1 จาน', 600, 24, ?)`).run(dmToday);

suggestReply = { options: [
  { name: 'อกไก่ย่าง 150g + ข้าวสวย 1 ทัพพี', kcal: 270, protein_g: 44, why: 'โปรตีนแน่น แคลต่ำ' },
  { name: 'สุกี้น้ำรวมมิตร 1 ชาม', kcal: 290, protein_g: 20, why: 'อิ่มแต่เบา' },
  { name: 'ลาบไก่ + ข้าวเหนียวครึ่งทัพพี', kcal: 300, protein_g: 23, why: 'โปรตีนดี รสจัด' },
], tip: 'ดื่มน้ำเยอะ ๆ ด้วยนะครับ' };
show('Milk (แชทเดี่ยว) พิมพ์ "กินอะไรดี"', await send(dmEvent('U_DM', 'กินอะไรดี')));
show('Milk พิมพ์ "กินอะไรดี ร้านตามสั่ง" (มีเงื่อนไข)', await send(dmEvent('U_DM', 'กินอะไรดี ร้านตามสั่ง')));
const hintPrompt = lastGeminiPrompt;
const suggestOut = replies[0]?.text || '';

geminiDown = true;
const offline = await send(dmEvent('U_DM', 'กินอะไรดี'));
show('โควตา Gemini หมด → ต้องเลือกจากคลังเมนูเอง', offline);
geminiDown = false;

// กินเกินเป้าแล้ว ต้องแนะนำของเบา
db.prepare(`INSERT INTO meals (line_user_id, name, kcal, protein_g, eaten_date)
  VALUES ('U_DM', 'หมูกระทะ', 2200, 90, ?)`).run(dmToday);
suggestReply = { options: [{ name: 'ไข่ต้ม 2 ฟอง', kcal: 145, protein_g: 13, why: 'เบาสุดแล้ว' }] };
const over = await send(dmEvent('U_DM', 'กินอะไรดี'));
show('กินเกินเป้าแล้ว', over);
db.prepare(`DELETE FROM meals WHERE line_user_id = 'U_DM' AND name = 'หมูกระทะ'`).run();

// ยังไม่ได้ตั้งเป้า
db.prepare(`INSERT OR REPLACE INTO users (line_user_id, display_name) VALUES ('U_NEW', 'Charlie')`).run();
CURRENT_NAME = 'Charlie';
suggestReply = { options: [{ name: 'ข้าวมันไก่ต้ม 1 จาน', kcal: 470, protein_g: 25 }] };
const noGoal = await send(dmEvent('U_NEW', 'กินอะไรดี'));
show('คนที่ยังไม่ได้ตั้งเป้า', noGoal);
suggestReply = null;
CURRENT_NAME = 'Milk';

// ---- แก้ไขมื้อล่าสุดด้วยข้อความตามหลัง ----
// เจอจริง กลุ่ม MCL FOOD: Milk พิมพ์ "น้ำข้าวโพด" บันทึกแล้ว ต่อมาพิมพ์ "ไม่ใส่น้ำตาล"
// เดิม Gemini บอกว่าไม่ใช่อาหารรายการใหม่ (is_food: false) บอทเลยเงียบใส่ ไม่ปรับอะไรให้เลย
console.log('\n--- แก้ไขมื้อล่าสุด ---');
{
  db.prepare(`DELETE FROM meals WHERE line_user_id='U_DM'`).run();

  geminiReply = { is_food: true, items: [
    { name: 'น้ำข้าวโพด 1 แก้ว (250ml)', kcal: 150, protein_g: 2, carb_g: 30, fat_g: 3 },
  ], note: 'ประเมินจากน้ำข้าวโพดสูตรหวานน้อยทั่วไป' };
  show('Milk พิมพ์ "น้ำข้าวโพด"', await send(dmEvent('U_DM', 'น้ำข้าวโพด')));

  geminiReply = { is_food: false }; // Gemini เห็นว่าไม่ใช่รายการอาหารใหม่
  correctionReply = { is_food: true, items: [
    { name: 'น้ำข้าวโพด 1 แก้ว (250ml) ไม่ใส่น้ำตาล', kcal: 110, protein_g: 2, carb_g: 22, fat_g: 3 },
  ] };
  const fixed = await send(dmEvent('U_DM', 'ไม่ใส่น้ำตาล'));
  show('Milk พิมพ์ต่อว่า "ไม่ใส่น้ำตาล"', fixed);
  const f = fixed.join('\n');
  check('ไม่เงียบใส่ ตอบว่าแก้ไขให้แล้ว', fixed.length > 0 && f.includes('แก้ไขให้แล้ว'));
  check('ปรับแคลลงตามที่บอกเพิ่ม', f.includes('110 kcal'));
  check('บอกส่วนต่างจากของเดิมด้วย', f.includes('-40 kcal'));

  const row = db.prepare(`SELECT COUNT(*) AS n, kcal FROM meals WHERE line_user_id='U_DM'`).get();
  check('อัปเดตแถวเดิม ไม่ได้เพิ่มแถวใหม่', row.n === 1);
  check('ค่าที่เก็บจริงตรงกับที่ตอบ', row.kcal === 110);

  // ข้อความที่ไม่เกี่ยวกับการแก้ไขต้องไม่ไปแตะมื้อเดิม
  geminiReply = { is_food: false };
  correctionReply = { is_food: false };
  const chat = await send(dmEvent('U_DM', 'วันนี้อากาศดีจัง'));
  show('Milk พิมพ์คุยเล่นไม่เกี่ยวกับอาหาร', chat);
  check('คุยเล่นเฉย ๆ บอทยังเงียบเหมือนเดิม', chat.length === 0);
  check('มื้อเดิมไม่ถูกแตะต้อง',
    db.prepare(`SELECT kcal FROM meals WHERE line_user_id='U_DM'`).get().kcal === 110);
  correctionReply = null;

  // เกินเวลาที่กำหนดไว้แล้ว ไม่ควรย้อนไปแก้ของเก่า
  db.prepare(`UPDATE meals SET created_at = datetime('now', '-30 minutes') WHERE line_user_id='U_DM'`).run();
  geminiReply = { is_food: false };
  correctionReply = { is_food: true, items: [{ name: 'ไม่ควรถูกใช้', kcal: 1, protein_g: 0, carb_g: 0, fat_g: 0 }] };
  const stale = await send(dmEvent('U_DM', 'ไม่ใส่น้ำตาล'));
  show('พิมพ์แก้ไขหลังผ่านไปนานแล้ว', stale);
  check('เกินหน้าต่างเวลาแล้ว ไม่แก้ของเก่าให้', stale.length === 0);
  check('มื้อเดิมยังเหมือนเดิม',
    db.prepare(`SELECT kcal FROM meals WHERE line_user_id='U_DM'`).get().kcal === 110);
  correctionReply = null;

  db.prepare(`DELETE FROM meals WHERE line_user_id='U_DM'`).run();
}

// ---- กลุ่มที่สอง ไว้พิสูจน์ว่าลิงก์ของแต่ละกลุ่มเห็นแค่ของตัวเอง ----
CURRENT_NAME = 'Ann';
await send(textEventIn('G2', 'U_ANN', 'ออกกำลังกาย'));
await send(textEventIn('G2', 'U_ANN', 'เข้าร่วม'));
show('Ann (กลุ่ม G2) พิมพ์ "โยคะ 45 นาที"', await send(textEventIn('G2', 'U_ANN', 'โยคะ 45 นาที')));
show('Ann พิมพ์ "เว็บ" (ขอลิงก์ของกลุ่มตัวเอง)', await send(textEventIn('G2', 'U_ANN', 'เว็บ')));
const linkG2 = replies[0]?.text.match(/\?t=([a-f0-9]+)/);
CURRENT_NAME = 'Milk';
show('Milk (กลุ่ม G1) พิมพ์ "เว็บ"', await send(textEvent('U_MILK', 'เว็บ')));
const linkG1 = replies[0]?.text.match(/\?t=([a-f0-9]+)/);
const tokenG1 = linkG1?.[1], tokenG2 = linkG2?.[1];

console.log('\n\n===== API หน้าเว็บ =====');
const ch = await api('/api/challenge?days=14&key=dash');
console.log(`/api/challenge → ${ch.chats.length} กลุ่ม · ช่วง ${ch.dates.length} วัน · วันนี้ ${ch.today}`);
for (const c of ch.chats) {
  console.log(`  [${c.name}] ${c.members.length} คน · เช็คอินวันนี้ ${c.today_log.length} รายการ`);
  for (const m of c.members) {
    console.log(`     ${m.name}: 7 วัน ${m.week_days} · ต่อเนื่อง ${m.streak} · รวม ${m.total_days}` +
                ` · วันนี้ ${m.done_today ? 'ออกแล้ว' : 'ยังไม่ออก'} · ช่องในกริด ${m.days.length}`);
  }
}
check('มีกลุ่มชาเลนจ์อย่างน้อย 1 กลุ่ม', ch.chats.length >= 1);
check('สมาชิกครบเท่าที่สมัครไว้', ch.chats[0]?.members.length === 4);
check('ทุกคนมีช่องกริดครบ 14 วัน', ch.chats[0]?.members.every(m => m.days.length === 14));
check('done_today ตรงกับช่องของวันนี้',
  ch.chats[0]?.members.every(m => m.done_today === (m.days.at(-1).n > 0)));
check('total_days ไม่เกินจำนวนวันที่มีจริง', ch.chats[0]?.members.every(m => m.total_days >= m.week_days));

const ov = await api('/api/overview?days=14&key=dash');
console.log(`/api/overview → ${ov.users.length} คน`);

const noKey = await worker.fetch(new Request('https://x/api/challenge'), env, ctx);
check('ไม่ใส่ key ต้องโดนปฏิเสธ 401', noKey.status === 401);

// ---- แนะนำเมนู ----
console.log('\n--- แนะนำเมนู ---');
check('ส่งเงื่อนไขที่ผู้ใช้พิมพ์ต่อท้ายไปให้ AI ด้วย', hintPrompt.includes('ร้านตามสั่ง'));
check('บอก AI ว่าเหลือโควตาเท่าไหร่', hintPrompt.includes('เหลือโควตาวันนี้ 2000 kcal'));
check('บอก AI ว่าวันนี้กินอะไรไปแล้ว', hintPrompt.includes('ข้าวมันไก่ 1 จาน'));
check('แนบตารางโภชนาการไปด้วย', hintPrompt.includes('ตารางอ้างอิงอาหารไทย'));
check('ไม่มี markdown ในข้อความบอท', !/\*\*|__/.test(suggestOut));
const nOptions = (t) => (t.match(/^\d+\. /gm) || []).length;
const nWithKcal = (t) => (t.match(/^ {3}\d+ แคล/gm) || []).length;
check('เสนอ 3 ตัวเลือก และมีเลขแคลครบทุกอัน',
  nOptions(suggestOut) === 3 && nWithKcal(suggestOut) === 3);
check('เกินเป้าแล้วต้องเตือน', over[0].includes('เกินเป้ามา 200 แคล'));
check('โควตาหมดต้องยังตอบได้', offline[0].includes('แคล') && offline[0].includes('คลังเมนู'));
check('โควตาหมดแล้วยังเลือกได้ 3 เมนู พร้อมตัวเลข',
  nOptions(offline[0]) === 3 && nWithKcal(offline[0]) === 3);
check('คนยังไม่ตั้งเป้าก็ใช้ได้', noGoal[0].includes('ยังไม่ได้ตั้งเป้า'));

// ---- ลิงก์เฉพาะกลุ่ม ----
console.log('\n--- ลิงก์เฉพาะกลุ่ม ---');
check('บอทส่งลิงก์ให้ทั้งสองกลุ่ม', !!tokenG1 && !!tokenG2);
check('โทเคนสองกลุ่มไม่ซ้ำกัน', tokenG1 !== tokenG2);
check('เจ้าของเปิดรวมเห็นครบ 2 กลุ่ม', ch.chats.length === 2);
check('หน้ารวมแนบลิงก์ให้ทุกกลุ่ม', ch.chats.every(c => typeof c.link === 'string' && c.link.includes('/workout?t=')));

const only1 = await api(`/api/challenge?t=${tokenG1}`);
const only2 = await api(`/api/challenge?t=${tokenG2}`);
const namesOf = (d) => d.chats.flatMap(c => c.members.map(m => m.name));
console.log('  ลิงก์ G1 เห็น:', namesOf(only1).join(', '), '| ลิงก์ G2 เห็น:', namesOf(only2).join(', '));
check('ลิงก์ G1 เห็นกลุ่มเดียว', only1.chats.length === 1 && only1.scope === 'group');
check('ลิงก์ G2 เห็นกลุ่มเดียว', only2.chats.length === 1 && only2.scope === 'group');
check('ลิงก์ G1 ไม่เห็นสมาชิก G2', !namesOf(only1).includes('Ann'));
check('ลิงก์ G2 ไม่เห็นสมาชิก G1', !namesOf(only2).some(n => ['Peach', 'Lek', 'Erk Sasin', 'Pream'].includes(n)));
check('หน้ากลุ่มไม่แจกลิงก์ต่อ', only1.chats.every(c => !c.link));

const badToken = await worker.fetch(new Request('https://x/api/challenge?t=ไม่มีจริง'), env, ctx);
check('โทเคนมั่ว ๆ ต้องโดนปฏิเสธ 401', badToken.status === 401);
const tokenNoKey = await worker.fetch(new Request(`https://x/api/challenge?t=${tokenG1}`), env, ctx);
check('ใช้โทเคนอย่างเดียวเปิดได้ ไม่ต้องมีรหัสรวม', tokenNoKey.status === 200);
const overviewByToken = await worker.fetch(new Request(`https://x/api/overview?t=${tokenG1}`), env, ctx);
check('โทเคนกลุ่มเปิดหน้าแคลอรี่ไม่ได้', overviewByToken.status === 401);

show('Milk พิมพ์ "ลิงก์ใหม่"', await send(textEvent('U_MILK', 'ลิงก์ใหม่')));
const rotated = replies[0]?.text.match(/\?t=([a-f0-9]+)/)?.[1];
check('ได้โทเคนใหม่ ไม่ซ้ำของเดิม', !!rotated && rotated !== tokenG1);
const oldLink = await worker.fetch(new Request(`https://x/api/challenge?t=${tokenG1}`), env, ctx);
check('ลิงก์เก่าใช้ไม่ได้แล้ว', oldLink.status === 401);
const newLink = await worker.fetch(new Request(`https://x/api/challenge?t=${rotated}`), env, ctx);
check('ลิงก์ใหม่ใช้ได้', newLink.status === 200);

// ---- เชื่อมนาฬิกา ----
console.log('\n--- เชื่อมนาฬิกา ---');
CURRENT_NAME = 'Milk';
const linkOut = await send(dmEvent('U_DM', 'เชื่อมนาฬิกา'));
show('Milk พิมพ์ "เชื่อมนาฬิกา"', linkOut);
const linkToken = linkOut[0]?.match(/connect\?t=([a-f0-9]+)/)?.[1];
check('บอทส่งลิงก์ผูกบัญชีมา', !!linkToken);

const startRes = await worker.fetch(new Request(`https://x/oauth/whoop/start?t=${linkToken}`), env, ctx);
const authUrl = new URL(startRes.headers.get('location') || 'https://x/');
check('เด้งไปหน้ายินยอมของ WHOOP', startRes.status === 302 && authUrl.host === 'api.prod.whoop.com');
const st = authUrl.searchParams.get('state') || '';
check('scope มี offline (ไม่งั้นไม่ได้ refresh_token)', (authUrl.searchParams.get('scope') || '').includes('offline'));
check('state ยาวเกิน 8 ตัว (WHOOP บังคับ)', st.length >= 8);
check('redirect_uri ตรงกับที่ลงทะเบียนไว้',
  authUrl.searchParams.get('redirect_uri') === 'https://x/oauth/whoop/callback');

const cbRes = await worker.fetch(new Request(`https://x/oauth/whoop/callback?code=CODE1&state=${st}`), env, ctx);
check('callback สำเร็จ', cbRes.status === 200 && (await cbRes.text()).includes('สำเร็จ'));
check('แลกโทเคนด้วย grant_type ถูกต้อง', (lastTokenRequest?.body || '').includes('grant_type=authorization_code'));
check('ส่ง client_secret ไปด้วย', (lastTokenRequest?.body || '').includes('client_secret=' + 'w'.repeat(64)));

const stored = db.prepare(`SELECT access_token, refresh_token, provider_user_id, display_name FROM device_links WHERE line_user_id='U_DM'`).get();
check('เก็บลง device_links แล้ว', !!stored);
check('โทเคนถูกเข้ารหัส ไม่ใช่ plain text',
  !!stored && !stored.access_token.includes('AT-') && stored.access_token.includes('.'));
check('ยืนยันบัญชีปลายทางได้', stored?.display_name === 'Milk N');
show('Milk พิมพ์ "นาฬิกา"', await send(dmEvent('U_DM', 'นาฬิกา')));

// state ใช้ซ้ำไม่ได้ · ลิงก์หมดอายุแล้วต้องขอใหม่
const replay = await worker.fetch(new Request(`https://x/oauth/whoop/callback?code=CODE1&state=${st}`), env, ctx);
check('ใช้ state ซ้ำไม่ได้', replay.status === 400);
const badLink = await worker.fetch(new Request('https://x/oauth/whoop/start?t=ไม่มีจริง'), env, ctx);
check('ลิงก์มั่วเริ่ม flow ไม่ได้', badLink.status === 400);
const denied = await worker.fetch(new Request('https://x/oauth/google/callback?error=access_denied'), env, ctx);
check('ผู้ใช้กดปฏิเสธ → ขึ้นหน้าบอกเหตุผล', denied.status === 400 && (await denied.text()).includes('ปฏิเสธ'));

// เชื่อม Google ต่ออีกเจ้า
const link2 = (await send(dmEvent('U_DM', 'เชื่อมนาฬิกา')))[0].match(/connect\?t=([a-f0-9]+)/)[1];
const g = new URL((await worker.fetch(new Request(`https://x/oauth/google/start?t=${link2}`), env, ctx)).headers.get('location'));
check('Google ขอ access_type=offline', g.searchParams.get('access_type') === 'offline');
check('Google ขอ scope ของ Health API', (g.searchParams.get('scope') || '').includes('googlehealth.sleep.readonly'));
await worker.fetch(new Request(`https://x/oauth/google/callback?code=C2&state=${g.searchParams.get('state')}`), env, ctx);
check('เชื่อมได้ 2 เจ้าพร้อมกัน',
  db.prepare(`SELECT COUNT(*) AS n FROM device_links WHERE line_user_id='U_DM'`).get().n === 2);

// ต่ออายุโทเคนอัตโนมัติ — จุดที่ scope offline มีไว้เพื่อสิ่งนี้
const WR = await import(new URL('../src/wearables.js', import.meta.url));
const before = db.prepare(`SELECT access_token FROM device_links WHERE line_user_id='U_DM' AND provider='whoop'`).get();
db.prepare(`UPDATE device_links SET expires_at = '2020-01-01T00:00:00.000Z' WHERE line_user_id='U_DM' AND provider='whoop'`).run();
lastTokenRequest = null;
const fresh = await WR.getAccessToken(env, 'U_DM', 'whoop');
check('โทเคนหมดอายุ → ต่ออายุให้เอง', typeof fresh === 'string' && fresh.startsWith('AT-'));
check('ใช้ grant_type=refresh_token', (lastTokenRequest?.body || '').includes('grant_type=refresh_token'));
check('WHOOP ต้องส่ง scope=offline ตอน refresh ด้วย', (lastTokenRequest?.body || '').includes('scope=offline'));
const after = db.prepare(`SELECT access_token FROM device_links WHERE line_user_id='U_DM' AND provider='whoop'`).get();
check('บันทึกโทเคนใหม่ทับของเดิม', after.access_token !== before.access_token);

// ผู้ใช้ถอนสิทธิ์ที่ต้นทาง → refresh พัง ต้องไม่ระเบิด
db.prepare(`UPDATE device_links SET expires_at = '2020-01-01T00:00:00.000Z' WHERE line_user_id='U_DM' AND provider='whoop'`).run();
tokenFails = true;
check('refresh ไม่ผ่าน → คืน null ไม่ throw', (await WR.getAccessToken(env, 'U_DM', 'whoop')) === null);
tokenFails = false;

// โทเคนที่เก็บไว้ต้องถอดรหัสกลับมาได้ตรง
const round = await WR.decryptSecret(env, await WR.encryptSecret(env, 'ทดสอบ-secret-123'));
check('เข้ารหัส/ถอดรหัสได้ตรงกัน', round === 'ทดสอบ-secret-123');

show('Milk พิมพ์ "ตัดการเชื่อมต่อ"', await send(dmEvent('U_DM', 'ตัดการเชื่อมต่อ')));
check('ตัดการเชื่อมต่อแล้วโทเคนหายหมด',
  db.prepare(`SELECT COUNT(*) AS n FROM device_links WHERE line_user_id='U_DM'`).get().n === 0);

// ---- เช็คอินอัตโนมัติจากนาฬิกา ----
console.log('\n--- เช็คอินอัตโนมัติจากนาฬิกา ---');
{
  // Peach อยู่ในกลุ่มชาเลนจ์ G1 อยู่แล้ว — ผูกนาฬิกาให้แล้วสั่งซิงก์
  const linkP = (await send(textEvent('U_PEACH', 'เชื่อมนาฬิกา')))[0].match(/connect\?t=([a-f0-9]+)/)[1];
  const st = new URL((await worker.fetch(new Request(`https://x/oauth/whoop/start?t=${linkP}`), env, ctx))
    .headers.get('location')).searchParams.get('state');
  await worker.fetch(new Request(`https://x/oauth/whoop/callback?code=C&state=${st}`), env, ctx);

  // ล้างเช็คอินของ Peach ที่ค้างจากเทสก่อนหน้าออกก่อน ไม่งั้นตัวรวมรายการซ้ำจะไปทับของเก่า
  // แทนที่จะสร้างแถวใหม่ (ถูกต้องตามตรรกะ แต่ทำให้เทสข้อนี้วัดอะไรไม่ได้)
  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_PEACH'`).run();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM workouts WHERE source='device'`).get().n;
  show('Peach พิมพ์ "ซิงก์"', await send(textEvent('U_PEACH', 'ซิงก์')));
  const rows = db.prepare(
    `SELECT activity, duration_min, kcal, logged_date, message_id FROM workouts
      WHERE source='device' ORDER BY id`).all();
  rows.forEach((r) => console.log(`   ${r.logged_date} ${r.activity} ${r.duration_min} น. ${r.kcal} แคล [${r.message_id}]`));
  check('เช็คอินให้จากนาฬิกาจริง', rows.length > before);
  check('บันทึกที่มาเป็น device', rows.every((r) => r.message_id.startsWith('whoop:')));
  // ซิงก์ไม่ push บอกในกลุ่ม (ตั้งใจ) แต่รายการต้องติดสัญลักษณ์นาฬิกาไว้ในชื่อกิจกรรม
  // ไม่งั้นพอไปโผล่ในคำสั่ง "เมื่อวานออกอะไร"/"ลบ"/หน้าเว็บ จะดูเหมือนพิมพ์เองแล้วคนในกลุ่มงงว่ามาจากไหน
  // (เจอจริง 27 ส.ค.: Milk/Charlie เชื่อม Whoop ใน MCL FOOD แต่รายการไปโผล่ใน Lai & Kids แบบไม่บอกที่มา)
  check('ชื่อกิจกรรมติดสัญลักษณ์นาฬิกาไว้ให้เห็นชัด', rows.every((r) => r.activity.startsWith('⌚ ')));
  check('ไม่เอารายการเดินเบา ๆ (strain 1.4) มาเช็คอิน',
    !rows.some((r) => r.activity === 'เดิน' && r.duration_min === 40));
  check('เฉพาะย้อนหลังไม่เกิน 2 วัน',
    rows.every((r) => r.logged_date >= new Date(Date.now() + 7 * 3600e3 - 2 * 86400e3).toISOString().slice(0, 10)));

  // ส่งรูปเองแล้วนาฬิกาซิงก์รอบเดียวกันมาทีหลัง = ครั้งเดียว ไม่ใช่สองครั้ง (เคสจริงของ Charlie 24 ส.ค.)
  {
    const w = WN.normalizeWhoopWorkouts(whoopWorkoutFixture).filter((x) => WN.countsAsCheckin(x).ok)[0];
    db.prepare(`DELETE FROM workouts WHERE line_user_id='U_PEACH' AND logged_date=?`).run(w.date);
    db.prepare(`INSERT INTO workouts (chat_id, line_user_id, activity, duration_min, kcal, source, message_id, logged_date)
                VALUES ('G1','U_PEACH',?,?,500,'image','m-photo-1',?)`)
      .run(w.activity, w.duration_min + 2, w.date);   // รูปเดียวกัน อ่านเวลาต่างกัน 2 นาที
    await send(textEvent('U_PEACH', 'ซิงก์'));
    const rows2 = db.prepare(
      `SELECT source, message_id, device_id, duration_min, activity FROM workouts
        WHERE line_user_id='U_PEACH' AND logged_date=? ORDER BY id`).all(w.date);
    check('ส่งรูปแล้วซิงก์ตามมา เหลือแถวเดียว', rows2.length === 1);
    check('ทับด้วยตัวเลขจากนาฬิกา', rows2[0]?.duration_min === w.duration_min);
    check('ยังคง message_id ของรูปไว้ (reply แก้วันที่ยังใช้ได้)',
      rows2[0]?.message_id === 'm-photo-1' && String(rows2[0]?.device_id).startsWith('whoop:'));
    check('ทับด้วยตัวเลขนาฬิกาแล้วก็ยังติดสัญลักษณ์ไว้เหมือนกัน', String(rows2[0]?.activity).startsWith('⌚ '));
    await send(textEvent('U_PEACH', 'ซิงก์'));
    check('ซิงก์ซ้ำหลังทับแล้ว ไม่เพิ่มแถว',
      db.prepare(`SELECT COUNT(*) AS n FROM workouts WHERE line_user_id='U_PEACH' AND logged_date=?`).get(w.date).n === 1);

    // กิจกรรมคนละอย่างแต่เวลาใกล้กัน = คนละรอบ ต้องไม่ถูกรวม
    db.prepare(`DELETE FROM workouts WHERE line_user_id='U_PEACH' AND logged_date=?`).run(w.date);
    db.prepare(`INSERT INTO workouts (chat_id, line_user_id, activity, duration_min, kcal, source, message_id, logged_date)
                VALUES ('G1','U_PEACH','ว่ายน้ำ',?,400,'image','m-photo-2',?)`)
      .run(w.duration_min + 3, w.date);
    await send(textEvent('U_PEACH', 'ซิงก์'));
    check('คนละกิจกรรม เวลาใกล้กัน ยังนับแยก',
      db.prepare(`SELECT COUNT(*) AS n FROM workouts WHERE line_user_id='U_PEACH' AND logged_date=?`).get(w.date).n === 2);
  }

  // สั่งซ้ำต้องไม่บันทึกซ้ำ
  await send(textEvent('U_PEACH', 'ซิงก์'));
  const after = db.prepare(`SELECT COUNT(*) AS n FROM workouts WHERE source='device'`).get().n;
  check('สั่งซิงก์ซ้ำไม่บันทึกซ้ำ', after === rows.length);

  // รายการที่เช็คอินให้ต้องนับรวมในคำสั่ง "วันนี้" ด้วย
  CURRENT_NAME = 'Milk';
  const today = await send(textEvent('U_MILK', 'วันนี้'));
  check('รายการจากนาฬิกานับรวมในเช็คชื่อวันนี้', today[0].includes('Peach'));

  // cron ทุก 3 ชม. ต้องไปเรียกงานซิงก์ ไม่ใช่ไปทวงกลุ่ม
  await settle();
  replies.length = 0;
  await worker.scheduled({ cron: '0 */3 * * *' }, env, ctx);
  await settle();
  check('cron ซิงก์ไม่ push ทวงกลุ่ม', replies.length === 0);
}

// ---- การนอน + recovery ----
console.log('\n--- การนอน + recovery ---');
// ตัวอย่าง response ตามสเปกของแต่ละเจ้า (WHOOP ยังไม่ได้ยืนยันกับของจริง)
const whoopSleep = WN.normalizeWhoopSleep({ records: [{
  id: 's1', start: '2026-08-23T16:10:00Z', end: '2026-08-23T23:40:00Z', nap: false,
  score_state: 'SCORED', score: { sleep_performance_percentage: 88, sleep_efficiency_percentage: 92,
    stage_summary: { total_in_bed_time_milli: 27000000, total_awake_time_milli: 1800000,
      total_slow_wave_sleep_time_milli: 5400000, total_rem_sleep_time_milli: 6300000 } } }] });
check('WHOOP: หลับจริง = เวลาบนเตียง - ตื่น', whoopSleep.asleep_min === 420);
check('WHOOP: อ่านคะแนนการนอน', whoopSleep.performance_pct === 88);
check('WHOOP: หลับลึกกับ REM เป็นนาที', whoopSleep.deep_min === 90 && whoopSleep.rem_min === 105);
check('WHOOP: ลงวันที่ตามวันที่ตื่น', whoopSleep.date === '2026-08-24');
check('WHOOP: งีบกลางวันไม่ถูกเลือกมาเป็นการนอนหลัก',
  WN.normalizeWhoopSleep({ records: [
    { id: 'n', nap: true, start: '2026-08-24T06:00:00Z', end: '2026-08-24T07:00:00Z', score_state: 'SCORED', score: {} },
    { id: 'm', nap: false, start: '2026-08-23T16:00:00Z', end: '2026-08-23T23:00:00Z', score_state: 'SCORED', score: {} },
  ] }).start === '2026-08-23T16:00:00Z');

const gSleep = WN.normalizeGoogleSleep({ dataPoints: [
  { sleep: { metadata: { mainSleep: false, nap: true },
    interval: { startTime: '2026-08-24T06:00:00Z', endTime: '2026-08-24T06:40:00Z' },
    summary: { minutesAsleep: '40', minutesInSleepPeriod: '40' } } },
  { sleep: { metadata: { mainSleep: true },
    interval: { startTime: '2026-08-23T16:30:00Z', endTime: '2026-08-23T23:15:00Z' },
    summary: { minutesAsleep: '395', minutesInSleepPeriod: '410', minutesAwake: '15',
      stagesSummary: [ { type: 'DEEP', minutes: '62', count: '4' }, { type: 'REM', minutes: '88', count: '5' },
                       { type: 'LIGHT', minutes: '245', count: '20' }, { type: 'AWAKE', minutes: '15', count: '6' } ] } } },
]});
check('Fitbit: นาทีที่เป็น string แปลงแล้ว', gSleep.asleep_min === 395);
check('Fitbit: เลือกการนอนหลักจาก mainSleep ไม่ใช่ตัวแรก', gSleep.start === '2026-08-23T16:30:00Z');
check('Fitbit: อ่านหลับลึก/REM จาก stagesSummary ได้', gSleep.deep_min === 62 && gSleep.rem_min === 88);
check('Fitbit: ยังไม่มีคะแนนการนอนให้ดึง (API ไม่มี)', gSleep.performance_pct === null);

const gRec = WN.normalizeGoogleRecovery(
  { dataPoints: [{ dailyRestingHeartRate: { beatsPerMinute: '58' } }] },
  { dataPoints: [{ dailyHeartRateVariability: { averageHeartRateVariabilityMilliseconds: 46.7 } }] });
check('Fitbit: ประกอบ recovery จากสอง endpoint', gRec.resting_hr === 58 && gRec.hrv_ms === 47);
check('Fitbit: ไม่มีข้อมูลเลย → null ไม่ใช่ก้อนว่าง',
  WN.normalizeGoogleRecovery({ dataPoints: [] }, { dataPoints: [] }) === null);

const whoopRec = WN.normalizeWhoopRecovery({ records: [{ score_state: 'SCORED',
  score: { recovery_score: 71.4, resting_heart_rate: 52, hrv_rmssd_milli: 88.2 } }] });
check('WHOOP: อ่าน recovery ครบ',
  whoopRec.recovery_pct === 71 && whoopRec.resting_hr === 52 && whoopRec.hrv_ms === 88);
check('WHOOP: ยังไม่ได้คะแนน → ไม่เอาตัวเลขมั่วมาโชว์',
  WN.normalizeWhoopRecovery({ records: [{ score_state: 'PENDING_SCORE', score: { recovery_score: 99 } }] }).recovery_pct === null);

// ---- Readiness (สูตรที่เจ้าของให้มา) ----
// ยึดผลลัพธ์จากสูตร Python ต้นฉบับ ถ้าเลขเพี้ยนเมื่อไหร่แปลว่าแก้สูตรผิด
for (const [inp, want] of [
  [{ todayHrv: 25, baselineHrv: 25, sleepScore: 74, prevDayAzm: 0 }, 84],
  [{ todayHrv: 30, baselineHrv: 25, sleepScore: 74, prevDayAzm: 20 }, 89],
  [{ todayHrv: 20, baselineHrv: 25, sleepScore: 60, prevDayAzm: 91 }, 60],
  [{ todayHrv: 10, baselineHrv: 25, sleepScore: 50, prevDayAzm: 200 }, 31],
]) {
  check(`readiness(${inp.todayHrv}/${inp.baselineHrv}, ${inp.sleepScore}, ${inp.prevDayAzm}) = ${want}`,
    WN.readinessScore(inp) === want);
}
check('ขาดข้อมูลตัวใดตัวหนึ่ง → ไม่เดา คืน null',
  WN.readinessScore({ todayHrv: null, baselineHrv: 25, sleepScore: 74, prevDayAzm: 0 }) === null &&
  WN.readinessScore({ todayHrv: 25, baselineHrv: 25, sleepScore: null, prevDayAzm: 0 }) === null);
check('AZM หนักมากก็ไม่ต่ำกว่าพื้น 40',
  WN.readinessScore({ todayHrv: 25, baselineHrv: 25, sleepScore: 100, prevDayAzm: 9999 }) ===
  Math.round(85 * 0.45 + 100 * 0.35 + 40 * 0.20));

const hrvS = WN.hrvSeries({ dataPoints: [25, 30, 20, 25].map((v) => ({
  dailyHeartRateVariability: { averageHeartRateVariabilityMilliseconds: v } })) });
check('HRV: วันนี้คือรายการแรก', hrvS.today === 25);
check('ค่าฐานไม่รวมวันนี้ (ไม่งั้นวิ่งตามตัวเอง)', hrvS.baseline === 25);

const azmToday = new Date(Date.now() + 7 * 3600e3 - 86400e3).toISOString().slice(0, 10);
const azmBody = { dataPoints: [
  { activeZoneMinutes: { activeZoneMinutes: '20', interval: { startTime: azmToday + 'T02:00:00Z' } } },
  { activeZoneMinutes: { activeZoneMinutes: '15', interval: { startTime: azmToday + 'T09:00:00Z' } } },
  { activeZoneMinutes: { activeZoneMinutes: '99', interval: { startTime: '2020-01-01T00:00:00Z' } } },
]};
check('AZM: บวกเฉพาะของวันที่ขอ', WN.azmForDate(azmBody, azmToday) === 35);
check('AZM: ไม่มีข้อมูลวันนั้น → null ไม่ใช่ 0', WN.azmForDate(azmBody, '2019-05-05') === null);

const est = WN.estimateSleepScore({ asleep_min: 395, deep_min: 62, rem_min: 88, efficiency_pct: 96 });
console.log(`  (ค่าประมาณคะแนนการนอนจากข้อมูลจริงของแฟน = ${est} · Fitbit จริงบอก 74)`);
check('ประมาณคะแนนการนอนได้ตัวเลขในช่วงที่สมเหตุสมผล', est > 0 && est <= 100);
check('ไม่มีข้อมูลการนอน → ไม่ประมาณ', WN.estimateSleepScore(null) === null);

// รูปแบบข้อความที่เจ้าของกำหนด — ล็อกไว้กันแก้แล้วเพี้ยน
{
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const cut = src.slice(src.indexOf('// 428 นาที'), src.indexOf('async function replySleep'));
  const fmt = await import('data:text/javascript,' + encodeURIComponent(cut + '\nexport { sleepBlock };'));
  const whoop = fmt.sleepBlock('Milk', { provider: 'whoop',
    sleep: { asleep_min: 428, performance_pct: 88, deep_min: 105, rem_min: 99 },
    recovery: { recovery_pct: 71 } });
  const fitbit = fmt.sleepBlock('Charlie:P', { provider: 'google',
    sleep: { asleep_min: 395, deep_min: 62, rem_min: 88, score_for_readiness: 74 },
    recovery: { readiness: 69, readiness_inputs: { sleep_score_estimated: false } } });
  console.log('\n' + whoop + '\n\n\n' + fitbit + '\n');
  check('Whoop: หัวข้อ "ชื่อ ยี่ห้อ —" แล้วเว้นบรรทัด',
    whoop.startsWith('Milk Whoop —\n\n'));
  check('Whoop: Sleep / Score บรรทัดเดียว', whoop.includes('Sleep 7.08 hrs / Score 88%'));
  check('Whoop: Deep / REM เป็นชั่วโมง', whoop.includes('Deep 1.45 hrs / REM 1.39 hrs'));
  check('Whoop: ปิดท้ายด้วย Recovery', whoop.trim().endsWith('Recovery 71%'));
  check('Fitbit: Score ไม่มี % (คนละสเกลกับ Whoop)', fitbit.includes('Sleep 6.35 hrs / Score 74'));
  check('Fitbit: ปิดท้ายด้วย Readiness', fitbit.trim().endsWith('Readiness 69'));
  check('ไม่มีดาวเมื่อใช้คะแนนจริง', !fitbit.includes('*'));
  const guess = fmt.sleepBlock('X', { provider: 'google',
    sleep: { asleep_min: 400, score_for_readiness: 89 },
    recovery: { readiness: 88, readiness_inputs: { sleep_score_estimated: true } } });
  check('ติดดาวทั้ง Score และ Readiness เมื่อเป็นค่าประมาณ',
    guess.includes('Score 89*') && guess.includes('Readiness 88*'));
  check('ไม่มีข้อมูล → ไม่ขึ้นบรรทัดตัวเลขปลอม',
    fmt.sleepBlock('Y', { provider: 'whoop', sleep: null, recovery: null })
      .includes('ยังไม่มีข้อมูลการนอน'));
}

show('Milk พิมพ์ "คะแนนนอน 74"', await send(dmEvent('U_DM', 'คะแนนนอน 74')));
check('เก็บคะแนนที่กรอกเองลงฐานข้อมูล',
  db.prepare(`SELECT score FROM sleep_scores WHERE line_user_id='U_DM'`).get()?.score === 74);
show('Milk พิมพ์ "คะแนนนอน 250" (นอกช่วง)', await send(dmEvent('U_DM', 'คะแนนนอน 250')));

// แต่ละห้องต้องเห็นเฉพาะคนในห้องตัวเอง (เคสจริง 25 ส.ค.: กลุ่มครอบครัวเห็นการนอนของแฟน)
{
  db.prepare(`INSERT OR REPLACE INTO users (line_user_id, display_name, target_kcal, target_protein_g)
              VALUES ('U_OTHER','คนกลุ่มอื่น', 2000, 120)`).run();
  db.prepare(`INSERT INTO meals (line_user_id, name, kcal, protein_g, eaten_date)
              VALUES ('U_OTHER','ข้าวผัด', 500, 20, ?)`).run(new Date(Date.now()+7*3600e3).toISOString().slice(0,10));
  // U_OTHER คุยอยู่คนละห้อง ไม่เคยโผล่ในแชทของ U_DM
  await send({ type: 'message', replyToken: 'rt', source: { type: 'user', userId: 'U_OTHER' },
               message: { type: 'text', id: 'm-other', text: 'สวัสดี' } });

  const mine = await send(dmEvent('U_DM', 'สรุป'));
  check('สรุปไม่หลุดข้อมูลคนที่อยู่คนละห้อง', !mine[0].includes('คนกลุ่มอื่น'));
  check('ยังเห็นของตัวเองปกติ', mine[0].includes('Milk'));

  const week = await send(dmEvent('U_DM', 'สัปดาห์'));
  check('สัปดาห์ก็ไม่หลุดเหมือนกัน', !week[0].includes('คนกลุ่มอื่น'));

  // ห้องของ U_OTHER เองต้องเห็นของตัวเอง
  const theirs = await send({ type: 'message', replyToken: 'rt', source: { type: 'user', userId: 'U_OTHER' },
                              message: { type: 'text', id: 'm-other2', text: 'สรุป' } });
  check('ห้องของเขาเห็นของเขาเอง', theirs[0].includes('คนกลุ่มอื่น'));
  check('และไม่เห็นของเรา', !theirs[0].includes('Milk'));
}

// "วันนี้" ในโหมดแคลอรี่ต้องได้สรุป ไม่ใช่เงียบ (เคสจริงกลุ่ม MCL FOOD 24 ส.ค.)
const calToday = await send(dmEvent('U_DM', 'วันนี้'));
show('Milk พิมพ์ "วันนี้" ในแชทโหมดแคลอรี่', calToday);
check('"วันนี้" โหมดแคลอรี่ตอบสรุป ไม่เงียบ', calToday.length > 0);
check('ได้สรุปแบบเดียวกับคำสั่ง "สรุป"',
  calToday[0] === (await send(dmEvent('U_DM', 'สรุป')))[0]);

// ข้อความหลังซิงก์ต้องไม่ชี้ให้พิมพ์ "วันนี้" ในกลุ่มที่ไม่ใช่โหมดชาเลนจ์
{
  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_PEACH'`).run();
  const inCal = await send(dmEvent('U_PEACH', 'ซิงก์'));
  show('Peach สั่ง "ซิงก์" จากแชทโหมดแคลอรี่', inCal);
  check('บอกว่ารายการไปลงกลุ่มชาเลนจ์', inCal[0].includes('กลุ่มชาเลนจ์ของคุณ'));
  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_PEACH'`).run();
  const inChal = await send(textEvent('U_PEACH', 'ซิงก์'));
  check('ในกลุ่มชาเลนจ์ยังบอกให้พิมพ์ "วันนี้" ตรงนั้น',
    inChal[0].includes('พิมพ์ "วันนี้" เพื่อดูผล'));
}

const sleepApi = await api('/api/sleep?key=dash');
check('/api/sleep ตอบได้แม้ยังไม่มีใครเชื่อม', Array.isArray(sleepApi.people));
const sleepNoAuth = await worker.fetch(new Request('https://x/api/sleep'), env, ctx);
check('/api/sleep ต้องมี DASHBOARD_KEY', sleepNoAuth.status === 401);
show('Milk พิมพ์ "นอน" ตอนยังไม่ได้เชื่อมนาฬิกา', await send(dmEvent('U_DM', 'นอน')));

// ---- ดูข้อมูลดิบ ----
const peeked = await api('/api/device-peek?key=dash&provider=whoop&kind=workout');
check('ดูข้อมูลดิบจากบัญชีที่เชื่อมไว้ได้', peeked.status === 200 && !!peeked.body?.records?.length);
const peekNoLink = await api('/api/device-peek?key=dash&provider=google&kind=workout');
check('ยี่ห้อที่ยังไม่มีใครเชื่อม → บอกเหตุผล ไม่ระเบิด',
  String(peekNoLink.error || '').includes('ยังไม่มีใครเชื่อม'));
const peekNoAuth = await worker.fetch(new Request('https://x/api/device-peek?provider=whoop'), env, ctx);
check('device-peek ต้องมี DASHBOARD_KEY', peekNoAuth.status === 401);
const peekBad = await api('/api/device-peek?key=dash&provider=มั่ว&kind=workout');
check('provider มั่ว → ตอบ error ไม่ throw', !!peekBad.error);

const health = await api('/api/health?key=dash');
console.log('  wearables ใน /api/health:', JSON.stringify(health.wearables));
check('/api/health บอกว่าตั้งค่าครบแล้ว', health.wearables.whoop.ready && health.wearables.google.ready);
check('LINE token ปกติไม่ถูกเตือน', !health.LINE_CHANNEL_ACCESS_TOKEN.looks_wrong);
const shortLine = await worker.fetch(
  new Request('https://x/api/health?key=dash'), { ...env, LINE_CHANNEL_ACCESS_TOKEN: 'x'.repeat(73) }, ctx);
check('LINE token สั้นผิดปกติ → เตือน',
  String((await shortLine.json()).LINE_CHANNEL_ACCESS_TOKEN.looks_wrong || '').includes('วางผิดช่อง'));
check('health โชว์ client_id ให้เทียบได้', health.wearables.whoop.client_id === env.WHOOP_CLIENT_ID);
check('health บอกว่าไม่มีปัญหาการตั้งค่า', health.wearables.whoop.problem === null);
check('health ไม่หลุด client_secret ออกมา',
  !JSON.stringify(health).includes(env.WHOOP_CLIENT_SECRET) && !JSON.stringify(health).includes(env.GOOGLE_CLIENT_SECRET));
check('health บอกความยาว client_secret แทน', health.wearables.whoop.client_secret_length === 64);

// ค่าที่วางพลาดต้องถูกจับได้ก่อนส่งไปให้ผู้ให้บริการปฏิเสธ
const brokenEnv = { ...env, WHOOP_CLIENT_ID: '\u0016', WHOOP_CLIENT_SECRET: 'xxxxxxxxxxxx' };
const linkB = (await send(dmEvent('U_DM', 'เชื่อมนาฬิกา')))[0].match(/connect\?t=([a-f0-9]+)/)[1];
const blocked = await worker.fetch(new Request(`https://x/oauth/whoop/start?t=${linkB}`), brokenEnv, ctx);
const blockedText = await blocked.text();
check('client_id เพี้ยน → หยุดเองพร้อมบอกเหตุผล',
  blocked.status === 400 && blockedText.includes('อักขระแปลกปลอม'));
check('ไม่ปล่อยให้เด้งไปเจอหน้า error ของผู้ให้บริการ', blocked.status !== 302);

// ---- แปลงข้อมูลนาฬิกา (ใช้ payload จริงจาก WHOOP ที่เก็บไว้ใน fixtures) ----
console.log('\n--- แปลงข้อมูลนาฬิกา ---');
const whoopBody = JSON.parse(readFileSync(new URL('./fixtures/whoop-workout.json', import.meta.url), 'utf8'));
const wo = WN.normalizeWhoopWorkouts(whoopBody);
check('อ่านครบทุกรายการ', wo.length === 5);
const lift = wo[0];
check('แปลงชื่อกีฬาเป็นไทย', lift.activity === 'เวทเทรนนิ่ง');
check('คิดนาทีจาก start/end (WHOOP ไม่มีฟิลด์ระยะเวลา)', lift.duration_min === 41);
check('แปลง kilojoule เป็นแคลอรี่', lift.kcal === Math.round(251.73279 / 4.184));
check('เก็บ strain กับหัวใจเฉลี่ย', lift.strain === 9.5 && lift.avg_hr === 99);
check('วันที่เป็นเวลาไทย', lift.date === '2026-08-23');
check('distance ที่เป็น null ไม่กลายเป็น 0', lift.distance_m === null);
check('รายการที่มีระยะทางอ่านได้', wo[1].distance_m === 72);

// รายการที่ score_state ไม่ใช่ SCORED ต้องไม่หยิบตัวเลขมั่ว ๆ มาใช้
const unscored = WN.normalizeWhoopWorkouts({ records: [{
  ...whoopBody.records[0], id: 'x', score_state: 'PENDING_SCORE' }] })[0];
check('ยังไม่ได้คะแนน → ไม่เอาตัวเลขมาใช้',
  unscored.kcal === null && unscored.strain === null && unscored.scored === false);
check('แต่ยังรู้ว่าทำอะไรกี่นาที', unscored.activity === 'เวทเทรนนิ่ง' && unscored.duration_min === 41);

// ฝั่ง Google — payload จริงจาก Fitbit (24 ส.ค. 2026)
const googleBody = JSON.parse(readFileSync(new URL('./fixtures/google-workout.json', import.meta.url), 'utf8'));
const gws = WN.normalizeGoogleWorkouts(googleBody);
check('Fitbit: อ่านครบทุกรายการ', gws.length === 5);
const spin = gws.find((x) => x.activity.includes('สปิน'));
check('Fitbit: displayName เฉพาะเจาะจงชนะ exerciseType กว้าง ๆ', !!spin && spin.sport === 'workout');
check('Fitbit: "Workout" กลายเป็นไทย', gws[0].activity === 'ออกกำลังกาย');
check('Fitbit: "Walk" กลายเป็นไทย', gws[1].activity === 'เดิน');
check('Fitbit: activeDuration ที่มีทศนิยม (2996.400s) → 50 นาที', gws[1].duration_min === 50);
check('Fitbit: เวลาทศนิยม 9 ตำแหน่งไม่ทำให้พัง', gws[4].duration_min === 66);
check('Fitbit: อ่าน recordingMethod ได้',
  gws[0].actively_started === true && gws[1].actively_started === false);
check('Fitbit: steps ที่เป็น string แปลงแล้ว', gws[1].steps === 4047);
check('Fitbit: active zone minutes อ่านได้', gws[3].active_zone_min === 32);
check('Fitbit: รู้ว่ามาจากอุปกรณ์อะไร', gws[0].device === 'Google Fitbit Air');
check('Fitbit: ทั้ง 5 รายการนับเป็นเช็คอินได้หมด', gws.every((w) => WN.countsAsCheckin(w).ok));

// กดเริ่มเอง = ตั้งใจ ต้องนับแม้จะสั้น · จับอัตโนมัติและเดินสั้น ๆ ไม่นับ
check('กดเริ่มเอง แม้สั้นก็นับ',
  WN.countsAsCheckin({ sport: 'walking', scored: true, duration_min: 8, actively_started: true }).ok === true);
check('จับอัตโนมัติ เดิน 8 นาที ไม่นับ',
  WN.countsAsCheckin({ sport: 'walking', scored: true, duration_min: 8, actively_started: false }).ok === false);
check('จับอัตโนมัติ เดินสั้นแต่หัวใจขึ้นโซนจริง ก็นับ',
  WN.countsAsCheckin({ sport: 'walking', scored: true, duration_min: 12, actively_started: false, active_zone_min: 16 }).ok === true);

// ฝั่ง Google — ตัวเลขหลายตัวมาเป็น string ต้องแปลงก่อน
const gw = WN.normalizeGoogleWorkouts({ dataPoints: [{ name: 'users/me/dataTypes/exercise/dataPoints/1', exercise: {
  displayName: 'Morning run', exerciseType: 'RUNNING', activeDuration: '1830s',
  interval: { startTime: '2026-08-24T00:10:00Z', endTime: '2026-08-24T00:45:00Z' },
  metricsSummary: { caloriesKcal: 312.7, averageHeartRateBeatsPerMinute: '148', distanceMillimeters: 5200000, steps: '6100' } } }] })[0];
check('Google: อ่าน activeDuration เป็นนาที', gw.duration_min === 31);
check('Google: หัวใจที่เป็น string แปลงเป็นตัวเลข', gw.avg_hr === 148);
check('Google: มิลลิเมตร → เมตร', gw.distance_m === 5200);
check('Google: ปัดแคลอรี่', gw.kcal === 313);

// เกณฑ์เช็คอินอัตโนมัติ
const verdicts = wo.map((w) => ({ w, v: WN.countsAsCheckin(w) }));
for (const { w, v } of verdicts) {
  console.log(`  ${v.ok ? '✅ นับ  ' : '❌ ไม่นับ'} ${w.date} ${String(w.activity).padEnd(20)} strain ${String(w.strain).padStart(5)}${v.ok ? '' : '  ← ' + v.why}`);
}
check('เวท/พิลาทิส นับหมด', verdicts.filter(x => x.w.sport !== 'walking').every(x => x.v.ok));
check('เดิน strain 1.4 ไม่นับ', verdicts.find(x => x.w.strain === 1.4).v.ok === false);
check('เดิน strain 4.6 นับ', verdicts.find(x => x.w.strain === 4.6).v.ok === true);
check('ยังไม่ได้คะแนน ไม่นับ', WN.countsAsCheckin({ ...lift, scored: false }).ok === false);
// WHOOP ไม่มี GPS — ไม่พกมือถือแล้วระยะทางหาย ต้องไม่ทำให้การออกกำลังกายจริงถูกตัดทิ้ง
check('ระยะทางเป็น null ไม่กระทบการนับ',
  WN.countsAsCheckin({ ...lift, distance_m: null }).ok === true);
check('เดินหนักแต่ไม่มีระยะทาง ก็ยังนับ',
  WN.countsAsCheckin({ sport: 'walking', scored: true, duration_min: 30, strain: 7, distance_m: null }).ok === true);
check('ฝั่ง Google ที่ไม่มี strain ใช้เวลาแทน',
  WN.countsAsCheckin({ sport: 'walking', scored: true, duration_min: 25, strain: null }).ok === true &&
  WN.countsAsCheckin({ sport: 'walking', scored: true, duration_min: 5, strain: null }).ok === false);

// ---- ถามว่าเช็คอินอะไรไว้ ----
// เจอจริง 26 ส.ค. กลุ่ม Lai & Kids: Erk แท็กบอทถามว่า "เมื่อวานผมออกกำลัง อะไรนะ"
// แล้วบอทตอบว่าไม่เข้าใจ เพราะข้อความไม่มีตัวเลขเลยตกด่านเช็คอิน
console.log('\n--- ถามว่าเช็คอินอะไรไว้ ---');
{
  const tagBot = (text, extra = {}) => textEvent('U_ERK', text, {
    mention: { mentionees: [{ index: 0, length: 8, userId: 'U_BOT', type: 'user' }] }, ...extra });

  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_ERK'`).run();
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const yst = new Date(Date.now() + 7 * 3600e3 - 86400e3).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO workouts (chat_id, line_user_id, activity, duration_min, kcal, source, logged_date)
              VALUES ('G1','U_ERK','เวทเทรนนิ่ง (bicep, shoulders, mid back)', NULL, 300, 'text', ?)`).run(yst);
  db.prepare(`INSERT INTO workouts (chat_id, line_user_id, activity, duration_min, kcal, source, logged_date)
              VALUES ('G1','U_ERK','เดิน', 40, 180, 'text', ?)`).run(yst);
  db.prepare(`INSERT INTO workouts (chat_id, line_user_id, activity, duration_min, kcal, source, logged_date)
              VALUES ('G1','U_ERK','วิ่ง', 30, 300, 'text', ?)`).run(today);

  CURRENT_NAME = 'Erk Sasin';
  const askY = await send(tagBot('@Yes Cal เมื่อวานผมออกกำลัง อะไรนะ'));
  show('Erk แท็กบอทถาม "เมื่อวานผมออกกำลัง อะไรนะ"', askY);
  const y = askY.join('\n');
  check('ตอบเป็นรายการของเมื่อวาน ไม่ใช่ "ไม่เข้าใจ"', !y.includes('ยังไม่เข้าใจ'));
  check('ขึ้นทั้งสองรายการของเมื่อวาน', y.includes('เวทเทรนนิ่ง') && y.includes('เดิน'));
  check('ไม่เอารายการของวันนี้มาปน', !y.includes('วิ่ง'));
  check('บอกยอดรวมให้ด้วย', y.includes('รวม 2 รายการ') && y.includes('480 kcal'));

  const askT = await send(tagBot('@Yes Cal วันนี้ผมออกกำลังอะไรไปบ้าง'));
  show('Erk ถามของวันนี้', askT);
  check('ของวันนี้ได้รายการวันนี้', askT.join('\n').includes('วิ่ง'));

  // ถามถึงคนอื่นด้วยการแท็กชื่อเขา — ต้องไม่กลายเป็นการบันทึกแทน
  CURRENT_NAME = 'Milk';
  const before = db.prepare(`SELECT COUNT(*) AS n FROM workouts WHERE line_user_id='U_ERK'`).get().n;
  const askOther = await send(textEvent('U_MILK', '@Erk Sasin เมื่อวานออกกำลังอะไรบ้าง', {
    mention: { mentionees: [{ index: 0, length: 10, userId: 'U_ERK', type: 'user' }] } }));
  show('Milk แท็ก Erk ถามว่าเมื่อวานออกอะไร', askOther);
  check('ถามถึงคนอื่นได้ ขึ้นชื่อเขา', askOther.join('\n').includes('Erk'));
  check('ถามแล้วต้องไม่บันทึกรายการใหม่ให้',
    db.prepare(`SELECT COUNT(*) AS n FROM workouts WHERE line_user_id='U_ERK'`).get().n === before);

  // วันที่ยังไม่มีรายการ
  const askOld = await send(tagBot('@Yes Cal 5 วันที่แล้วผมออกกำลังอะไร'));
  show('Erk ถามวันที่ยังไม่มีรายการ', askOld);
  check('ไม่มีรายการก็บอกตรง ๆ พร้อมวิธีลงย้อนหลัง',
    askOld.join('\n').includes('ยังไม่มีรายการ') && askOld.join('\n').includes('14 วัน'));

  // ประโยคที่มีตัวเลขยังต้องเช็คอินได้เหมือนเดิม ถึงจะมีคำถามปนอยู่
  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_ERK' AND logged_date=?`).run(today);
  geminiReply = { is_workout: true, activity: 'วิ่ง', duration_min: 30, kcal: 300, has_screen_data: false };
  const stillLogs = await send(textEvent('U_ERK', 'วิ่ง 5 กม. กี่แคลนะ'));
  show('Erk พิมพ์ "วิ่ง 5 กม. กี่แคลนะ" (มีตัวเลข = ยังเป็นการเช็คอิน)', stillLogs);
  check('มีตัวเลขแล้วยังเช็คอินได้ตามเดิม',
    db.prepare(`SELECT COUNT(*) AS n FROM workouts WHERE line_user_id='U_ERK' AND logged_date=?`).get(today).n === 1);
}

// ---- เล่ารายละเอียดแยกหลายข้อความแล้วมาแท็กปิดท้าย ----
// เจอจริง 27 ส.ค. กลุ่ม Lai & Kids: Jenny พิมพ์ "Golf" แล้ว "Driving range 2 hr" แล้วค่อยแท็ก
// "@Yes Cal" เฉย ๆ — บอทเห็นแค่ข้อความที่แท็กมา (ว่างเปล่า) เลยตอบว่าไม่เข้าใจ
// ต้องพิมพ์ทุกอย่างรวมกันมาในข้อความเดียวถึงจะสำเร็จ ("เราจะต้องทะเลาะกับมันทุกวันเลยหรอ")
console.log('\n--- เล่าแยกหลายข้อความแล้วแท็กปิดท้าย ---');
{
  const tagBotBare = () => textEvent('U_JENNY', '@Yes Cal', {
    mention: { mentionees: [{ index: 0, length: 8, userId: 'U_BOT', type: 'user' }] } });

  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_JENNY'`).run();
  CURRENT_NAME = 'Jenny T.';
  await send(textEvent('U_JENNY', 'เข้าร่วม'));

  geminiReply = { is_workout: true, activity: 'ไดร์ฟกอล์ฟ', duration_min: 120, kcal: null, has_screen_data: false };

  show('Jenny พิมพ์ "Golf" เดี่ยว ๆ (ไม่มีตัวเลข ไม่ตรงคำกระตุ้น — เงียบ)', await send(textEvent('U_JENNY', 'Golf')));
  show('Jenny พิมพ์ "Driving range 2 hr" เดี่ยว ๆ (มีตัวเลขแต่ยังไม่ได้แท็ก — เงียบเหมือนกัน)',
    await send(textEvent('U_JENNY', 'Driving range 2 hr')));
  check('สองข้อความนั้นยังไม่ถูกบันทึกเป็นรายการ',
    db.prepare(`SELECT COUNT(*) AS n FROM workouts WHERE line_user_id='U_JENNY'`).get().n === 0);

  const tagged = await send(tagBotBare());
  show('Jenny แท็ก "@Yes Cal" เฉย ๆ ต่อท้าย', tagged);
  const t = tagged.join('\n');
  check('รวมสองข้อความก่อนหน้าแล้วเช็คอินให้ ไม่ตอบว่าไม่เข้าใจ', !t.includes('เรียกผมเหรอ'));
  check('เช็คอินไดร์ฟกอล์ฟ 2 ชม. ให้สำเร็จ', t.includes('ไดร์ฟกอล์ฟ') && t.includes('120 นาที'));
  check('บันทึกลง workouts จริง',
    db.prepare(`SELECT COUNT(*) AS n FROM workouts WHERE line_user_id='U_JENNY'`).get().n === 1);

  // ใช้ไปแล้วต้องเคลียร์ทิ้ง ไม่งั้นแท็กเปล่า ๆ รอบถัดไปจะเอาบริบทเก่ามาปนซ้ำ
  const again = await send(tagBotBare());
  show('Jenny แท็กเปล่า ๆ อีกรอบ (ไม่มีข้อความใหม่ค้างแล้ว)', again);
  check('ครั้งที่สองไม่มีบริบทให้ใช้ ต้องตอบว่าไม่เข้าใจตามปกติ', again.join('\n').includes('เรียกผมเหรอ'));
  check('ไม่ได้บันทึกซ้ำรายการเดิม',
    db.prepare(`SELECT COUNT(*) AS n FROM workouts WHERE line_user_id='U_JENNY'`).get().n === 1);

  // คุยเล่นเฉย ๆ ไม่เกี่ยวกับการออกกำลังกาย ต่อให้ถูกเก็บไว้ก็ต้องไม่ถูกดึงมาเช็คอินมั่ว
  db.prepare(`DELETE FROM workouts WHERE line_user_id='U_JENNY'`).run();
  await send(textEvent('U_JENNY', 'วันนี้อากาศร้อนมาก'));
  const idleTag = await send(tagBotBare());
  show('Jenny คุยเล่นเรื่องอากาศ แล้วแท็กบอทเฉย ๆ', idleTag);
  check('ข้อความคุยเล่นไม่ทำให้เช็คอินมั่ว', idleTag.join('\n').includes('เรียกผมเหรอ'));
  check('ไม่มีรายการถูกสร้างขึ้นมาลอย ๆ',
    db.prepare(`SELECT COUNT(*) AS n FROM workouts WHERE line_user_id='U_JENNY'`).get().n === 0);
}

// ---- แชร์นาฬิกาเป็นรายห้อง ----
// สองเคสจริงวันที่ 25 ส.ค.
//   "ของแม่ไม่โชว์"  = แม่เชื่อมนาฬิกาแต่ไม่เคยพิมพ์ "ตั้งเป้า" เลยไม่มีแถวใน users แล้วถูกกรองทิ้ง
//   "ยกเลิกการเชื่อมจากกลุ่มครอบครัว กลุ่มแฟนต้องไม่ยกเลิก"
console.log('\n--- แชร์นาฬิกาเป็นรายห้อง ---');
{
  const linkOf = (out) => (out[0] || '').match(/connect\?t=([a-f0-9]+)/)?.[1] || null;
  const finish = async (token) => {
    const st = new URL((await worker.fetch(new Request(`https://x/oauth/whoop/start?t=${token}`), env, ctx))
      .headers.get('location')).searchParams.get('state');
    await worker.fetch(new Request(`https://x/oauth/whoop/callback?code=C_MOM&state=${st}`), env, ctx);
  };
  const linkedRows = (u) =>
    db.prepare(`SELECT COUNT(*) AS n FROM device_links WHERE line_user_id=?`).get(u).n;

  // แม่คุยในกลุ่มครอบครัวครั้งแรก — บอทต้องจำชื่อไว้เอง ไม่ต้องรอให้ตั้งเป้า
  CURRENT_NAME = 'แม่';
  const momLink = linkOf(await send(textEventIn('G_FAM', 'U_MOM', 'เชื่อมนาฬิกา')));
  check('แม่ได้ลิงก์ผูกบัญชี', !!momLink);
  await finish(momLink);
  check('แม่ไม่มีแถวใน users (ไม่เคยตั้งเป้า)',
    !db.prepare(`SELECT 1 AS x FROM users WHERE line_user_id='U_MOM'`).get());
  check('เก็บชื่อแม่ไว้ใน chat_people แทน',
    db.prepare(`SELECT display_name AS n FROM chat_people WHERE chat_id='G_FAM' AND line_user_id='U_MOM'`).get()?.n === 'แม่');

  CURRENT_NAME = 'ลูก';
  const famSleep = await send(textEventIn('G_FAM', 'U_KID', 'นอน'));
  show('พิมพ์ "นอน" ในกลุ่มครอบครัว', famSleep);
  check('แม่โผล่ในสรุปการนอนถึงจะไม่เคยตั้งเป้า', famSleep.join('\n').includes('แม่'));

  // แม่เปิดแชร์ให้กลุ่มแฟนด้วย — เชื่อมไว้แล้วจึงไม่ต้องขอสิทธิ์ใหม่ทั้งรอบ
  CURRENT_NAME = 'แม่';
  const again = await send(textEventIn('G_GF', 'U_MOM', 'เชื่อมนาฬิกา'));
  show('แม่พิมพ์ "เชื่อมนาฬิกา" ในอีกกลุ่ม (เชื่อมไว้อยู่แล้ว)', again);
  check('เชื่อมไว้แล้ว → เปิดแชร์ให้ห้องใหม่เลย ไม่ต้องส่งลิงก์อีก', !linkOf(again));
  check('แชร์ไว้ 2 ห้อง',
    db.prepare(`SELECT COUNT(*) AS n FROM device_shares WHERE line_user_id='U_MOM'`).get().n === 2);

  // ตัดการเชื่อมต่อในกลุ่มครอบครัว — กลุ่มแฟนต้องไม่กระทบ
  const cut = await send(textEventIn('G_FAM', 'U_MOM', 'ตัดการเชื่อมต่อ'));
  show('แม่พิมพ์ "ตัดการเชื่อมต่อ" ในกลุ่มครอบครัว', cut);
  check('โทเคนยังอยู่ ไม่ได้ถูกลบทิ้ง', linkedRows('U_MOM') === 1);
  check('บอกว่าห้องอื่นยังใช้ได้ตามเดิม', cut.join('\n').includes('1 ห้อง'));
  check('เหลือแชร์ห้องเดียว',
    db.prepare(`SELECT chat_id AS c FROM device_shares WHERE line_user_id='U_MOM'`).get()?.c === 'G_GF');

  CURRENT_NAME = 'ลูก';
  const famAfter = await send(textEventIn('G_FAM', 'U_KID', 'นอน'));
  check('กลุ่มครอบครัวไม่เห็นของแม่แล้ว', !famAfter.join('\n').includes('แม่'));
  CURRENT_NAME = 'แฟน';
  const gfAfter = await send(textEventIn('G_GF', 'U_GF', 'นอน'));
  check('กลุ่มแฟนยังเห็นของแม่ตามเดิม', gfAfter.join('\n').includes('แม่'));

  // สั่งเลิกทั้งหมดถึงจะลบโทเคนจริง
  CURRENT_NAME = 'แม่';
  show('แม่พิมพ์ "ตัดการเชื่อมต่อทั้งหมด"', await send(textEventIn('G_GF', 'U_MOM', 'ตัดการเชื่อมต่อทั้งหมด')));
  check('ลบโทเคนออกจากระบบแล้ว', linkedRows('U_MOM') === 0);
  check('ไม่เหลือห้องที่แชร์',
    db.prepare(`SELECT COUNT(*) AS n FROM device_shares WHERE line_user_id='U_MOM'`).get().n === 0);
  check('เลิกเองแล้วต้องไม่ถูกนับว่า "ยังเชื่อมไม่เสร็จ"',
    !(await send(textEventIn('G_GF', 'U_GF', 'นอน'))).join('\n').includes('แม่'));

  // กดลิงก์แล้วไม่กลับมา (เช่น Google ขึ้น Access blocked) ต้องมีคนบอก ไม่ใช่เงียบหาย
  CURRENT_NAME = 'ป้า';
  check('ป้าขอลิงก์แล้วยังไม่เชื่อมจบ', !!linkOf(await send(textEventIn('G_FAM', 'U_AUNT', 'เชื่อมนาฬิกา'))));
  CURRENT_NAME = 'ลูก';
  const withPending = await send(textEventIn('G_FAM', 'U_KID', 'นอน'));
  show('พิมพ์ "นอน" ตอนมีคนเชื่อมค้างอยู่', withPending);
  check('บอกว่าใครกดลิงก์แล้วยังไม่สำเร็จ', withPending.join('\n').includes('ป้า'));
}

console.log('\n--- หน้าเว็บสาธารณะ ---');
for (const [path, file] of [['/workout', 'workout.html'], ['/calories', 'calories.html'], ['/connect', 'connect.html'],
                            ['/privacy', 'privacy.html'], ['/terms', 'terms.html']]) {
  const r = await worker.fetch(new Request('https://x' + path), env, ctx);
  const body = r.status === 200 ? await r.text() : '';
  check(`${path} → ${file}`, r.status === 200 && body.includes(file));
}
// หน้าที่ Whoop/Google เอาไปโชว์ ต้องเปิดได้โดยไม่ต้องมีรหัสอะไรเลย
for (const path of ['/privacy', '/terms']) {
  const r = await worker.fetch(new Request('https://x' + path), env, ctx);
  check(`${path} เปิดได้แบบไม่ต้องใส่ key`, r.status === 200);
}

if (failed) { console.error(`\n❌ เทสไม่ผ่าน ${failed} ข้อ`); process.exit(1); }
console.log('\n✅ เทสผ่านหมด');
