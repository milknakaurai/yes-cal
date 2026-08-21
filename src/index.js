// Yes Cal — LINE calorie tracker bot for two people
// Cloudflare Worker: LINE webhook + Gemini calorie estimation + D1 + dashboard API + nightly cron

import { NUTRITION_HINTS } from "./food-reference.js";
import * as J from "./jokes.js";

const LINE_API = "https://api.line.me/v2/bot";
const LINE_DATA_API = "https://api-data.line.me/v2/bot";

// เป้าหมาย 4 แบบ: ปรับแคลจาก TDEE + เป้าโปรตีนต่อน้ำหนักตัว (ค่ากลางของช่วงแนะนำ)
const GOALS = {
  health:   { label: "สุขภาพทั่วไป",        kcalAdjust: 0,    proteinPerKg: 0.9 }, // 0.8-1.0
  tone:     { label: "กระชับสัดส่วน/เฟิร์ม", kcalAdjust: 0,    proteinPerKg: 1.4 }, // 1.2-1.6
  muscle:   { label: "สร้างกล้ามเนื้อ",      kcalAdjust: 400,  proteinPerKg: 1.9 }, // 1.6-2.2
  fatloss:  { label: "ลดไขมัน/ลีนหุ่น",      kcalAdjust: -500, proteinPerKg: 2.0 }, // 1.8-2.2
  // ค่าเก่าจากเวอร์ชันแรก (คนที่ตั้งเป้าไว้ก่อนหน้ายังใช้ต่อได้)
  gain:     { label: "เพิ่มน้ำหนัก",         kcalAdjust: 400,  proteinPerKg: 1.8 },
  lose:     { label: "ลดน้ำหนัก",            kcalAdjust: -500, proteinPerKg: 1.6 },
  maintain: { label: "รักษาน้ำหนัก",         kcalAdjust: 0,    proteinPerKg: 1.4 },
};

const ACTIVITY_LEVELS = [
  { n: 1, factor: 1.2, label: "นั่งทำงาน แทบไม่ออกกำลังกาย" },
  { n: 2, factor: 1.375, label: "ออกกำลังกายเบา ๆ 1-3 วัน/สัปดาห์" },
  { n: 3, factor: 1.55, label: "ออกกำลังกายปานกลาง 3-5 วัน/สัปดาห์" },
  { n: 4, factor: 1.725, label: "ออกกำลังกายหนัก 6-7 วัน/สัปดาห์" },
  { n: 5, factor: 1.9, label: "หนักมาก/นักกีฬา/งานใช้แรง" },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/")) {
      return handleApi(url, request, env);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // 15:00 UTC = 22:00 ไทย → เตือนกลุ่มชาเลนจ์
    // 14:00 UTC = 21:00 ไทย → สรุปแคลอรี่ (ปิดอยู่ เปิดได้โดยเพิ่ม cron ใน wrangler.toml)
    ctx.waitUntil(
      event.cron === "0 14 * * *" ? pushNightlySummary(env) : pushChallengeReminder(env)
    );
  },
};

// ---------------------------------------------------------------- webhook

async function handleWebhook(request, env, ctx) {
  const bodyText = await request.text();

  const ok = await verifyLineSignature(
    bodyText,
    request.headers.get("x-line-signature"),
    sec(env, "LINE_CHANNEL_SECRET")
  );
  if (!ok) return new Response("Bad signature", { status: 403 });

  const body = JSON.parse(bodyText);
  // ตอบ 200 ทันที กัน LINE retry แล้วค่อยประมวลผลต่อเบื้องหลัง
  ctx.waitUntil(handleEvents(body.events || [], env));
  return new Response("OK");
}

async function verifyLineSignature(bodyText, signature, secret) {
  if (!signature || !secret) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(bodyText));
  return bytesToBase64(new Uint8Array(mac)) === signature;
}

async function handleEvents(events, env) {
  for (const event of events) {
    try {
      await handleEvent(event, env);
    } catch (err) {
      console.error("event error", err.stack || err.message);
      if (event.replyToken) {
        await lineReply(env, event.replyToken, "ขอโทษครับ มีปัญหาชั่วคราว ลองใหม่อีกทีนะ 🙏").catch(() => {});
      }
    }
  }
}

async function handleEvent(event, env) {
  // จำห้องแชทไว้สำหรับส่งข้อความเตือนตามเวลา
  if (event.source) await rememberChatTarget(env, event.source);

  if (event.type === "join" || event.type === "follow") {
    return lineReply(env, event.replyToken, greetingText());
  }
  if (event.type !== "message") return;

  const userId = event.source?.userId;
  if (!userId) return;

  const chatId = event.source.groupId || event.source.roomId || userId;
  const text = event.message.type === "text" ? event.message.text.trim() : "";
  const mode = await getChatMode(env, chatId);

  // สลับกลุ่มนี้เข้าโหมดชาเลนจ์ — เฉพาะในกลุ่ม และเฉพาะตอนที่ยังไม่ได้อยู่โหมดนี้
  // (กันคนพิมพ์คำว่า "ออกกำลังกาย" ลอย ๆ ในกลุ่มชาเลนจ์แล้วเจอข้อความต้อนรับซ้ำ
  //  ในโหมดชาเลนจ์คำนี้จะถูกอ่านเป็นการรายงานว่าออกกำลังกายมาแทน)
  if (mode !== "challenge" && event.source.type !== "user" && /^(ออกกำลังกาย|โหมดชาเลนจ์)$/.test(text)) {
    await env.DB.prepare("UPDATE chat_targets SET mode = 'challenge' WHERE id = ?").bind(chatId).run();
    return lineReply(env, event.replyToken, challengeWelcomeText());
  }

  if (mode === "challenge") {
    if (event.message.type === "image") return handleChallengeImage(env, event, chatId, userId);
    if (event.message.type === "text") return handleChallengeText(env, event, chatId, userId, text);
    return;
  }

  if (event.message.type === "image") {
    return handleImageMessage(event, env, userId);
  }
  if (event.message.type === "text") {
    return handleTextMessage(event, env, userId);
  }
}

async function rememberChatTarget(env, source) {
  const id = source.groupId || source.roomId || source.userId;
  const type = source.type; // 'group' | 'room' | 'user'
  if (!id) return;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO chat_targets (id, type) VALUES (?, ?)"
  ).bind(id, type).run();
}

// ---------------------------------------------------------------- text commands

async function handleTextMessage(event, env, userId) {
  const text = event.message.text.trim();
  const user = await getOrCreateUser(env, userId, event.source);

  // อยู่ระหว่าง flow ตั้งเป้า → ข้อความถัดไปคือคำตอบ
  if (user.setup_state) {
    if (/^ยกเลิก/.test(text)) {
      await env.DB.prepare(
        "UPDATE users SET setup_state = NULL, setup_draft = NULL WHERE line_user_id = ?"
      ).bind(userId).run();
      return lineReply(env, event.replyToken, `ยกเลิกการตั้งเป้าแล้วครับ (${user.display_name})`);
    }
    return continueSetup(env, event, user, text);
  }

  if (/^(ตั้งเป้า|ตั้งเป้าหมาย)$/.test(text)) return startSetup(env, event, user);
  if (/^(ช่วยเหลือ|คำสั่ง|help)$/i.test(text)) return lineReply(env, event.replyToken, helpText());
  if (/^เป้าหมาย$/.test(text)) return replyGoal(env, event, user);
  const proteinGoalMatch = text.match(/^เป้าโปรตีน\s*(\d+)?\s*(?:g|กรัม)?$/i);
  if (proteinGoalMatch) return setProteinTarget(env, event, user, parseInt(proteinGoalMatch[1] || "0", 10));
  if (/^สรุป$/.test(text)) return replyTodaySummary(env, event);
  if (/^(สัปดาห์|รายสัปดาห์)$/.test(text)) return replyWeekSummary(env, event);
  if (/^(ลบล่าสุด|ลบ)$/.test(text)) return deleteLastMeal(env, event, user);
  if (/^(ล้างวันนี้|รีเซ็ตวันนี้|เริ่มใหม่วันนี้|ล้าง|รีเซ็ต|reset)$/i.test(text)) return clearToday(env, event, user);

  const weightMatch = text.match(/^(?:น้ำหนัก|นน\.?)\s*([\d.]+)\s*(?:กก|kg)?\.?$/i);
  if (weightMatch) return logWeight(env, event, user, parseFloat(weightMatch[1]));

  // ไม่ใช่คำสั่ง → ให้ Gemini ดูว่าเป็นการบอกว่ากินอะไรไหม
  return maybeLogFoodFromText(env, event, user, text);
}

function greetingText() {
  return [
    "สวัสดีครับ ผม Yes Cal 🍚 บอทนับแคลอรี่ประจำบ้าน",
    "",
    "เริ่มจากพิมพ์ \"ตั้งเป้า\" เพื่อคำนวณแคลอรี่เป้าหมายของแต่ละคนก่อนนะครับ (พิมพ์ได้ทั้งสองคนเลย)",
    "",
    "จากนั้นกินอะไรก็พิมพ์บอกได้เลย เช่น \"ข้าวมันไก่ 1 จาน\" หรือส่งรูปอาหารมาก็ได้ 📸",
    "",
    "💪 ถ้าเป็นกลุ่มชาเลนจ์ออกกำลังกาย พิมพ์ \"ออกกำลังกาย\" เพื่อสลับโหมด",
    "พิมพ์ \"คำสั่ง\" เพื่อดูวิธีใช้ทั้งหมด",
  ].join("\n");
}

function helpText() {
  return [
    "วิธีใช้ Yes Cal 📖",
    "",
    "🍽️ บันทึกอาหาร — พิมพ์สิ่งที่กิน เช่น",
    "  \"ข้าวมันไก่ 1 จาน\"  \"ชาเย็นแก้วใหญ่\"",
    "  หรือส่งรูปอาหารมาเลย",
    "",
    "🎯 ตั้งเป้า — คำนวณแคลเป้าหมายรายวัน",
    "💪 เป้าโปรตีน 140 — ตั้งเป้าโปรตีนเอง (ปกติคำนวณให้จากน้ำหนัก)",
    "⚖️ น้ำหนัก 65.5 — บันทึกน้ำหนักวันนี้",
    "📊 สรุป — ยอดวันนี้ของทั้งคู่",
    "📅 สัปดาห์ — ย้อนหลัง 7 วัน",
    "🗑️ ลบล่าสุด — ลบรายการอาหารล่าสุดของวันนี้",
    "🧹 ล้างวันนี้ — ลบรายการอาหารวันนี้ทั้งหมด (เฉพาะของตัวเอง)",
    "🎯 เป้าหมาย — ดูเป้าที่ตั้งไว้",
    "",
    "อยากดูยอดเมื่อไหร่พิมพ์ \"สรุป\" ได้เลยครับ 🌙",
  ].join("\n");
}

