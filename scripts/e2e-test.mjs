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
let lastGeminiPrompt = '';
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
    const payload = wantsSuggestion && suggestReply ? suggestReply : geminiReply;
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }) };
  }
  if (u.includes('whoop.com/oauth/oauth2/token') || u === 'https://oauth2.googleapis.com/token') {
    lastTokenRequest = { url: u, body: String(opts?.body || '') };
    if (tokenFails) return { ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' };
    return { ok: true, status: 200, text: async () => JSON.stringify({
      access_token: 'AT-' + (++tokenSeq), refresh_token: 'RT-' + tokenSeq, expires_in: 3600, scope: 'read:workout' }) };
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
const ctx = { waitUntil: (p) => p };

async function send(event) {
  replies.length = 0;
  const body = JSON.stringify({ events: [event] });
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64');
  const res = await worker.fetch(new Request('https://x/webhook', { method: 'POST', headers: { 'x-line-signature': sig }, body }), env, ctx);
  await new Promise(r => setImmediate(r));
  if (res.status !== 200) throw new Error('webhook status ' + res.status);
  return replies.map(m => m.text);
}
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
let failed = 0;
const check = (label, ok) => { console.log(`  ${ok ? 'OK ' : 'พัง'} ${label}`); if (!ok) failed++; };

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

const sleepApi = await api('/api/sleep?key=dash');
check('/api/sleep ตอบได้แม้ยังไม่มีใครเชื่อม', Array.isArray(sleepApi.people));
const sleepNoAuth = await worker.fetch(new Request('https://x/api/sleep'), env, ctx);
check('/api/sleep ต้องมี DASHBOARD_KEY', sleepNoAuth.status === 401);
show('Milk พิมพ์ "นอน" ตอนยังไม่ได้เชื่อมนาฬิกา', await send(dmEvent('U_DM', 'นอน')));

// ---- ดูข้อมูลดิบ ----
const peekNoLink = await api('/api/device-peek?key=dash&provider=whoop&kind=workout');
check('ยังไม่มีใครเชื่อม → บอกเหตุผล ไม่ระเบิด', String(peekNoLink.error || '').includes('ยังไม่มีใครเชื่อม'));
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
const pending = WN.normalizeWhoopWorkouts({ records: [{
  ...whoopBody.records[0], id: 'x', score_state: 'PENDING_SCORE' }] })[0];
check('ยังไม่ได้คะแนน → ไม่เอาตัวเลขมาใช้',
  pending.kcal === null && pending.strain === null && pending.scored === false);
check('แต่ยังรู้ว่าทำอะไรกี่นาที', pending.activity === 'เวทเทรนนิ่ง' && pending.duration_min === 41);

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
