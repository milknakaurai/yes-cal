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
  if (u.includes('/member/') || u.includes('/profile/')) {
    return { ok: true, status: 200, json: async () => ({ displayName: CURRENT_NAME }) };
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
const textEvent = (userId, text, extra = {}) => ({
  type: 'message', replyToken: 'rt', source: { type: 'group', groupId: 'G1', userId },
  message: { type: 'text', id: 'm' + (++msgSeq), text, ...extra },
});
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
geminiReply = { is_workout: true, activity: 'กอล์ฟ', duration_min: 60, kcal: 240 };
const erkImg = imageEvent('U_ERK');
show('Erk ส่งรูปกอล์ฟ (ยังไม่ได้สมัคร → เพิ่มให้อัตโนมัติ)', await send(erkImg));

CURRENT_NAME = 'Milk';
show('Milk พิมพ์ "วันนี้"', await send(textEvent('U_MILK', 'วันนี้')));
show('Milk แท็ก "@Erk Sasin เมื่อวาน"', await send(textEvent('U_MILK', '@Erk Sasin เมื่อวาน', {
  mention: { mentionees: [{ index: 0, length: 10, userId: 'U_ERK', type: 'user' }] },
})));
show('Milk พิมพ์ "วันนี้" อีกครั้ง (Erk ต้องกลับไปอยู่ฝั่งยังไม่ออก)', await send(textEvent('U_MILK', 'วันนี้')));

CURRENT_NAME = 'Erk Sasin';
geminiReply = { is_workout: true, activity: 'วิ่ง', duration_min: 30, kcal: 300 };
const erkImg2 = imageEvent('U_ERK');
show('Erk ส่งรูปวิ่ง (ของวันนี้)', await send(erkImg2));
show('Milk reply ที่รูปวิ่ง + "อันนี้คือเมื่อคืน"', await send(textEvent('U_MILK', 'อันนี้คือเมื่อคืน', { quotedMessageId: erkImg2.message.id })));

CURRENT_NAME = 'Peach';
geminiReply = { is_workout: true, activity: 'ว่ายน้ำ', duration_min: 40, kcal: 320 };
await send(imageEvent('U_PEACH'));
const botMsgId = lastBotMessageId;
CURRENT_NAME = 'Milk';
show('Milk reply ที่ "ข้อความของบอท" + "เมื่อวาน"', await send(textEvent('U_MILK', 'เมื่อวาน', { quotedMessageId: botMsgId })));

CURRENT_NAME = 'Peach';
geminiReply = { is_workout: true, activity: 'เวทเทรนนิ่ง', duration_min: 45, kcal: 280 };
show('Peach พิมพ์ "เล่นเวท 45 นาที"', await send(textEvent('U_PEACH', 'เล่นเวท 45 นาที')));
show('Peach พิมพ์ "สวัสดีตอนเช้า" (ต้องเงียบ)', await send(textEvent('U_PEACH', 'สวัสดีตอนเช้า')));
show('Peach พิมพ์ "กินข้าวเมื่อวานอร่อยมาก" (ต้องเงียบ ไม่ย้ายวัน)', await send(textEvent('U_PEACH', 'กินข้าวเมื่อวานอร่อยมาก')));
show('Peach พิมพ์ "ออกกำลังกาย" ในโหมดชาเลนจ์ (ต้องตอบวิธีใช้)', await send(textEvent('U_PEACH', 'ออกกำลังกาย')));

CURRENT_NAME = 'Milk';
show('Milk พิมพ์ "เตือน" (แท็กคนที่ยังไม่ออก)', await send(textEvent('U_MILK', 'เตือน')));
show('Milk พิมพ์ "อันดับ"', await send(textEvent('U_MILK', 'อันดับ')));
show('Milk พิมพ์ "สมาชิก"', await send(textEvent('U_MILK', 'สมาชิก')));

console.log('\n\n===== ข้อมูลในฐานข้อมูล =====');
console.log('workouts:', JSON.stringify(db.prepare('SELECT line_user_id, activity, logged_date, message_id, reply_message_id FROM workouts').all(), null, 0));
console.log('members :', JSON.stringify(db.prepare('SELECT line_user_id, display_name, active FROM challenge_members').all(), null, 0));
console.log('usage   :', JSON.stringify(db.prepare('SELECT kind, label, n FROM api_usage').all(), null, 0));