// ---------------------------------------------------------------- setup flow (TDEE)

async function startSetup(env, event, user) {
  await env.DB.prepare(
    "UPDATE users SET setup_state = 'sex', setup_draft = '{}' WHERE line_user_id = ?"
  ).bind(user.line_user_id).run();
  return lineReply(
    env, event.replyToken,
    `มาตั้งเป้ากันครับ ${user.display_name} 🎯\n(ถามทีละข้อ ตอบในแชทได้เลย / พิมพ์ "ยกเลิก" เพื่อออก)\n\nข้อ 1: เพศอะไรครับ? (ชาย/หญิง)`
  );
}

async function continueSetup(env, event, user, text) {
  const draft = JSON.parse(user.setup_draft || "{}");
  const state = user.setup_state;
  let nextState = null;
  let reply = "";

  const num = parseFloat((text.match(/[\d.]+/) || [])[0]);

  if (state === "sex") {
    if (/ชาย|ผู้ช|^ช$|male/i.test(text)) draft.sex = "male";
    else if (/หญิง|ผู้ห|^ญ$|female/i.test(text)) draft.sex = "female";
    else return lineReply(env, event.replyToken, "ตอบ \"ชาย\" หรือ \"หญิง\" ครับ");
    nextState = "age";
    reply = "ข้อ 2: อายุเท่าไหร่ครับ? (ปี)";
  } else if (state === "age") {
    if (!num || num < 10 || num > 100) return lineReply(env, event.replyToken, "ขออายุเป็นตัวเลข 10-100 ปีครับ");
    draft.age = Math.round(num);
    nextState = "height";
    reply = "ข้อ 3: ส่วนสูงกี่เซนติเมตรครับ?";
  } else if (state === "height") {
    if (!num || num < 100 || num > 250) return lineReply(env, event.replyToken, "ขอส่วนสูง 100-250 ซม. ครับ");
    draft.height_cm = num;
    nextState = "weight";
    reply = "ข้อ 4: น้ำหนักกี่กิโลกรัมครับ?";
  } else if (state === "weight") {
    if (!num || num < 25 || num > 300) return lineReply(env, event.replyToken, "ขอน้ำหนัก 25-300 กก. ครับ");
    draft.weight_kg = num;
    nextState = "activity";
    reply =
      "ข้อ 5: กิจกรรมในแต่ละวันระดับไหนครับ? (ตอบ 1-5)\n" +
      ACTIVITY_LEVELS.map((a) => `${a.n}. ${a.label}`).join("\n");
  } else if (state === "activity") {
    const lvl = ACTIVITY_LEVELS.find((a) => a.n === Math.round(num));
    if (!lvl) return lineReply(env, event.replyToken, "ตอบเป็นตัวเลข 1-5 ครับ");
    draft.activity = lvl.factor;
    nextState = "goal";
    reply = [
      "ข้อสุดท้าย: เป้าหมายคืออะไรครับ? (ตอบ 1-4)",
      "1. สุขภาพทั่วไป — รักษาน้ำหนัก กินให้พอดี",
      "2. กระชับสัดส่วน/เฟิร์ม — ออกกำลังกายสม่ำเสมอ อยากให้ตัวไม่เหลว",
      "3. สร้างกล้ามเนื้อ — เล่นเวท อยากเพิ่มมวลกล้าม",
      "4. ลดไขมัน/ลีนหุ่น — คุมแคล ลดไขมันโดยไม่ให้กล้ามหาย",
    ].join("\n");
  } else if (state === "goal") {
    if (/^1|สุขภาพ/.test(text)) draft.goal_type = "health";
    else if (/^2|กระชับ|เฟิร์ม|โทน/.test(text)) draft.goal_type = "tone";
    else if (/^3|กล้าม|เวท|เพิ่ม/.test(text)) draft.goal_type = "muscle";
    else if (/^4|ลด|ลีน|ไขมัน/.test(text)) draft.goal_type = "fatloss";
    else return lineReply(env, event.replyToken, "ตอบ 1, 2, 3 หรือ 4 ครับ");
    return finishSetup(env, event, user, draft);
  }

  await env.DB.prepare(
    "UPDATE users SET setup_state = ?, setup_draft = ? WHERE line_user_id = ?"
  ).bind(nextState, JSON.stringify(draft), user.line_user_id).run();
  return lineReply(env, event.replyToken, reply);
}

function calcTargets(d) {
  // Mifflin-St Jeor
  const bmr =
    10 * d.weight_kg + 6.25 * d.height_cm - 5 * d.age + (d.sex === "male" ? 5 : -161);
  const tdee = bmr * d.activity;
  const adjust = GOALS[d.goal_type]?.kcalAdjust ?? 0;
  return { bmr: Math.round(bmr), tdee: Math.round(tdee), target: Math.round(tdee + adjust) };
}

async function finishSetup(env, event, user, draft) {
  const { bmr, tdee, target } = calcTargets(draft);
  const goal = GOALS[draft.goal_type];
  const proteinT = Math.round((draft.weight_kg * goal.proteinPerKg) / 5) * 5;
  await env.DB.prepare(
    `UPDATE users SET sex=?, age=?, height_cm=?, weight_kg=?, activity=?, goal_type=?,
     target_kcal=?, target_protein_g=?, setup_state=NULL, setup_draft=NULL WHERE line_user_id=?`
  ).bind(
    draft.sex, draft.age, draft.height_cm, draft.weight_kg, draft.activity,
    draft.goal_type, target, proteinT, user.line_user_id
  ).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO weights (line_user_id, weight_kg, logged_date) VALUES (?, ?, ?)"
  ).bind(user.line_user_id, draft.weight_kg, bkkToday()).run();

  const adjustTh = goal.kcalAdjust ? ` (${goal.kcalAdjust > 0 ? "+" : "−"}${Math.abs(goal.kcalAdjust)} kcal/วัน)` : "";
  return lineReply(env, event.replyToken, [
    `ตั้งเป้าเสร็จแล้วครับ ${user.display_name} ✅`,
    "",
    `BMR: ${fmtNum(bmr)} kcal`,
    `TDEE: ${fmtNum(tdee)} kcal`,
    `เป้าหมาย: ${goal.label}${adjustTh}`,
    "",
    `🎯 กินวันละ ${fmtNum(target)} kcal`,
    `💪 โปรตีนวันละ ${proteinT} g (${goal.proteinPerKg} g/กก.)`,
    "",
    "กินอะไรก็พิมพ์บอกได้เลยครับ 🍚",
  ].join("\n"));
}

async function replyGoal(env, event, user) {
  if (!user.target_kcal) {
    return lineReply(env, event.replyToken, `${user.display_name} ยังไม่ได้ตั้งเป้าครับ พิมพ์ "ตั้งเป้า" ก่อนนะ`);
  }
  const goalTh = GOALS[user.goal_type]?.label || "-";
  const pt = proteinTarget(user);
  return lineReply(env, event.replyToken,
    `เป้าของ ${user.display_name} 🎯\n${fmtNum(user.target_kcal)} kcal/วัน (${goalTh})` +
    (pt ? `\nโปรตีน ${pt} g/วัน` : "") +
    `\nน้ำหนักล่าสุด ${user.weight_kg} กก.`
  );
}

async function setProteinTarget(env, event, user, grams) {
  if (!grams) {
    const pt = proteinTarget(user);
    return lineReply(env, event.replyToken, pt
      ? `เป้าโปรตีนของ ${user.display_name}: ${pt} g/วัน\n(เปลี่ยนได้ด้วย "เป้าโปรตีน 140")`
      : `ยังไม่มีเป้าโปรตีนครับ พิมพ์ "ตั้งเป้า" ก่อน หรือตั้งตรง ๆ ด้วย "เป้าโปรตีน 140"`);
  }
  if (grams < 20 || grams > 400) {
    return lineReply(env, event.replyToken, "ขอเป้าโปรตีน 20-400 กรัมครับ เช่น \"เป้าโปรตีน 140\"");
  }
  await env.DB.prepare("UPDATE users SET target_protein_g = ? WHERE line_user_id = ?")
    .bind(grams, user.line_user_id).run();
  const totals = await getDayTotals(env, user.line_user_id, bkkToday());
  const p = Math.round(totals.protein_g || 0);
  return lineReply(env, event.replyToken,
    `ตั้งเป้าโปรตีนของ ${user.display_name} เป็นวันละ ${grams} g แล้วครับ 💪\nวันนี้ได้แล้ว ${p} g${p < grams ? ` — ขาดอีก ${grams - p} g` : " ครบแล้ว!"}`);
}

// ---------------------------------------------------------------- food logging

async function maybeLogFoodFromText(env, event, user, text) {
  // กันข้อความคุยเล่นยาว ๆ ไม่ต้องเสียโควตา Gemini
  if (text.length > 200) return;

  const result = await geminiEstimate(env, [{ text: foodPromptForText(text) }]);
  if (result?.__quota) return lineReply(env, event.replyToken, quotaText());
  if (result === null) {
    // ต่อ Gemini ไม่ได้ — บอกตรง ๆ ดีกว่าเงียบ
    return lineReply(env, event.replyToken, "ขอโทษครับ ตอนนี้ต่อระบบประเมินแคลไม่ได้ ลองอีกครั้งนะครับ 🙏");
  }
  if (!result.is_food || !result.items?.length) return; // ไม่ใช่อาหาร → เงียบไว้ ไม่รบกวนแชท

  return saveMealsAndReply(env, event, user, result, "text");
}

async function handleImageMessage(event, env, userId) {
  const user = await getOrCreateUser(env, userId, event.source);

  const { mime, b64 } = await fetchLineImage(env, event.message.id);

  const result = await geminiEstimate(env, [
    { inline_data: { mime_type: mime, data: b64 } },
    { text: foodPromptForImage() },
  ]);

  if (result?.__quota) return lineReply(env, event.replyToken, quotaText());
  if (!result || !result.is_food || !result.items?.length) {
    return lineReply(env, event.replyToken,
      `ดูจากรูปแล้วไม่แน่ใจว่าเป็นอาหารครับ 🤔 ${result?.note ? "(" + result.note + ")" : ""}\nลองพิมพ์ชื่อเมนูบอกผมแทนได้นะ`);
  }
  return saveMealsAndReply(env, event, user, result, "image");
}

