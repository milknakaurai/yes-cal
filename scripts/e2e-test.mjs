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
  LINE_CHANNEL_ACCESS_TOKEN: 'token',
  GEMINI_API_KEY: 'key',
  DASHBOARD_KEY: 'dash',
  ASSETS: { fetch: async (u) => new Response('<!DOCTYPE html>' + String(u), { status: 200 }) },
};

// ---- ดัก fetch ----
const replies = [];
let geminiReply = null;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('generativelanguage')) {
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiReply) }] } }] }) };
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

const wk = await worker.fetch(new Request('https://x/workout'), env, ctx);
check('/workout เสิร์ฟหน้าชาเลนจ์ได้', wk.status === 200);

if (failed) { console.error(`\n❌ เทสไม่ผ่าน ${failed} ข้อ`); process.exit(1); }
console.log('\n✅ เทสผ่านหมด');
