// worker/index.js — Cloudflare Worker для «Apple i Точка»
// 1) Отправка лидов с сайта в Telegram-чат оператора (FR-4.1)
// 2) Мини-CRM API: чтение/запись цен и наличия в KV (FR-4.2)
//
// Секреты (wrangler secret put ...):
//   TELEGRAM_BOT_TOKEN  — токен бота @BotFather
//   TELEGRAM_CHAT_ID    — id чата/группы оператора
//   ADMIN_TOKEN         — пароль для доступа к /admin.html
// Binding KV: PRODUCTS (см. wrangler.toml). Ключ "catalog" хранит весь каталог.

const KV_KEY = "catalog";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // ---- Публичный каталог (реальное время из KV) ----
      if (url.pathname === "/api/products" && request.method === "GET") {
        const raw = await env.PRODUCTS.get(KV_KEY);
        if (!raw) {
          return json({ error: "catalog_not_seeded" }, 404, cors);
        }
        return new Response(raw, {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // ---- Приём лида -> Telegram ----
      if (url.pathname === "/api/lead" && request.method === "POST") {
        return await handleLead(request, env, cors);
      }

      // ---- Telegram webhook (кнопки под лидом: статус, блок, удалить спам) ----
      if (url.pathname === "/api/tg/webhook" && request.method === "POST") {
        return await handleTgWebhook(request, env);
      }

      // ---- CRM: инициализация каталога (первый запуск) ----
      if (url.pathname === "/api/admin/seed" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const body = await request.json();
        if (!body || !Array.isArray(body.products)) {
          return json({ error: "bad_catalog" }, 400, cors);
        }
        await env.PRODUCTS.put(KV_KEY, JSON.stringify(body));
        return json({ ok: true, count: body.products.length }, 200, cors);
      }

      // ---- CRM: обновление цен/статусов (быстрое, обратная совместимость) ----
      if (url.pathname === "/api/admin/update" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        return await handleUpdate(request, env, cors);
      }

      // ---- CRM: сохранить ВЕСЬ каталог (товары + категории + фото) ----
      if (url.pathname === "/api/admin/save" && request.method === "POST") {
        if (!authorized(request, env)) return json({ success: false, error: "unauthorized" }, 401, cors);
        const body = await request.json().catch(() => null);
        const cat = body && body.catalog;
        if (!cat || !Array.isArray(cat.products) || !Array.isArray(cat.categories)) {
          return json({ success: false, error: "bad_catalog" }, 400, cors);
        }
        const cur = await env.PRODUCTS.get(KV_KEY);
        await pushHistory(env, cur, (body && body.note) || "перед сохранением");
        if (cat.meta) cat.meta.updatedAt = new Date().toISOString().slice(0, 10);
        await env.PRODUCTS.put(KV_KEY, JSON.stringify(cat));
        return json({ success: true, ok: true, count: cat.products.length }, 200, cors);
      }

      // ---- CRM: список версий (история для отката) ----
      if (url.pathname === "/api/admin/history" && request.method === "GET") {
        if (!authorized(request, env)) return json({ success: false, error: "unauthorized" }, 401, cors);
        let idx = [];
        try { idx = JSON.parse((await env.PRODUCTS.get("cat:hist:index")) || "[]"); } catch {}
        return json({ success: true, versions: idx }, 200, cors);
      }

      // ---- CRM: откат к версии ----
      if (url.pathname === "/api/admin/restore" && request.method === "POST") {
        if (!authorized(request, env)) return json({ success: false, error: "unauthorized" }, 401, cors);
        const body = await request.json().catch(() => null);
        const ts = body && body.ts;
        const bak = ts ? await env.PRODUCTS.get(`cat:hist:${ts}`) : null;
        if (!bak) return json({ success: false, error: "version_not_found" }, 404, cors);
        const cur = await env.PRODUCTS.get(KV_KEY);
        await pushHistory(env, cur, "перед откатом");
        await env.PRODUCTS.put(KV_KEY, bak);
        return json({ success: true, catalog: JSON.parse(bak) }, 200, cors);
      }

      return json({ error: "not_found" }, 404, cors);
    } catch (e) {
      return json({ error: "server_error", detail: String(e) }, 500, cors);
    }
  },
};

// ----------------------------------------------------------------------
function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ok = allowed.includes(origin) || allowed.includes("*");
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Резервная копия текущего каталога в историю (для обратимости изменений).
// Храним последние KEEP версий; каждая версия живёт 30 дней.
async function pushHistory(env, catalogRaw, note) {
  if (!catalogRaw) return;
  const KEEP = 15;
  const ts = Date.now();
  let count = 0;
  try { count = (JSON.parse(catalogRaw).products || []).length; } catch {}
  await env.PRODUCTS.put(`cat:hist:${ts}`, catalogRaw, { expirationTtl: 60 * 60 * 24 * 30 });
  let idx = [];
  try { idx = JSON.parse((await env.PRODUCTS.get("cat:hist:index")) || "[]"); } catch {}
  idx.unshift({ ts, count, note: note || "" });
  const drop = idx.slice(KEEP);
  idx = idx.slice(0, KEEP);
  await env.PRODUCTS.put("cat:hist:index", JSON.stringify(idx));
  for (const d of drop) { try { await env.PRODUCTS.delete(`cat:hist:${d.ts}`); } catch {} }
}