async function saveMealsAndReply(env, event, user, result, source) {
  const today = bkkToday();
  const stmts = result.items.map((it) =>
    env.DB.prepare(
      `INSERT INTO meals (line_user_id, name, kcal, protein_g, carb_g, fat_g, source, eaten_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      user.line_user_id, String(it.name).slice(0, 100), Math.round(it.kcal || 0),
      round1(it.protein_g), round1(it.carb_g), round1(it.fat_g), source, today
    )
  );
  await env.DB.batch(stmts);

  const totals = await getDayTotals(env, user.line_user_id, today);
  const itemLines = result.items.map((it) =>
    `• ${it.name} ≈ ${fmtNum(Math.round(it.kcal || 0))} kcal (P${Math.round(it.protein_g || 0)}/C${Math.round(it.carb_g || 0)}/F${Math.round(it.fat_g || 0)})`
  );

  const lines = ["บันทึกแล้ว 🍽️", ...itemLines, "", statusLine(user, totals)];
  if (result.note) lines.splice(1, 0, `(${result.note})`);
  return lineReply(env, event.replyToken, lines.join("\n"));
}

function statusLine(user, totals) {
  const kcalToday = Math.round(totals.kcal || 0);
  if (!user.target_kcal) {
    return `วันนี้ ${user.display_name} กินไป ${fmtNum(kcalToday)} kcal\n(พิมพ์ "ตั้งเป้า" เพื่อให้ผมช่วยดูว่าควรกินวันละเท่าไหร่)`;
  }
  const diff = user.target_kcal - kcalToday;
  const lines = [`วันนี้ ${user.display_name}: ${fmtNum(kcalToday)} / ${fmtNum(user.target_kcal)} kcal`];
  lines.push(diff >= 0 ? `เหลืออีก ${fmtNum(diff)} kcal` : J.pick(J.OVER_TARGET)(fmtNum(-diff)));

  const pt = proteinTarget(user);
  if (pt) {
    const p = Math.round(totals.protein_g || 0);
    lines.push(p >= pt
      ? `โปรตีน ${p}/${pt} g — ${J.pick(J.PROTEIN_DONE)}`
      : `โปรตีน ${p}/${pt} g — ขาดอีก ${pt - p} g`);
  }
  return lines.join("\n");
}

// เป้าโปรตีน/วัน: ใช้ค่าที่ตั้งเอง หรือคำนวณจากน้ำหนัก × อัตราของเป้าหมาย (ดูตาราง GOALS)
function proteinTarget(user) {
  if (user.target_protein_g) return user.target_protein_g;
  if (!user.weight_kg || !user.target_kcal) return null;
  const perKg = GOALS[user.goal_type]?.proteinPerKg ?? 1.4;
  return Math.round((user.weight_kg * perKg) / 5) * 5;
}

async function deleteLastMeal(env, event, user) {
  const last = await env.DB.prepare(
    "SELECT id, name, kcal FROM meals WHERE line_user_id = ? AND eaten_date = ? ORDER BY id DESC LIMIT 1"
  ).bind(user.line_user_id, bkkToday()).first();
  if (!last) {
    return lineReply(env, event.replyToken, `วันนี้ ${user.display_name} ยังไม่มีรายการให้ลบครับ`);
  }
  await env.DB.prepare("DELETE FROM meals WHERE id = ?").bind(last.id).run();
  const totals = await getDayTotals(env, user.line_user_id, bkkToday());
  return lineReply(env, event.replyToken,
    `ลบ "${last.name}" (${fmtNum(last.kcal)} kcal) แล้วครับ 🗑️\n${statusLine(user, totals)}`);
}

async function clearToday(env, event, user) {
  const today = bkkToday();
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(kcal),0) AS kcal FROM meals WHERE line_user_id = ? AND eaten_date = ?"
  ).bind(user.line_user_id, today).first();
  if (!row.n) {
    return lineReply(env, event.replyToken, `วันนี้ ${user.display_name} ยังไม่มีรายการอยู่แล้วครับ เริ่มบันทึกได้เลย`);
  }
  await env.DB.prepare("DELETE FROM meals WHERE line_user_id = ? AND eaten_date = ?")
    .bind(user.line_user_id, today).run();
  return lineReply(env, event.replyToken,
    `ล้างรายการวันนี้ของ ${user.display_name} แล้วครับ 🧹\n(ลบไป ${row.n} รายการ รวม ${fmtNum(row.kcal)} kcal)\nเริ่มนับใหม่ได้เลย`);
}

async function logWeight(env, event, user, weight) {
  if (!weight || weight < 25 || weight > 300) {
    return lineReply(env, event.replyToken, "น้ำหนักดูแปลก ๆ ครับ ลองพิมพ์เช่น \"น้ำหนัก 62.5\"");
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO weights (line_user_id, weight_kg, logged_date) VALUES (?, ?, ?)"
    ).bind(user.line_user_id, weight, bkkToday()),
    env.DB.prepare("UPDATE users SET weight_kg = ? WHERE line_user_id = ?").bind(weight, user.line_user_id),
  ]);

  const prev = await env.DB.prepare(
    "SELECT weight_kg, logged_date FROM weights WHERE line_user_id = ? AND logged_date < ? ORDER BY logged_date DESC LIMIT 1"
  ).bind(user.line_user_id, bkkToday()).first();

  let trend = "";
  if (prev) {
    const d = round1(weight - prev.weight_kg);
    trend = d === 0 ? "\nเท่าเดิมจากครั้งก่อน" : `\n${d > 0 ? "+" : ""}${d} กก. จากครั้งก่อน (${prev.logged_date})`;
  }
  return lineReply(env, event.replyToken, `บันทึกน้ำหนัก ${user.display_name}: ${weight} กก. ⚖️${trend}`);
}

// ---------------------------------------------------------------- summaries

async function replyTodaySummary(env, event) {
  const users = await getAllUsers(env);
  if (!users.length) return lineReply(env, event.replyToken, "ยังไม่มีใครบันทึกอะไรเลยครับ");

  const today = bkkToday();
  const blocks = [];
  for (const u of users) {
    const meals = (await env.DB.prepare(
      "SELECT name, kcal FROM meals WHERE line_user_id = ? AND eaten_date = ? ORDER BY id"
    ).bind(u.line_user_id, today).all()).results;
    const totals = await getDayTotals(env, u.line_user_id, today);
    const mealLines = meals.length
      ? meals.map((m) => `  • ${m.name} — ${fmtNum(m.kcal)}`).join("\n")
      : "  (ยังไม่มีรายการ)";
    blocks.push(`${statusLine(u, totals)}\nคาร์บ ${Math.round(totals.carb_g)}g / ไขมัน ${Math.round(totals.fat_g)}g\n${mealLines}`);
  }
  return lineReply(env, event.replyToken, `สรุปวันนี้ 📊 (${today})\n\n${blocks.join("\n\n")}`);
}

async function replyWeekSummary(env, event) {
  const users = await getAllUsers(env);
  if (!users.length) return lineReply(env, event.replyToken, "ยังไม่มีข้อมูลครับ");

  const days = lastNDates(7);
  const blocks = [];
  for (const u of users) {
    const rows = (await env.DB.prepare(
      `SELECT eaten_date, SUM(kcal) AS kcal, SUM(protein_g) AS protein_g FROM meals
       WHERE line_user_id = ? AND eaten_date >= ? GROUP BY eaten_date`
    ).bind(u.line_user_id, days[0]).all()).results;
    const byDate = Object.fromEntries(rows.map((r) => [r.eaten_date, r]));
    const lines = days.map((d) => {
      const k = byDate[d]?.kcal || 0;
      const mark = !u.target_kcal || !k ? "" : k <= u.target_kcal ? " ✅" : " ⚠️";
      return `  ${thaiDow(d)} ${d.slice(8)}/${d.slice(5, 7)}: ${fmtNum(k)}${mark}`;
    });
    const total = days.reduce((s, d) => s + (byDate[d]?.kcal || 0), 0);
    const totalP = days.reduce((s, d) => s + (byDate[d]?.protein_g || 0), 0);
    const pt = proteinTarget(u);
    blocks.push(
      `${u.display_name}${u.target_kcal ? ` (เป้า ${fmtNum(u.target_kcal)})` : ""}\n${lines.join("\n")}` +
      `\n  เฉลี่ย ${fmtNum(total / 7)} kcal · โปรตีน ${Math.round(totalP / 7)} g/วัน${pt ? ` (เป้า ${pt})` : ""}`
    );
  }
  return lineReply(env, event.replyToken, `7 วันล่าสุด 📅\n\n${blocks.join("\n\n")}\n\nดูกราฟเต็ม ๆ ที่หน้าเว็บได้นะครับ 📈`);
}

// push สรุปแคลอรี่เข้าแชท — ปิดอยู่ (ไม่มี cron 14:00 UTC ใน wrangler.toml)
// เปิดใหม่ได้โดยเพิ่ม "0 14 * * *" กลับเข้า crons
async function pushNightlySummary(env) {
  const targets = (await env.DB.prepare(
    "SELECT id FROM chat_targets WHERE type IN ('group','room') AND COALESCE(mode,'calorie') = 'calorie'"
  ).all()).results;
  const users = await getAllUsers(env);
  if (!targets.length || !users.length) return;

  const today = bkkToday();
  const lines = ["สรุปประจำวัน 🌙 (" + today + ")", ""];
  for (const u of users) {
    const totals = await getDayTotals(env, u.line_user_id, today);
    lines.push(statusLine(u, totals));
    lines.push("");
  }
  lines.push("ยังกินต่อได้อีกนิดหน่อยก่อนนอนนะครับ 😄");

  for (const t of targets) {
    await linePush(env, t.id, lines.join("\n").trim()).catch((e) => console.error("push fail", e.message));
  }
}

// ---------------------------------------------------------------- Gemini

function quotaText() {
  return [
    "โควตา AI ประเมินแคลของวันนี้หมดแล้วครับ 😅",
    "พรุ่งนี้เริ่มนับใหม่อัตโนมัติ",
    "",
    "ระหว่างนี้ยังใช้คำสั่งอื่นได้ปกติ (สรุป / สัปดาห์ / น้ำหนัก / เป้าหมาย)",
  ].join("\n");
}

function foodPromptForText(text) {
  return `คุณเป็นนักโภชนาการผู้เชี่ยวชาญอาหารไทย ผู้ใช้พิมพ์ข้อความในแชท: "${text}"

ถ้าข้อความนี้เป็นการบอกว่ากิน/ดื่มอะไร ให้ประเมินแคลอรี่และสารอาหาร (protein_g, carb_g, fat_g) ของทุกรายการ โดยใช้ขนาดเสิร์ฟไทยทั่วไปถ้าไม่ระบุปริมาณ ถ้าระบุจำนวน (เช่น 2 จาน, 2 ฟอง) ให้คูณตามจำนวน
${NUTRITION_HINTS}
ถ้าเป็นแค่บทสนทนาทั่วไป คำถาม หรือไม่เกี่ยวกับการกินอาหาร ให้ is_food = false`;
}

function foodPromptForImage() {
  return `คุณเป็นนักโภชนาการผู้เชี่ยวชาญอาหารไทย ดูรูปนี้แล้วประเมินว่าเป็นอาหาร/เครื่องดื่มอะไร ปริมาณเท่าไหร่ และประเมินแคลอรี่กับสารอาหาร (protein_g, carb_g, fat_g) ของแต่ละรายการที่เห็น
${NUTRITION_HINTS}
ถ้าไม่แน่ใจชนิดอาหาร ให้เดาที่ใกล้เคียงที่สุดและบอกไว้ใน note ถ้ารูปไม่ใช่อาหารเลย ให้ is_food = false`;
}

// กันตัวเลขเพี้ยน: ถ้า kcal ขัดกับสูตร 4-4-9 เกิน 35% ให้เชื่อฝั่ง macro แทน
function reconcileItem(it) {
  const p = +it.protein_g || 0, c = +it.carb_g || 0, f = +it.fat_g || 0;
  const macroKcal = 4 * p + 4 * c + 9 * f;
  if (macroKcal > 40 && it.kcal > 0) {
    const ratio = it.kcal / macroKcal;
    if (ratio > 1.35 || ratio < 0.65) it.kcal = Math.round(macroKcal);
  }
  return it;
}

const FOOD_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_food: { type: "BOOLEAN" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "ชื่ออาหารภาษาไทย รวมปริมาณ เช่น ข้าวมันไก่ 1 จาน" },
          kcal: { type: "NUMBER" },
          protein_g: { type: "NUMBER" },
          carb_g: { type: "NUMBER" },
          fat_g: { type: "NUMBER" },
        },
        required: ["name", "kcal"],
      },
    },
    note: { type: "STRING", description: "หมายเหตุสั้น ๆ ถ้ามีความไม่แน่นอน" },
  },
  required: ["is_food"],
};

// คืนค่า: ผลลัพธ์ | { __quota: true } เมื่อโควตาหมดทุกรุ่น | null เมื่อพังด้วยเหตุอื่น
async function geminiEstimate(env, parts) {
  return geminiJson(env, parts, FOOD_SCHEMA);
}

async function geminiJson(env, parts, schema) {
  const apiKey = sec(env, "GEMINI_API_KEY");
  if (!apiKey) {
    console.error("GEMINI_API_KEY not set");
    return null;
  }
  // free tier จำกัดโควตาต่อรุ่นต่อวัน — รุ่นหลักเต็มก็สลับไปรุ่นสำรองอัตโนมัติ
  const models = [
    sec(env, "GEMINI_MODEL") || "gemini-3.5-flash-lite",
    sec(env, "GEMINI_FALLBACK_MODEL") || "gemini-2.5-flash",
  ];
  let quotaHit = false;

  for (const model of models) {
    await countUsage(env, "gemini", model);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            response_mime_type: "application/json",
            response_schema: schema,
            temperature: 0.2,
          },
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        console.error("gemini empty candidate", model, JSON.stringify(data).slice(0, 300));
        continue;
      }
      try {
        const result = JSON.parse(text);
        if (schema === FOOD_SCHEMA && Array.isArray(result.items)) {
          result.items = result.items.map(reconcileItem);
        }
        return result;
      } catch {
        console.error("gemini bad json", model, text.slice(0, 200));
        continue;
      }
    }

    console.error("gemini error", model, res.status, (await res.text()).slice(0, 300));
    if (res.status === 429) { quotaHit = true; continue; }  // โควตาเต็ม → ลองรุ่นถัดไป
    if (res.status >= 500) continue;                        // ฝั่ง Google ล่ม → ลองรุ่นถัดไป
    break;                                                  // 400/403 = ตั้งค่าผิด ลองรุ่นอื่นก็ไม่ช่วย
  }
  return quotaHit ? { __quota: true } : null;
}

// ---------------------------------------------------------------- LINE helpers

async function lineReply(env, replyToken, text, mention) {
  const message = { type: "text", text: text.slice(0, 4900) };
  if (mention?.mentionees?.length) message.mention = mention;
  const res = await fetch(`${LINE_API}/message/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sec(env, "LINE_CHANNEL_ACCESS_TOKEN")}`,
    },
    body: JSON.stringify({ replyToken, messages: [message] }),
  });
  if (!res.ok) {
    console.error("reply fail", res.status, await res.text());
    return null;
  }
  return res.json().catch(() => null); // { sentMessages: [{ id, quoteToken }] }
}

async function linePush(env, to, text, mention) {
  await countUsage(env, "push", "line");
  const message = { type: "text", text: text.slice(0, 4900) };
  if (mention?.mentionees?.length) message.mention = mention;
  const res = await fetch(`${LINE_API}/message/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sec(env, "LINE_CHANNEL_ACCESS_TOKEN")}`,
    },
    body: JSON.stringify({ to, messages: [message] }),
  });
  if (!res.ok) throw new Error(`push ${res.status}: ${await res.text()}`);
}

async function fetchDisplayName(env, source) {
  const userId = source.userId;
  let url = `${LINE_API}/profile/${userId}`;
  if (source.type === "group") url = `${LINE_API}/group/${source.groupId}/member/${userId}`;
  if (source.type === "room") url = `${LINE_API}/room/${source.roomId}/member/${userId}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${sec(env, "LINE_CHANNEL_ACCESS_TOKEN")}` },
    });
    if (res.ok) return (await res.json()).displayName;
  } catch {}
  return "เพื่อนใหม่";
}

// ---------------------------------------------------------------- data helpers

async function getOrCreateUser(env, userId, source) {
  let user = await env.DB.prepare("SELECT * FROM users WHERE line_user_id = ?").bind(userId).first();
  if (!user) {
    const name = await fetchDisplayName(env, source);
    await env.DB.prepare(
      "INSERT INTO users (line_user_id, display_name) VALUES (?, ?)"
    ).bind(userId, name).run();
    user = await env.DB.prepare("SELECT * FROM users WHERE line_user_id = ?").bind(userId).first();
  }
  return user;
}

async function getAllUsers(env) {
  return (await env.DB.prepare("SELECT * FROM users ORDER BY created_at").all()).results;
}

async function getDayTotals(env, userId, date) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(kcal),0) AS kcal, COALESCE(SUM(protein_g),0) AS protein_g,
            COALESCE(SUM(carb_g),0) AS carb_g, COALESCE(SUM(fat_g),0) AS fat_g
     FROM meals WHERE line_user_id = ? AND eaten_date = ?`
  ).bind(userId, date).first();
  return row;
}

