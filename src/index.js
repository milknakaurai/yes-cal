// Yes Cal — LINE calorie tracker bot for two people
// Cloudflare Worker: LINE webhook + Gemini calorie estimation + D1 + dashboard API + nightly cron

const LINE_API = "https://api.line.me/v2/bot";
const LINE_DATA_API = "https://api-data.line.me/v2/bot";

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

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(pushNightlySummary(env));
  },
};

// ---------------------------------------------------------------- webhook

async function handleWebhook(request, env, ctx) {
  const bodyText = await request.text();

  const ok = await verifyLineSignature(
    bodyText,
    request.headers.get("x-line-signature"),
    env.LINE_CHANNEL_SECRET
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
  // จำห้องแชทไว้สำหรับ push สรุปตอน 21:00
  if (event.source) await rememberChatTarget(env, event.source);

  if (event.type === "join" || event.type === "follow") {
    return lineReply(env, event.replyToken, greetingText());
  }
  if (event.type !== "message") return;

  const userId = event.source?.userId;
  if (!userId) return;

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
  if (/^สรุป$/.test(text)) return replyTodaySummary(env, event);
  if (/^(สัปดาห์|รายสัปดาห์)$/.test(text)) return replyWeekSummary(env, event);
  if (/^(ลบล่าสุด|ลบ)$/.test(text)) return deleteLastMeal(env, event, user);

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
    "⚖️ น้ำหนัก 65.5 — บันทึกน้ำหนักวันนี้",
    "📊 สรุป — ยอดวันนี้ของทั้งคู่",
    "📅 สัปดาห์ — ย้อนหลัง 7 วัน",
    "🗑️ ลบล่าสุด — ลบรายการอาหารล่าสุดของวันนี้",
    "🎯 เป้าหมาย — ดูเป้าที่ตั้งไว้",
    "",
    "ทุกวัน 21:00 ผมจะสรุปให้อัตโนมัติครับ 🌙",
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
    reply = "ข้อสุดท้าย: เป้าหมายคืออะไรครับ?\n1. ลดน้ำหนัก\n2. รักษาน้ำหนัก\n3. เพิ่มน้ำหนัก\n(ตอบ 1-3 หรือพิมพ์ ลด/คงที่/เพิ่ม)";
  } else if (state === "goal") {
    if (/^1|ลด/.test(text)) draft.goal_type = "lose";
    else if (/^2|คง|รักษา/.test(text)) draft.goal_type = "maintain";
    else if (/^3|เพิ่ม/.test(text)) draft.goal_type = "gain";
    else return lineReply(env, event.replyToken, "ตอบ 1, 2 หรือ 3 ครับ");
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
  const adjust = d.goal_type === "lose" ? -500 : d.goal_type === "gain" ? 400 : 0;
  return { bmr: Math.round(bmr), tdee: Math.round(tdee), target: Math.round(tdee + adjust) };
}

async function finishSetup(env, event, user, draft) {
  const { bmr, tdee, target } = calcTargets(draft);
  await env.DB.prepare(
    `UPDATE users SET sex=?, age=?, height_cm=?, weight_kg=?, activity=?, goal_type=?,
     target_kcal=?, setup_state=NULL, setup_draft=NULL WHERE line_user_id=?`
  ).bind(
    draft.sex, draft.age, draft.height_cm, draft.weight_kg, draft.activity,
    draft.goal_type, target, user.line_user_id
  ).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO weights (line_user_id, weight_kg, logged_date) VALUES (?, ?, ?)"
  ).bind(user.line_user_id, draft.weight_kg, bkkToday()).run();

  const goalTh = { lose: "ลดน้ำหนัก (−500 kcal/วัน)", maintain: "รักษาน้ำหนัก", gain: "เพิ่มน้ำหนัก (+400 kcal/วัน)" }[draft.goal_type];
  return lineReply(env, event.replyToken, [
    `ตั้งเป้าเสร็จแล้วครับ ${user.display_name} ✅`,
    "",
    `BMR: ${fmtNum(bmr)} kcal`,
    `TDEE: ${fmtNum(tdee)} kcal`,
    `เป้าหมาย: ${goalTh}`,
    "",
    `🎯 กินวันละ ${fmtNum(target)} kcal`,
    "",
    "กินอะไรก็พิมพ์บอกได้เลยครับ 🍚",
  ].join("\n"));
}