function authorized(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return env.ADMIN_TOKEN && token && safeEqual(token, env.ADMIN_TOKEN);
}

// Сравнение строк с защитой от тайминг-атак
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ----------------------------------------------------------------------
async function verifyTurnstile(token, env, ip) {
  // Если секрет не задан — проверку пропускаем (совместимость с офлайн/демо).
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const out = await r.json();
    return !!out.success;
  } catch {
    return false;
  }
}

// Rate limit через KV: не более LIMIT заявок с одного IP за WINDOW секунд.
async function rateLimited(env, ip) {
  if (!env.PRODUCTS || !ip) return false; // нет KV/IP → пропускаем
  const LIMIT = 5, WINDOW = 60;
  const key = `rl:${ip}`;
  const cur = parseInt((await env.PRODUCTS.get(key)) || "0", 10);
  if (cur >= LIMIT) return true;
  await env.PRODUCTS.put(key, String(cur + 1), { expirationTtl: WINDOW });
  return false;
}

async function handleLead(request, env, cors) {
  const data = await request.json().catch(() => null);
  if (!data || !data.name || !data.phone) {
    return json({ success: false, error: "name_and_phone_required" }, 400, cors);
  }

  // Проверка капчи Cloudflare Turnstile (защита от спама)
  const ip = request.headers.get("CF-Connecting-IP") || "";

  // Ограничение частоты (анти-спам)
  if (await rateLimited(env, ip)) {
    return json({ success: false, error: "rate_limited", message: "Слишком много заявок. Попробуйте через минуту." }, 429, cors);
  }

  const ok = await verifyTurnstile(data.turnstileToken, env, ip);
  if (!ok) {
    return json({ success: false, error: "captcha_failed" }, 403, cors);
  }

  // Мягкая защита от спама: длина полей
  const name = String(data.name).slice(0, 120);
  const phone = String(data.phone).slice(0, 40);
  const comment = String(data.comment || "").slice(0, 1000);
  const product = String(data.product || "—").slice(0, 200);
  const price = String(data.price || "—").slice(0, 60);
  const np = normPhone(phone);

  // Заблокированный отправитель: тихо «принимаем», но оператору не шлём (анти-спам)
  if (np && env.PRODUCTS && (await env.PRODUCTS.get(`tg:block:${np}`))) {
    return json({ success: true, ok: true }, 200, cors);
  }

  const text =
    `🛒 <b>Новая заявка с сайта</b>\n\n` +
    `📱 <b>Товар:</b> ${escapeHtml(product)}\n` +
    `💰 <b>Цена:</b> ${escapeHtml(price)}\n` +
    `👤 <b>Имя:</b> ${escapeHtml(name)}\n` +
    `📞 <b>Телефон:</b> ${escapeHtml(phone)}\n` +
    (comment ? `💬 <b>Комментарий:</b> ${escapeHtml(comment)}\n` : "") +
    `\n🔗 ${escapeHtml(data.page || "")}`;

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return json({ error: "telegram_not_configured" }, 500, cors);
  }

  const sent = await tgCall(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: leadKeyboard(np, "new"),
  });

  if (!sent || !sent.ok) {
    return json({ success: false, error: "telegram_failed", detail: JSON.stringify(sent) }, 502, cors);
  }

  // Сохраняем для управления оператором: базовый текст + список сообщений по телефону
  try {
    if (env.PRODUCTS && np) {
      const chatId = sent.result.chat.id, msgId = sent.result.message_id;
      await env.PRODUCTS.put(`tg:lead:${chatId}:${msgId}`, JSON.stringify({ text, phone: np, name }), { expirationTtl: 60 * 60 * 24 * 60 });
      let msgs = [];
      try { msgs = JSON.parse((await env.PRODUCTS.get(`tg:msgs:${np}`)) || "[]"); } catch {}
      msgs.push({ c: chatId, m: msgId });
      await env.PRODUCTS.put(`tg:msgs:${np}`, JSON.stringify(msgs.slice(-50)), { expirationTtl: 60 * 60 * 24 * 60 });
    }
  } catch {}

  return json({ success: true, ok: true }, 200, cors);
}

// Телефон → только цифры (ключ для блок-листа и группировки сообщений)
function normPhone(p) { return (String(p || "").match(/\d/g) || []).join("").slice(-15); }