// ---------------------------------------------------------------- dashboard API

async function handleApi(url, request, env) {
  // กันคนนอกเปิดดู: ถ้าตั้ง DASHBOARD_KEY ไว้ ต้องแนบ ?key= ให้ตรง
  const dashKey = sec(env, "DASHBOARD_KEY");
  if (dashKey) {
    const key = (url.searchParams.get("key") || request.headers.get("x-dashboard-key") || "").trim();
    if (key !== dashKey) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
  }

  // หน้าตรวจสุขภาพระบบ: เช็คว่า secret ครบไหม + ยิงทดสอบ Gemini กับ LINE จริง
  if (url.pathname === "/api/health") {
    const report = {};
    for (const name of ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "GEMINI_API_KEY", "DASHBOARD_KEY"]) {
      const raw = env[name] || "";
      report[name] = { set: raw.length > 0, length: raw.length, stray_whitespace: raw !== raw.trim() };
    }
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${sec(env, "GEMINI_MODEL") || "gemini-3.5-flash-lite"}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": sec(env, "GEMINI_API_KEY") },
          body: JSON.stringify({ contents: [{ parts: [{ text: "ตอบสั้น ๆ คำเดียวว่า: โอเค" }] }] }),
        }
      );
      report.gemini_status = r.status;
      if (!r.ok) report.gemini_error = (await r.text()).slice(0, 300);
    } catch (e) {
      report.gemini_status = "fetch_error: " + e.message;
    }
    try {
      const r = await fetch(`${LINE_API}/info`, {
        headers: { Authorization: `Bearer ${sec(env, "LINE_CHANNEL_ACCESS_TOKEN")}` },
      });
      report.line_status = r.status;
      if (!r.ok) report.line_error = (await r.text()).slice(0, 300);
    } catch (e) {
      report.line_status = "fetch_error: " + e.message;
    }
    try {
      report.usage_7d = (await env.DB.prepare(
        `SELECT day, kind, label, n FROM api_usage WHERE day >= ? ORDER BY day DESC, kind`
      ).bind(lastNDates(7)[0]).all()).results;
    } catch (e) {
      report.usage_7d = "error: " + e.message;
    }
    return jsonResponse(report);
  }

  if (url.pathname === "/api/overview") {
    const days = Math.min(parseInt(url.searchParams.get("days") || "14", 10) || 14, 90);
    const dates = lastNDates(days);
    const today = bkkToday();
    const users = await getAllUsers(env);

    const out = [];
    for (const u of users) {
      const dailyRows = (await env.DB.prepare(
        `SELECT eaten_date, SUM(kcal) AS kcal FROM meals
         WHERE line_user_id = ? AND eaten_date >= ? GROUP BY eaten_date`
      ).bind(u.line_user_id, dates[0]).all()).results;
      const byDate = Object.fromEntries(dailyRows.map((r) => [r.eaten_date, r.kcal]));

      const mealsToday = (await env.DB.prepare(
        `SELECT name, kcal, protein_g, carb_g, fat_g, source FROM meals
         WHERE line_user_id = ? AND eaten_date = ? ORDER BY id`
      ).bind(u.line_user_id, today).all()).results;

      const weights = (await env.DB.prepare(
        `SELECT logged_date AS date, weight_kg FROM weights
         WHERE line_user_id = ? ORDER BY logged_date DESC LIMIT 60`
      ).bind(u.line_user_id).all()).results.reverse();

      out.push({
        id: u.line_user_id,
        name: u.display_name,
        target_kcal: u.target_kcal,
        target_protein_g: proteinTarget(u),
        goal_type: u.goal_type,
        today: await getDayTotals(env, u.line_user_id, today),
        meals_today: mealsToday,
        daily: dates.map((d) => ({ date: d, kcal: byDate[d] || 0 })),
        weights,
      });
    }
    return jsonResponse({ today, users: out });
  }

  return jsonResponse({ error: "not found" }, 404);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ---------------------------------------------------------------- utils