async function replyGoal(env, event, user) {
  if (!user.target_kcal) {
    return lineReply(env, event.replyToken, `${user.display_name} ยังไม่ได้ตั้งเป้าครับ พิมพ์ "ตั้งเป้า" ก่อนนะ`);
  }
  const goalTh = { lose: "ลดน้ำหนัก", maintain: "รักษาน้ำหนัก", gain: "เพิ่มน้ำหนัก" }[user.goal_type] || "-";
  return lineReply(env, event.replyToken,
    `เป้าของ ${user.display_name} 🎯\n${fmtNum(user.target_kcal)} kcal/วัน (${goalTh})\nน้ำหนักล่าสุด ${user.weight_kg} กก.`
  );
}

// ---------------------------------------------------------------- food logging

async function maybeLogFoodFromText(env, event, user, text) {
  // กันข้อความคุยเล่นยาว ๆ ไม่ต้องเสียโควตา Gemini
  if (text.length > 200) return;

  const result = await geminiEstimate(env, [{ text: foodPromptForText(text) }]);
  if (!result || !result.is_food || !result.items?.length) return; // ไม่ใช่อาหาร → เงียบไว้ ไม่รบกวนแชท

  return saveMealsAndReply(env, event, user, result, "text");
}

async function handleImageMessage(event, env, userId) {
  const user = await getOrCreateUser(env, userId, event.source);

  const res = await fetch(`${LINE_DATA_API}/message/${event.message.id}/content`, {
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`LINE content fetch failed: ${res.status}`);
  const mime = res.headers.get("content-type") || "image/jpeg";
  const b64 = bytesToBase64(new Uint8Array(await res.arrayBuffer()));

  const result = await geminiEstimate(env, [
    { inline_data: { mime_type: mime, data: b64 } },
    { text: foodPromptForImage() },
  ]);

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

  const lines = ["บันทึกแล้ว 🍽️", ...itemLines, "", statusLine(user, totals.kcal)];
  if (result.note) lines.splice(1, 0, `(${result.note})`);
  return lineReply(env, event.replyToken, lines.join("\n"));
}

function statusLine(user, kcalToday) {
  if (!user.target_kcal) {
    return `วันนี้ ${user.display_name} กินไป ${fmtNum(kcalToday)} kcal\n(พิมพ์ "ตั้งเป้า" เพื่อให้ผมช่วยดูว่าควรกินวันละเท่าไหร่)`;
  }
  const diff = user.target_kcal - kcalToday;
  const base = `วันนี้ ${user.display_name}: ${fmtNum(kcalToday)} / ${fmtNum(user.target_kcal)} kcal`;
  if (diff >= 0) return `${base}\nเหลืออีก ${fmtNum(diff)} kcal`;
  return `${base}\nเกินเป้า ${fmtNum(-diff)} kcal แล้วนะ 😅`;
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
    `ลบ "${last.name}" (${fmtNum(last.kcal)} kcal) แล้วครับ 🗑️\n${statusLine(user, totals.kcal)}`);
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
    blocks.push(`${statusLine(u, totals.kcal)}\nP ${Math.round(totals.protein_g)}g / C ${Math.round(totals.carb_g)}g / F ${Math.round(totals.fat_g)}g\n${mealLines}`);
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
      `SELECT eaten_date, SUM(kcal) AS kcal FROM meals
       WHERE line_user_id = ? AND eaten_date >= ? GROUP BY eaten_date`
    ).bind(u.line_user_id, days[0]).all()).results;
    const byDate = Object.fromEntries(rows.map((r) => [r.eaten_date, r.kcal]));
    const lines = days.map((d) => {
      const k = byDate[d] || 0;
      const mark = !u.target_kcal || !k ? "" : k <= u.target_kcal ? " ✅" : " ⚠️";
      return `  ${thaiDow(d)} ${d.slice(8)}/${d.slice(5, 7)}: ${fmtNum(k)}${mark}`;
    });
    const total = days.reduce((s, d) => s + (byDate[d] || 0), 0);
    const avg = Math.round(total / 7);
    blocks.push(`${u.display_name}${u.target_kcal ? ` (เป้า ${fmtNum(u.target_kcal)})` : ""}\n${lines.join("\n")}\n  เฉลี่ย ${fmtNum(avg)} kcal/วัน`);
  }
  return lineReply(env, event.replyToken, `7 วันล่าสุด 📅\n\n${blocks.join("\n\n")}\n\nดูกราฟเต็ม ๆ ที่หน้าเว็บได้นะครับ 📈`);
}