// Вызов Telegram Bot API
async function tgCall(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Клавиатура под лидом. status: new|active|closed|refused|blocked
function leadKeyboard(phone, status) {
  const mark = (s, label) => (status === s ? "• " + label + " •" : label);
  return {
    inline_keyboard: [
      [
        { text: mark("active", "🟢 В работе"), callback_data: `sa:${phone}` },
        { text: mark("closed", "✅ Закрыт"), callback_data: `sc:${phone}` },
        { text: mark("refused", "🚫 Отказ"), callback_data: `sr:${phone}` },
      ],
      status === "blocked"
        ? [{ text: "♻️ Разблокировать", callback_data: `ub:${phone}` }]
        : [
            { text: "⛔ Блокировать", callback_data: `bl:${phone}` },
            { text: "🗑 Удалить спам", callback_data: `dl:${phone}` },
          ],
    ],
  };
}

const STATUS_LABEL = { active: "🟢 В работе", closed: "✅ Закрыт", refused: "🚫 Отказ", blocked: "⛔ Заблокирован" };

// Обработчик Telegram webhook: реагирует на нажатия кнопок под лидом
async function handleTgWebhook(request, env) {
  // Проверка секрета (setWebhook secret_token = env.TG_WEBHOOK_SECRET)
  if (env.TG_WEBHOOK_SECRET) {
    const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (got !== env.TG_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
  }
  const upd = await request.json().catch(() => null);
  const cq = upd && upd.callback_query;
  if (!cq) return new Response("ok");

  const data = String(cq.data || "");
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const [action, phone] = [data.slice(0, 2), data.slice(3)];
  const answer = (txt) => tgCall(env, "answerCallbackQuery", { callback_query_id: cq.id, text: txt || "" });

  let base = null;
  try { base = JSON.parse((await env.PRODUCTS.get(`tg:lead:${chatId}:${msgId}`)) || "null"); } catch {}
  const baseText = base ? base.text : (cq.message.text || cq.message.caption || "").replace(/\n\n📌.*$/s, "");

  if (action === "sa" || action === "sc" || action === "sr") {
    const st = action === "sa" ? "active" : action === "sc" ? "closed" : "refused";
    await tgCall(env, "editMessageText", {
      chat_id: chatId, message_id: msgId, parse_mode: "HTML", disable_web_page_preview: true,
      text: `${baseText}\n\n📌 <b>Статус:</b> ${STATUS_LABEL[st]}`,
      reply_markup: leadKeyboard(phone, st),
    });
    await answer("Статус: " + STATUS_LABEL[st]);
  } else if (action === "bl") {
    if (phone) await env.PRODUCTS.put(`tg:block:${phone}`, "1", { expirationTtl: 60 * 60 * 24 * 365 });
    await tgCall(env, "editMessageText", {
      chat_id: chatId, message_id: msgId, parse_mode: "HTML", disable_web_page_preview: true,
      text: `${baseText}\n\n📌 <b>Статус:</b> ${STATUS_LABEL.blocked}`,
      reply_markup: leadKeyboard(phone, "blocked"),
    });
    await answer("Отправитель заблокирован — новые заявки с этого номера не придут");
  } else if (action === "ub") {
    if (phone) await env.PRODUCTS.delete(`tg:block:${phone}`);
    await tgCall(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: leadKeyboard(phone, "active") });
    await answer("Разблокирован");
  } else if (action === "dl") {
    let msgs = [];
    try { msgs = JSON.parse((await env.PRODUCTS.get(`tg:msgs:${phone}`)) || "[]"); } catch {}
    let del = 0;
    for (const m of msgs) { const r = await tgCall(env, "deleteMessage", { chat_id: m.c, message_id: m.m }); if (r && r.ok) del++; }
    await env.PRODUCTS.delete(`tg:msgs:${phone}`);
    await answer(`Удалено сообщений: ${del}`);
  } else {
    await answer();
  }
  return new Response("ok");
}

// ----------------------------------------------------------------------
async function handleUpdate(request, env, cors) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.changes)) {
    return json({ error: "bad_changes" }, 400, cors);
  }
  const raw = await env.PRODUCTS.get(KV_KEY);
  if (!raw) return json({ error: "catalog_not_seeded" }, 409, cors);

  const catalog = JSON.parse(raw);
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  let applied = 0;

  for (const ch of body.changes) {
    const p = byId.get(ch.id);
    if (!p) continue;
    if (Number.isFinite(ch.priceCash)) p.priceCash = Math.max(0, Math.round(ch.priceCash));
    if (Number.isFinite(ch.priceCard)) p.priceCard = Math.max(0, Math.round(ch.priceCard));
    if (ch.status === "in_stock" || ch.status === "on_order") p.status = ch.status;
    applied++;
  }

  if (catalog.meta) catalog.meta.updatedAt = new Date().toISOString().slice(0, 10);
  await env.PRODUCTS.put(KV_KEY, JSON.stringify(catalog));
  return json({ ok: true, applied }, 200, cors);
}