async function countUsage(env, kind, label = "") {
  try {
    await env.DB.prepare(
      `INSERT INTO api_usage (day, kind, label, n) VALUES (?, ?, ?, 1)
       ON CONFLICT(day, kind, label) DO UPDATE SET n = n + 1`
    ).bind(bkkToday(), kind, label).run();
  } catch (e) {
    console.error("countUsage failed", e.message);
  }
}

async function fetchLineImage(env, messageId) {
  const res = await fetch(`${LINE_DATA_API}/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${sec(env, "LINE_CHANNEL_ACCESS_TOKEN")}` },
  });
  if (!res.ok) throw new Error(`LINE content fetch failed: ${res.status}`);
  return {
    mime: res.headers.get("content-type") || "image/jpeg",
    b64: bytesToBase64(new Uint8Array(await res.arrayBuffer())),
  };
}

// เวลาจาก created_at (UTC ในรูป 'YYYY-MM-DD HH:MM:SS') → HH:MM เวลาไทย
function bkkTimeOf(sqlUtc) {
  const d = new Date(String(sqlUtc).replace(" ", "T") + "Z");
  if (isNaN(d)) return "-";
  const bkk = new Date(d.getTime() + 7 * 3600 * 1000);
  return `${String(bkk.getUTCHours()).padStart(2, "0")}:${String(bkk.getUTCMinutes()).padStart(2, "0")}`;
}

// เหลืออีกกี่ชั่วโมงก่อนหมดวัน (เวลาไทย) — อย่างน้อย 1 เพื่อไม่ให้ข้อความอ่านแล้วแปลก
function hoursLeftToday() {
  const bkk = new Date(Date.now() + 7 * 3600 * 1000);
  const minsLeft = 24 * 60 - (bkk.getUTCHours() * 60 + bkk.getUTCMinutes());
  return Math.max(1, Math.round(minsLeft / 60));
}

// วันที่เวลาไทย ถอย/เดินหน้า n วัน (0 = วันนี้)
function bkkDateOffset(n) {
  return new Date(Date.now() + 7 * 3600 * 1000 + n * 86400 * 1000).toISOString().slice(0, 10);
}

const TH_MONTHS_SHORT = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
function thaiDateText(d) {
  const [, m, day] = d.split("-").map(Number);
  return `${day} ${TH_MONTHS_SHORT[m - 1]}`;
}

// อ่านค่า secret แบบกันอักขระท้ายบรรทัดติดมา (เช่นตั้งผ่าน echo บน Windows จะแถม \r)
function sec(env, name) {
  return (env[name] || "").trim();
}

// เวลาไทย UTC+7 (ไม่มี DST)
function bkkToday() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function lastNDates(n) {
  const out = [];
  const now = Date.now() + 7 * 3600 * 1000;
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(now - i * 86400 * 1000).toISOString().slice(0, 10));
  }
  return out;
}

function thaiDow(dateStr) {
  return ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"][new Date(dateStr + "T00:00:00Z").getUTCDay()];
}

function fmtNum(n) {
  return Math.round(n).toLocaleString("en-US");
}

function round1(x) {
  return x == null ? null : Math.round(x * 10) / 10;
}

function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ================================================================ โหมดชาเลนจ์ออกกำลังกาย
// กลุ่มที่ตั้ง mode='challenge' จะไม่นับแคล แต่คอยเช็คว่าใครออกกำลังกายวันนี้แล้วบ้าง

const WORKOUT_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_workout: { type: "BOOLEAN" },
    activity: { type: "STRING", description: "ประเภทกิจกรรมภาษาไทย เช่น เวทเทรนนิ่ง, วิ่ง, Body Pump, โยคะ" },
    duration_min: { type: "NUMBER", description: "ระยะเวลาเป็นนาที — ใส่เฉพาะที่ผู้ใช้บอกเองหรืออ่านได้จากหน้าจอในรูป ห้ามเดา" },
    kcal: { type: "NUMBER", description: "แคลอรี่ที่เผาผลาญ — ใส่เฉพาะที่อ่านได้จากหน้าจอในรูปหรือผู้ใช้บอกเอง (ใช้ active calories ถ้ามีทั้งสองค่า) ห้ามเดา" },
    has_screen_data: { type: "BOOLEAN", description: "true เมื่อรูปเป็นหน้าจอสรุปผลที่อ่านตัวเลขได้จริง (นาฬิกา/แอป/หน้าจอเครื่องออกกำลังกาย) — รูปยิม รองเท้า หรือเซลฟี่เฉย ๆ ให้ false" },
    note: { type: "STRING" },
  },
  required: ["is_workout"],
};

const WORKOUT_IMAGE_PROMPT = `ดูรูปนี้แล้วบอกว่าเป็นหลักฐานการออกกำลังกายหรือไม่

ตอบ 2 อย่าง:

1) is_workout — รูปนี้เกี่ยวกับการออกกำลังกายไหม (ยิม ลู่วิ่ง สนาม หน้าจอนาฬิกา ชุดออกกำลังกาย ฯลฯ)

2) has_screen_data — รูปนี้เป็น "หน้าจอสรุปผล" ที่อ่านตัวเลขได้จริงหรือไม่

   true เมื่อเป็นหน้าจอจากอุปกรณ์/แอปออกกำลังกาย เช่น Apple Watch, Whoop, Garmin, Polar, Fitbit,
   Coros, Suunto, Samsung Health, Zepp, Strava, Nike Run, Peloton, Hevy, Strong
   หรือหน้าจอเครื่องออกกำลังกาย (ลู่วิ่ง จักรยาน เครื่องเดินวงรี)
   **ขอแค่มีตัวเลขที่วัดผลได้อย่างน้อย 1 อย่างก็พอ ไม่จำเป็นต้องมีแคลอรี่**:
     - ระยะเวลา / duration / ช่วงเวลาเริ่ม-จบ (เช่น 0:50:00, 8:16 PM to 9:06 PM)
     - ระยะทาง · แคลอรี่ · หัวใจ (BPM) · โซนหัวใจ (Zone 1-5)
     - คะแนนความหนัก เช่น Strain, Effort, Training Load, Intensity
     - จำนวนเซ็ต/ครั้ง/น้ำหนักที่ยก
   หน้าจอกราฟหัวใจหรือหน้าสรุป strain ที่ไม่มีแคลอรี่ → **ยังนับเป็น true**

   false เฉพาะกรณี: รูปยิม รูปลู่วิ่งเปล่า ๆ รูปรองเท้า รูปวิว เซลฟี่ในชุดออกกำลังกาย
   หรือรูปที่เบลอ/เล็กจนอ่านตัวเลขไม่ออกจริง ๆ

ถ้าเห็นตัวเลขบนหน้าจอ ให้อ่านค่าจริงจากรูป (ระยะเวลาแปลงเป็นนาที, แคลอรี่เลือก active calories ถ้ามีทั้ง active และ total)
**ห้ามเดาตัวเลขเอง** ถ้าในรูปไม่มีเวลาหรือแคลอรี่ให้อ่าน ให้เว้น duration_min และ kcal ไว้ว่าง ๆ (ไม่ต้องใส่ค่า)
เมื่อ is_workout = true ต้องใส่ activity เป็นชื่อกิจกรรมภาษาไทยเสมอ ถ้าดูไม่ออกว่ากิจกรรมอะไรให้ใส่ว่า "ออกกำลังกาย"
ถ้าเป็นรูปอาหาร รูปวิว เซลฟี่ธรรมดา หรือรูปอื่นที่ไม่เกี่ยวกับการออกกำลังกาย ให้ is_workout = false`;

function workoutTextPrompt(text) {
  return `ผู้ใช้พิมพ์ข้อความในกลุ่มชาเลนจ์ออกกำลังกาย: "${text}"

ถ้าเป็นการรายงานว่าตัวเองออกกำลังกาย ให้ is_workout = true และใส่ activity เป็นชื่อกิจกรรมพร้อมปริมาณตามที่เขาพิมพ์มา (เช่น "ไดร์ฟกอล์ฟ 2 ถาด", "วิ่ง 5 กม.")

นับเป็นการรายงานทั้งหมดนี้ แม้ไม่บอกรายละเอียด:
- ระบุกิจกรรม: "วิ่ง 5 กม." "เล่นเวท 1 ชม." "โยคะ 45 นาที" "ไดร์ฟกอล์ฟ 2 ถาด" "ตีแบด 2 เกม"
- บอกว่าไปสถานที่ออกกำลังกายมา: "เข้ายิม 1 ชม." "ไปคลาสโยคะ 45 นาที" "ลงสระ 20 รอบ"
- บอกสั้น ๆ ว่าทำอะไรมา: "ว่ายน้ำมาแล้ว" "ซ้อมเสร็จแล้ว" "วิ่งเสร็จ"

แต่ถ้าบอกลอย ๆ ว่า "ออกกำลังกาย" / "ออกกำลังกายมาแล้ว" โดยไม่ระบุว่าทำกิจกรรมอะไร ให้ is_workout = false

**ห้ามเดาเวลาหรือแคลอรี่เอง** ใส่ duration_min เฉพาะเมื่อเขาบอกเวลามาชัด ๆ (เช่น "45 นาที", "1 ชม.")
และใส่ kcal เฉพาะเมื่อเขาบอกตัวเลขแคลอรี่มาเอง ถ้าไม่ได้บอก ให้เว้นว่างไว้ ไม่ต้องใส่ค่า
ถ้าเป็นบทสนทนาทั่วไป ทักทาย ถามคำถาม หรือชวนคุย ให้ is_workout = false`;
}

async function geminiWorkout(env, parts) {
  return geminiJson(env, parts, WORKOUT_SCHEMA);
}

async function getChatMode(env, chatId) {
  const row = await env.DB.prepare("SELECT mode FROM chat_targets WHERE id = ?").bind(chatId).first();
  return row?.mode || "calorie";
}