// cron 21:00 ไทย — push สรุปเข้าแชท
async function pushNightlySummary(env) {
  const targets = (await env.DB.prepare(
    "SELECT id FROM chat_targets WHERE type IN ('group','room')"
  ).all()).results;
  const users = await getAllUsers(env);
  if (!targets.length || !users.length) return;

  const today = bkkToday();
  const lines = ["สรุปประจำวัน 🌙 (" + today + ")", ""];
  for (const u of users) {
    const totals = await getDayTotals(env, u.line_user_id, today);
    lines.push(statusLine(u, totals.kcal));
    lines.push("");
  }
  lines.push("ยังกินต่อได้อีกนิดหน่อยก่อนนอนนะครับ 😄");

  for (const t of targets) {
    await linePush(env, t.id, lines.join("\n").trim()).catch((e) => console.error("push fail", e.message));
  }
}

// ---------------------------------------------------------------- Gemini

function foodPromptForText(text) {
  return `คุณเป็นนักโภชนาการผู้เชี่ยวชาญอาหารไทย ผู้ใช้พิมพ์ข้อความในแชท: "${text}"

ถ้าข้อความนี้เป็นการบอกว่ากิน/ดื่มอะไร ให้ประเมินแคลอรี่และสารอาหารของทุกรายการ โดยใช้ขนาดเสิร์ฟไทยทั่วไปถ้าไม่ระบุปริมาณ ถ้าระบุจำนวน (เช่น 2 จาน) ให้คูณตาม
ถ้าเป็นแค่บทสนทนาทั่วไป คำถาม หรือไม่เกี่ยวกับการกินอาหาร ให้ is_food = false`;
}

function foodPromptForImage() {
  return `คุณเป็นนักโภชนาการผู้เชี่ยวชาญอาหารไทย ดูรูปนี้แล้วประเมินว่าเป็นอาหาร/เครื่องดื่มอะไร ปริมาณเท่าไหร่ และประเมินแคลอรี่กับสารอาหารของแต่ละรายการที่เห็น
ถ้าไม่แน่ใจชนิดอาหาร ให้เดาที่ใกล้เคียงที่สุดและบอกไว้ใน note ถ้ารูปไม่ใช่อาหารเลย ให้ is_food = false`;
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

async function geminiEstimate(env, parts) {
  if (!env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY not set");
    return null;
  }
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          response_mime_type: "application/json",
          response_schema: FOOD_SCHEMA,
          temperature: 0.2,
        },
      }),
    }
  );
  if (!res.ok) {
    console.error("gemini error", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- LINE helpers

async function lineReply(env, replyToken, text) {
  const res = await fetch(`${LINE_API}/message/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
  if (!res.ok) console.error("reply fail", res.status, await res.text());
}

async function linePush(env, to, text) {
  const res = await fetch(`${LINE_API}/message/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
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
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
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
  if (env.DASHBOARD_KEY) {
    const key = url.searchParams.get("key") || request.headers.get("x-dashboard-key");
    if (key !== env.DASHBOARD_KEY) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
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