async function handleChallengeText(env, event, chatId, userId, text) {
  if (/^(เข้าร่วม|สมัคร|join)$/i.test(text)) return joinChallenge(env, event, chatId, userId);
  if (/^(ออกจากชาเลนจ์|ขอออก|leave)$/i.test(text)) return leaveChallenge(env, event, chatId, userId);
  if (/^(ใครยังไม่ออก|ใครยังไม่|เช็คชื่อ|วันนี้)$/.test(text)) return replyChallengeToday(env, event, chatId);
  if (/^(เตือน|ทวง|แท็ก)$/.test(text)) return replyNudge(env, event, chatId);
  if (/^(สมาชิก|รายชื่อ|ใครอยู่บ้าง)$/.test(text)) return replyMembers(env, event, chatId);

  const mentioneesForDelete = event.message?.mention?.mentionees || [];
  const delMatch = stripMentions(text, mentioneesForDelete).match(/^(?:ลบ|ลบล่าสุด|ยกเลิก)\s*(\d+)?$/);
  if (delMatch) {
    return deleteWorkout(env, event, chatId, userId, {
      index: delMatch[1] ? parseInt(delMatch[1], 10) : null,
      quotedMessageId: event.message?.quotedMessageId || event.message?.quotedMessage?.id || null,
      mentionedIds: mentioneesForDelete.map((m) => m.userId).filter(Boolean),
    });
  }

  // คำว่า "ออกกำลังกาย" เฉย ๆ กำกวมเกินไป (เป็นคำสั่งเปิดโหมดด้วย) — ไม่นับเป็นการเช็คอิน
  // และไม่สมัครสมาชิกให้ เพื่อไม่ให้คนพิมพ์ผ่าน ๆ ถูกดึงเข้าชาเลนจ์โดยไม่ตั้งใจ
  if (isVagueWorkoutWord(text)) {
    return lineReply(env, event.replyToken,
      "บอกด้วยว่าทำอะไรมาครับ 💪 คำว่า \"ออกกำลังกาย\" เฉย ๆ ยังเช็คอินไม่ได้\n\n" +
      "ส่งรูปหน้าจอนาฬิกา/แอป หรือพิมพ์ให้มีจำนวน เช่น\n" +
      "  \"วิ่ง 5 กม.\"  \"เล่นเวท 1 ชม.\"  \"วิดพื้น 50 ครั้ง\"\n\n" +
      "ยังไม่ได้สมัคร? พิมพ์ \"เข้าร่วม\"");
  }
  if (/^(อันดับ|ตาราง|สรุป|leaderboard)$/i.test(text)) return replyLeaderboard(env, event, chatId);
  if (/^(คำสั่ง|ช่วยเหลือ|help)$/i.test(text)) return lineReply(env, event.replyToken, challengeHelpText());
  if (/^โหมดแคล(อรี่)?$/.test(text)) {
    await env.DB.prepare("UPDATE chat_targets SET mode = 'calorie' WHERE id = ?").bind(chatId).run();
    return lineReply(env, event.replyToken, "สลับกลับเป็นโหมดนับแคลอรี่แล้วครับ 🍚");
  }
  // บอกว่าเป็นของเมื่อวาน — ถ้าไม่มีรายละเอียดอื่น ถือว่าขอย้ายรายการล่าสุดย้อนหลัง
  // ถ้ามีรายละเอียดด้วย (เช่น "เมื่อวานวิ่ง 5 กม.") ให้บันทึกใหม่ลงวันเมื่อวานเลย
  let dateOverride = null;
  const mentionees = event.message?.mention?.mentionees || [];
  if (isBackdateOnly(stripMentions(text, mentionees))) {
    return moveLastWorkoutBack(env, event, chatId, userId, {
      quotedMessageId: event.message?.quotedMessageId || event.message?.quotedMessage?.id || null,
      mentionedIds: mentionees.map((m) => m.userId).filter(Boolean),
    });
  }
  if (YESTERDAY_HINT.test(text) && looksLikeWorkout(text.replace(YESTERDAY_HINT, " "))) {
    dateOverride = bkkDateOffset(-1);
  }

  // กลุ่มใหญ่คุยกันเยอะ — กรองด้วยคำก่อน ไม่งั้นเปลืองโควตา Gemini และตอบมั่ว
  if (text.length > 120 || !looksLikeWorkout(text)) return;

  const result = await geminiWorkout(env, [{ text: workoutTextPrompt(text) }]);
  if (result?.__quota) return lineReply(env, event.replyToken, quotaText());
  if (!result?.is_workout) return; // คุยเล่นทั่วไป → เงียบไว้

  // ใช้มาตรฐานเดียวกับรูป: ต้องมีตัวเลขที่วัดได้ ไม่งั้นบอกอะไรก็เช็คอินได้หมด
  // ("วิ่ง 5 กม." ผ่าน · "วิดพื้น" ไม่ผ่าน) — นับรวมกรณีบอกเป็นคำ เช่น "ครึ่งชั่วโมง" ที่ AI ถอดเป็นนาทีให้
  const hasAmount = /\d/.test(text) || result.duration_min > 0 || result.kcal > 0;
  if (!hasAmount) {
    const name = await fetchDisplayName(env, event.source);
    return lineReply(env, event.replyToken,
      J.pick(J.NEED_DETAIL)(name, String(result.activity || "ออกกำลังกาย").slice(0, 30)));
  }
  return saveWorkoutAndReply(env, event, chatId, userId, result, "text", dateOverride);
}

// คำที่บอกว่ารายการนี้เป็นของเมื่อวาน (ส่งรูปย้อนหลัง / โพสต์ตอนเช้าแต่เล่นเมื่อคืน)
const YESTERDAY_HINT = /เมื่อวาน(นี้)?|เมื่อคืน|วานนี้/;
// คำเติมที่ตัดทิ้งได้ ใช้ดูว่าข้อความนั้น "พูดถึงเมื่อวานเฉย ๆ" หรือมีเนื้อหาอื่นด้วย
const FILLER = /อันนี้|อันนั้น|อันนี่|รูปนี้|ภาพนี้|คือ|นะ|น่ะ|ครับ|ค่ะ|คะ|จ้า|จ้ะ|รูป|ภาพ|ของ|เป็น|นี่|นั่น|ที่|ส่ง|โพสต์|แก้|จริง\s*ๆ|เมื่อ|วาน|คืน|[\s.!?]/g;

// ข้อความที่มีแต่คำว่า "ออกกำลัง(กาย)" ลอย ๆ ไม่ได้บอกว่าทำอะไร — ไม่นับเป็นเช็คอิน
// (เป็นคำสั่งเปิดโหมดด้วย และไม่มีข้อมูลพอจะบันทึกเป็นสถิติ)
function isVagueWorkoutWord(text) {
  if (text.length > 30) return false;
  const core = text.replace(/มาแล้ว|เสร็จแล้ว|เรียบร้อย|แล้ว|เสร็จ|มา|ครับ|ค่ะ|คะ|นะ|น่ะ|จ้า|จ้ะ|[\s.!?]/g, "");
  return /^(ออกกำลังกาย|ออกกำลัง|โหมดชาเลนจ์)$/.test(core);
}

// ตัดช่วงที่เป็นแท็ก @ชื่อ ออกจากข้อความ (ไล่จากท้ายมาหน้าเพื่อไม่ให้ index เพี้ยน)
function stripMentions(text, mentionees) {
  if (!mentionees?.length) return text;
  let out = text;
  [...mentionees].sort((a, b) => b.index - a.index).forEach((m) => {
    out = out.slice(0, m.index) + " " + out.slice(m.index + m.length);
  });
  return out.trim();
}

// ข้อความแบบ "อันนี้คือเมื่อคืน" = ขอย้ายรายการล่าสุด
// ส่วน "กินข้าวเมื่อวานอร่อยมาก" = คุยเล่น ต้องไม่ไปยุ่งกับข้อมูลใคร
function isBackdateOnly(text) {
  if (text.length > 40 || !YESTERDAY_HINT.test(text)) return false;
  return text.replace(YESTERDAY_HINT, " ").replace(FILLER, "").trim() === "";
}

// คำที่บ่งชี้ว่าอาจเป็นการรายงานออกกำลังกาย (กรองหยาบ ๆ ก่อนถาม AI)
const WORKOUT_HINTS = /วิ่ง|เดิน|เวท|ยกน้ำหนัก|ยิม|ฟิตเนส|โยคะ|พิลาทิส|ว่ายน้ำ|ปั่น|จักรยาน|คาร์ดิโอ|ซ้อม|ออกกำลัง|เต้น|กระโดดเชือก|ชกมวย|มวย|แบด|ฟุตบอล|บาส|เทนนิส|กอล์ฟ|ตีแบด|คลาส|บอดี้|สควอท|วิดพื้น|ซิทอัพ|แพลงก์|ลู่|ลาน|กม\.?|ก\.ม\.|กิโล|นาที|ชม\.?|ชั่วโมง|รอบ|เซ็ต|body\s*pump|workout|gym|run|walk|yoga|pilates|swim|bike|cardio|hiit|crossfit|weight|training|zumba|muay/i;

function looksLikeWorkout(text) {
  return WORKOUT_HINTS.test(text);
}

async function handleChallengeImage(env, event, chatId, userId) {
  const b64AndMime = await fetchLineImage(env, event.message.id);
  const result = await geminiWorkout(env, [
    { inline_data: { mime_type: b64AndMime.mime, data: b64AndMime.b64 } },
    { text: WORKOUT_IMAGE_PROMPT },
  ]);
  if (result?.__quota) return lineReply(env, event.replyToken, quotaText());
  if (!result?.is_workout) return; // รูปอื่นในกลุ่ม → เงียบไว้ ไม่รบกวน

  // รูปบรรยากาศ (ยิม รองเท้า เซลฟี่) ไม่นับเป็นหลักฐาน — ต้องมีหน้าจอที่อ่านตัวเลขได้
  if (!result.has_screen_data) {
    const name = await fetchDisplayName(env, event.source);
    return lineReply(env, event.replyToken, J.pick(J.NEED_PROOF)(name));
  }
  return saveWorkoutAndReply(env, event, chatId, userId, result, "image");
}

async function saveWorkoutAndReply(env, event, chatId, userId, result, source, dateOverride = null) {
  const day = dateOverride || bkkToday();
  const name = await ensureMember(env, chatId, userId, event.source);
  const already = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM workouts WHERE chat_id = ? AND line_user_id = ? AND logged_date = ?"
  ).bind(chatId, userId, day).first();

  const inserted = await env.DB.prepare(
    `INSERT INTO workouts (chat_id, line_user_id, activity, duration_min, kcal, source, message_id, logged_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(
    chatId, userId, String(result.activity || "ออกกำลังกาย").slice(0, 60),
    result.duration_min ? Math.round(result.duration_min) : null,
    result.kcal ? Math.round(result.kcal) : null,
    source, event.message?.id || null, day
  ).first();

  // ผูก id ข้อความที่บอทตอบไว้ด้วย จะได้ reply ที่ข้อความบอทแล้วแก้วันที่ได้เหมือนกัน
  const rememberReplyId = async (sent) => {
    const replyId = sent?.sentMessages?.[0]?.id;
    if (replyId && inserted?.id) {
      await env.DB.prepare("UPDATE workouts SET reply_message_id = ? WHERE id = ?")
        .bind(replyId, inserted.id).run().catch(() => {});
    }
  };

  const detail = [
    result.duration_min ? `${Math.round(result.duration_min)} นาที` : null,
    result.kcal ? `${fmtNum(result.kcal)} kcal` : null,
  ].filter(Boolean).join(" · ");

  if (dateOverride) {
    return lineReply(env, event.replyToken, [
      `บันทึกเป็นของเมื่อวาน (${thaiDateText(day)}) ให้แล้วครับ 📅`,
      `${result.activity || "ออกกำลังกาย"}${detail ? " — " + detail : ""}`,
      "",
      "ของวันนี้ยังไม่นับนะ ออกแล้วส่งมาได้เลย 💪",
    ].join("\n")).then(rememberReplyId);
  }

  const streak = await getStreak(env, chatId, userId);
  const lines = [
    already.n > 0
      ? J.pick(J.CHECKIN_AGAIN)(name, already.n + 1)
      : J.pick(J.CHECKIN)(name),
    `${result.activity || "ออกกำลังกาย"}${detail ? " — " + detail : ""}`,
  ];
  if (already.n === 0 && streak > 1) {
    lines.push(J.pick(streak >= 7 ? J.STREAK_BIG : J.STREAK)(streak));
  }

  const { done, missing } = await getTodayStatus(env, chatId);
  if (missing.length === 0 && done.length > 0) lines.push("", J.pick(J.ALL_DONE));
  else if (missing.length > 0) lines.push("", `เหลืออีก ${missing.length} คนที่ยังไม่ออกวันนี้`);

  return lineReply(env, event.replyToken, lines.join("\n")).then(rememberReplyId);
}

// ลบรายการเช็คอิน — เลือกเป้าหมายได้ 3 ทางเหมือนคำสั่งย้ายวัน
//   reply ที่รูป/ข้อความบอท → รายการนั้น · แท็กชื่อ → ของคนนั้น · ไม่ระบุ → ของตัวเอง
// ถ้าวันนั้นมีหลายรายการและไม่ได้ชี้เจาะจง จะโชว์รายการให้เลือกหมายเลขก่อน
async function deleteWorkout(env, event, chatId, senderId, opts = {}) {
  const today = bkkToday();
  const { index = null, quotedMessageId = null, mentionedIds = [] } = opts;
  const withName = `SELECT w.id, w.activity, w.duration_min, w.kcal, w.created_at, m.display_name
     FROM workouts w LEFT JOIN challenge_members m
       ON m.chat_id = w.chat_id AND m.line_user_id = w.line_user_id`;

  if (quotedMessageId) {
    const row = await env.DB.prepare(
      `${withName} WHERE w.chat_id = ? AND ? IN (w.message_id, w.reply_message_id) LIMIT 1`
    ).bind(chatId, quotedMessageId).first();
    if (row) return removeWorkoutRow(env, event, chatId, row);
  }

  const targetId = mentionedIds.find((u) => u && u !== senderId) || senderId;
  const rows = (await env.DB.prepare(
    `${withName} WHERE w.chat_id = ? AND w.line_user_id = ? AND w.logged_date = ? ORDER BY w.id`
  ).bind(chatId, targetId, today).all()).results;

  if (!rows.length) {
    return lineReply(env, event.replyToken,
      targetId === senderId
        ? "วันนี้คุณยังไม่มีรายการให้ลบครับ 🤔"
        : "วันนี้คนที่แท็กยังไม่มีรายการให้ลบครับ 🤔");
  }
  if (index) {
    const row = rows[index - 1];
    if (!row) return lineReply(env, event.replyToken, `มีแค่ ${rows.length} รายการครับ ระบุหมายเลข 1-${rows.length}`);
    return removeWorkoutRow(env, event, chatId, row);
  }
  if (rows.length === 1) return removeWorkoutRow(env, event, chatId, rows[0]);

  const who = rows[0].display_name || "คนนี้";
  const list = rows.map((r, i) => {
    const detail = [r.duration_min ? `${r.duration_min} นาที` : null, r.kcal ? `${fmtNum(r.kcal)} kcal` : null]
      .filter(Boolean).join(" · ");
    return `${i + 1}. ${r.activity}${detail ? " — " + detail : ""} (${bkkTimeOf(r.created_at)})`;
  });
  return lineReply(env, event.replyToken,
    `${who} มี ${rows.length} รายการวันนี้ ระบุหมายเลขที่จะลบด้วยครับ 🗑️\n\n${list.join("\n")}\n\n` +
    (targetId === senderId ? `พิมพ์: ลบ 1` : `พิมพ์: แท็กชื่อ แล้วตามด้วย ลบ 1`));
}

async function removeWorkoutRow(env, event, chatId, row) {
  await env.DB.prepare("DELETE FROM workouts WHERE id = ?").bind(row.id).run();
  const { done, missing } = await getTodayStatus(env, chatId);
  const who = row.display_name ? `ของ ${row.display_name} ` : "";
  return lineReply(env, event.replyToken, [
    `ลบ "${row.activity}" ${who}แล้วครับ 🗑️`,
    "",
    missing.length ? `เหลืออีก ${missing.length} คนที่ยังไม่ออกวันนี้` : "วันนี้ทุกคนเช็คอินครบแล้ว 🎉",
  ].join("\n"));
}

// ย้ายรายการเช็คอินไปเป็นของเมื่อวาน
// ถ้า reply (quote) มาที่ข้อความ/รูปไหน จะย้ายรายการของข้อความนั้น — ช่วยแก้ให้เพื่อนได้
// ถ้าไม่ได้ reply มา จะย้ายรายการล่าสุดของคนที่พิมพ์เอง
async function moveLastWorkoutBack(env, event, chatId, userId, opts = {}) {
  const today = bkkToday();
  const yesterday = bkkDateOffset(-1);
  const { quotedMessageId = null, mentionedIds = [] } = opts;

  const latestOf = (uid) => env.DB.prepare(
    `SELECT w.id, w.activity, w.logged_date, m.display_name
     FROM workouts w LEFT JOIN challenge_members m
       ON m.chat_id = w.chat_id AND m.line_user_id = w.line_user_id
     WHERE w.chat_id = ? AND w.line_user_id = ? AND w.logged_date = ?
     ORDER BY w.id DESC LIMIT 1`
  ).bind(chatId, uid, today).first();

  let target = null;

  // 1) reply (quote) มาที่รูปไหน → รายการของรูปนั้น
  if (quotedMessageId) {
    target = await env.DB.prepare(
      `SELECT w.id, w.activity, w.logged_date, m.display_name
       FROM workouts w LEFT JOIN challenge_members m
         ON m.chat_id = w.chat_id AND m.line_user_id = w.line_user_id
       WHERE w.chat_id = ? AND ? IN (w.message_id, w.reply_message_id) LIMIT 1`
    ).bind(chatId, quotedMessageId).first();
  }
  // 2) แท็กชื่อใครไว้ → รายการล่าสุดของคนแรกที่มีเช็คอินวันนี้ (ข้ามแท็กบอทเอง)
  for (const uid of mentionedIds) {
    if (target) break;
    if (uid === userId) continue;
    target = await latestOf(uid);
  }
  // 3) ไม่ได้ระบุใคร → รายการล่าสุดของคนที่พิมพ์
  if (!target) target = await latestOf(userId);

  if (!target) {
    return lineReply(env, event.replyToken,
      `ไม่เจอรายการให้ย้ายครับ 🤔\n\n` +
      `ถ้า reply ที่รูปแล้วไม่เจอ แปลว่ารูปนั้นเช็คอินไว้ก่อนที่ผมจะเริ่มจำรูปได้\n` +
      `👉 ให้แท็กชื่อเจ้าตัวแทน: พิมพ์ @ แล้วเลือกชื่อ ตามด้วยคำว่า เมื่อวาน\n\n` +
      `หรือบันทึกใหม่พร้อมรายละเอียดก็ได้ เช่น "เมื่อวานวิ่ง 5 กม."`);
  }
  if (target.logged_date === yesterday) {
    return lineReply(env, event.replyToken,
      `"${target.activity}" ของ ${target.display_name || "คนนี้"} อยู่ที่วันเมื่อวานอยู่แล้วครับ 👍`);
  }

  await env.DB.prepare("UPDATE workouts SET logged_date = ? WHERE id = ?")
    .bind(yesterday, target.id).run();

  const { done, missing } = await getTodayStatus(env, chatId);
  const who = target.display_name ? `ของ ${target.display_name} ` : "";
  return lineReply(env, event.replyToken, [
    `ย้าย "${target.activity}" ${who}ไปเป็นของเมื่อวาน (${thaiDateText(yesterday)}) แล้วครับ 📅`,
    "",
    missing.length
      ? `วันนี้เลยยังไม่นับ — เหลืออีก ${missing.length} คนที่ยังไม่ออก`
      : "วันนี้ทุกคนเช็คอินครบแล้ว 🎉",
  ].join("\n"));
}

async function ensureMember(env, chatId, userId, source) {
  const existing = await env.DB.prepare(
    "SELECT display_name FROM challenge_members WHERE chat_id = ? AND line_user_id = ?"
  ).bind(chatId, userId).first();
  if (existing) {
    await env.DB.prepare(
      "UPDATE challenge_members SET active = 1 WHERE chat_id = ? AND line_user_id = ?"
    ).bind(chatId, userId).run();
    return existing.display_name;
  }
  const name = await fetchDisplayName(env, source);
  await env.DB.prepare(
    "INSERT INTO challenge_members (chat_id, line_user_id, display_name) VALUES (?, ?, ?)"
  ).bind(chatId, userId, name).run();
  return name;
}

async function joinChallenge(env, event, chatId, userId) {
  const name = await ensureMember(env, chatId, userId, event.source);
  const total = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM challenge_members WHERE chat_id = ? AND active = 1"
  ).bind(chatId).first();
  return lineReply(env, event.replyToken,
    `${J.pick(J.JOIN)(name, total.n)}\n\nออกกำลังกายเสร็จส่งรูปมาได้เลยครับ 📸`);
}

async function leaveChallenge(env, event, chatId, userId) {
  await env.DB.prepare(
    "UPDATE challenge_members SET active = 0 WHERE chat_id = ? AND line_user_id = ?"
  ).bind(chatId, userId).run();
  return lineReply(env, event.replyToken, J.pick(J.LEAVE));
}

// รายชื่อคนที่ออก/ยังไม่ออกวันนี้
async function getTodayStatus(env, chatId) {
  const today = bkkToday();
  const rows = (await env.DB.prepare(
    `SELECT m.line_user_id, m.display_name,
            (SELECT COUNT(*) FROM workouts w
              WHERE w.chat_id = m.chat_id AND w.line_user_id = m.line_user_id AND w.logged_date = ?) AS n
     FROM challenge_members m WHERE m.chat_id = ? AND m.active = 1
     ORDER BY m.joined_at`
  ).bind(today, chatId).all()).results;
  return {
    done: rows.filter((r) => r.n > 0),
    missing: rows.filter((r) => !r.n),
  };
}

// จำนวนวันที่ออกติดต่อกัน (นับถึงวันนี้ หรือเมื่อวานถ้าวันนี้ยังไม่ออก)
async function getStreak(env, chatId, userId) {
  const rows = (await env.DB.prepare(
    `SELECT DISTINCT logged_date FROM workouts
     WHERE chat_id = ? AND line_user_id = ? ORDER BY logged_date DESC LIMIT 400`
  ).bind(chatId, userId).all()).results;
  if (!rows.length) return 0;
  const dates = new Set(rows.map((r) => r.logged_date));
  const start = dates.has(bkkToday()) ? 0 : 1;
  let streak = 0;
  for (let i = start; i < 400; i++) {
    if (!dates.has(bkkDateOffset(-i))) break;
    streak++;
  }
  return streak;
}

async function replyChallengeToday(env, event, chatId) {
  const { done, missing } = await getTodayStatus(env, chatId);
  if (!done.length && !missing.length) {
    return lineReply(env, event.replyToken,
      "ยังไม่มีใครเข้าร่วมชาเลนจ์เลยครับ\nพิมพ์ \"เข้าร่วม\" เพื่อสมัคร (พิมพ์กันคนละครั้ง)");
  }
  return lineReply(env, event.replyToken, todayStatusText(done, missing));
}

function todayStatusText(done, missing, withNudge = false) {
  const lines = [`เช็คชื่อวันนี้ (${thaiDateText(bkkToday())}) 📋`, ""];
  lines.push(`✅ ออกแล้ว ${done.length} คน`);
  if (done.length) lines.push("   " + done.map((m) => m.display_name).join(", "));
  lines.push("");
  if (missing.length) {
    lines.push(`⏳ ยังไม่ออก ${missing.length} คน`);
    lines.push("   " + missing.map((m) => m.display_name).join(", "));
    if (withNudge) lines.push("", `เหลือเวลาอีก ${hoursLeftToday()} ชั่วโมง ส่งรูปมาได้เลย 💪`);
  } else {
    lines.push(J.pick(J.ALL_DONE));
  }
  if (!done.length && missing.length) lines.push("", J.pick(J.NOBODY_YET));
  return lines.join("\n");
}

async function replyLeaderboard(env, event, chatId) {
  const weekStart = bkkDateOffset(-6);
  const rows = (await env.DB.prepare(
    `SELECT m.display_name, m.line_user_id,
            (SELECT COUNT(DISTINCT logged_date) FROM workouts w
              WHERE w.chat_id = m.chat_id AND w.line_user_id = m.line_user_id AND w.logged_date >= ?) AS week_days,
            (SELECT COUNT(DISTINCT logged_date) FROM workouts w
              WHERE w.chat_id = m.chat_id AND w.line_user_id = m.line_user_id) AS total_days
     FROM challenge_members m WHERE m.chat_id = ? AND m.active = 1
     ORDER BY week_days DESC, total_days DESC`
  ).bind(weekStart, chatId).all()).results;

  if (!rows.length) return lineReply(env, event.replyToken, "ยังไม่มีสมาชิกในชาเลนจ์ครับ พิมพ์ \"เข้าร่วม\" ได้เลย");

  const medals = ["🥇", "🥈", "🥉"];
  const lines = ["อันดับ 7 วันล่าสุด 🏆", ""];
  rows.forEach((r, i) => {
    const mark = r.week_days === 0 ? J.pick(J.RANK_TAIL) : medals[i] || `${i + 1}.`;
    lines.push(`${mark} ${r.display_name} — ${r.week_days}/7 วัน (รวม ${r.total_days})`);
  });
  return lineReply(env, event.replyToken, lines.join("\n"));
}

function challengeWelcomeText() {
  return [
    "เปิดโหมดชาเลนจ์ออกกำลังกายแล้วครับ 💪🔥",
    "",
    "ทุกคนในกลุ่มพิมพ์ \"เข้าร่วม\" คนละครั้งเพื่อสมัครก่อนนะครับ (คนเปิดโหมดก็ต้องพิมพ์ด้วยนะ)",
    "จากนั้นออกกำลังกายเสร็จก็ส่งรูปมาได้เลย — บอทอ่านรูปแล้วเช็คอินให้อัตโนมัติ",
    "",
    "ทุกวัน 22:00 ผมจะประกาศว่าใครยังไม่ออก ⏰",
    "พิมพ์ \"คำสั่ง\" เพื่อดูวิธีใช้ทั้งหมด",
  ].join("\n");
}

async function replyMembers(env, event, chatId) {
  const rows = (await env.DB.prepare(
    `SELECT display_name FROM challenge_members WHERE chat_id = ? AND active = 1 ORDER BY joined_at`
  ).bind(chatId).all()).results;
  if (!rows.length) {
    return lineReply(env, event.replyToken, "ยังไม่มีใครเข้าร่วมเลยครับ พิมพ์ \"เข้าร่วม\" ได้เลย 💪");
  }
  return lineReply(env, event.replyToken,
    `สมาชิกชาเลนจ์ ${rows.length} คน 👥\n` + rows.map((r, i) => `${i + 1}. ${r.display_name}`).join("\n") +
    `\n\nใครยังไม่ได้สมัครพิมพ์ "เข้าร่วม" · อยากถอนตัวพิมพ์ "ออกจากชาเลนจ์"`);
}

// เรียกเตือนแบบแท็กชื่อเองได้ ไม่ต้องรอ 22:00 (reply ไม่กินโควตาข้อความ)
async function replyNudge(env, event, chatId) {
  const { done, missing } = await getTodayStatus(env, chatId);
  if (!done.length && !missing.length) {
    return lineReply(env, event.replyToken, "ยังไม่มีใครเข้าร่วมชาเลนจ์เลยครับ พิมพ์ \"เข้าร่วม\" ก่อนนะ");
  }
  if (!missing.length) {
    return lineReply(env, event.replyToken, todayStatusText(done, missing));
  }
  const nudge = buildNudge(done, missing);
  return lineReply(env, event.replyToken, nudge.text, nudge.mention);
}

function challengeHelpText() {
  return [
    "โหมดชาเลนจ์ออกกำลังกาย 💪",
    "",
    "📸 ส่งรูป \"หน้าจอสรุปผล\" — นาฬิกา แอปวิ่ง หรือหน้าจอลู่วิ่งที่เห็นตัวเลข",
    "   (รูปยิม รองเท้า เซลฟี่ ไม่นับนะ ต้องเห็นตัวเลข)",
    "✍️ หรือพิมพ์บอก เช่น \"วิ่ง 5 กม.\" \"เล่นเวท 1 ชม.\"",
    "",
    "เข้าร่วม — สมัครเข้าชาเลนจ์ (พิมพ์กันคนละครั้ง)",
    "วันนี้ — ดูว่าใครออกแล้ว ใครยังไม่ออก",
    "สมาชิก — ดูรายชื่อคนที่เข้าร่วมทั้งหมด",
    "ลบ — ลบรายการเช็คอินของตัวเอง (แท็กชื่อ/reply เพื่อลบของเพื่อน)",
    "เมื่อวาน — ย้ายรายการล่าสุดไปเป็นของเมื่อวาน",
    "   (แท็กชื่อเพื่อน หรือ reply ที่รูปเขา แล้วพิมพ์ \"เมื่อวาน\" ก็แก้ให้เขาได้)",
    "เตือน — แท็กชื่อคนที่ยังไม่ออก (เด้งแจ้งเตือนถึงตัว)",
    "อันดับ — ตารางคะแนน 7 วันล่าสุด",
    "ออกจากชาเลนจ์ — ถอนตัว",
    "",
    "ทุกวัน 22:00 บอทจะเตือนคนที่ยังไม่ออกให้เองครับ ⏰",
  ].join("\n");
}

// สร้างข้อความเตือนแบบ @แท็กชื่อ (LINE จะเด้งแจ้งเตือนถึงคนนั้นโดยตรง)
// แท็กต้องอยู่ต้นข้อความ เพราะ index ที่ส่งให้ LINE นับจากตัวอักษรตัวแรก
function buildNudge(done, missing) {
  const tagged = missing.slice(0, 20); // LINE แท็กได้สูงสุด 20 คนต่อข้อความ
  let head = "";
  const mentionees = [];
  for (const m of tagged) {
    const label = "@" + m.display_name;
    mentionees.push({ index: head.length, length: label.length, userId: m.line_user_id });
    head += label + " ";
  }
  // ตัดช่องว่างท้ายแท็กทิ้ง (ตัดท้ายไม่กระทบ index ของแท็กที่อยู่ก่อนหน้า)
  const rest = tagged.length < missing.length ? ` และอีก ${missing.length - tagged.length} คน` : "";
  const text = `${head.trimEnd()}${rest}\n\n${J.pick(J.NUDGE)(hoursLeftToday())}\n\n` + todayStatusText(done, missing);
  return { text, mention: { mentionees } };
}

// cron 22:00 ไทย — เตือนคนที่ยังไม่ออกกำลังกาย
async function pushChallengeReminder(env) {
  const groups = (await env.DB.prepare(
    "SELECT id FROM chat_targets WHERE mode = 'challenge'"
  ).all()).results;

  for (const g of groups) {
    const { done, missing } = await getTodayStatus(env, g.id);
    if (!done.length && !missing.length) continue;

    if (!missing.length) {
      await linePush(env, g.id, todayStatusText(done, missing, true))
        .catch((e) => console.error("challenge push fail", e.message));
      continue;
    }
    const nudge = buildNudge(done, missing);
    await linePush(env, g.id, nudge.text, nudge.mention).catch(async (e) => {
      // แท็กไม่ผ่าน (เช่น มีคนออกจากกลุ่มไปแล้ว) → ส่งแบบข้อความธรรมดาแทน
      console.error("mention push failed, falling back", e.message);
      await linePush(env, g.id, todayStatusText(done, missing, true)).catch(() => {});
    });
  }
}
