// worker/index.js — Cloudflare Worker для «Apple i Точка»
// 1) Отправка лидов с сайта в Telegram-чат оператора (FR-4.1)
// 2) Мини-CRM API: чтение/запись цен и наличия в KV (FR-4.2)
// 3) Управление лидами прямо в Telegram: статус (в работе / закрыт / отказ),
//    блокировка номера-спамера и удаление всех его сообщений (кнопки под заявкой).
//
// Секреты (wrangler secret put ...):
//   TELEGRAM_BOT_TOKEN  — токен бота @BotFather
//   TELEGRAM_CHAT_ID    — id чата/группы оператора
//   ADMIN_TOKEN         — пароль для доступа к /admin.html
//   TURNSTILE_SECRET    — (опц.) секрет Cloudflare Turnstile (проверка капчи)
//   TG_WEBHOOK_SECRET   — (опц., но нужен для кнопок под лидом) произвольная строка.
//     После деплоя один раз зарегистрируйте webhook, чтобы кнопки заработали:
//     curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>/api/tg/webhook&secret_token=<TG_WEBHOOK_SECRET>"
// Binding KV: PRODUCTS (см. wrangler.toml). Ключ "catalog" хранит весь каталог.

const KV_KEY = "catalog";

// Человекочитаемые подписи статусов лида.
const STATUS_LABEL = {
  new: "",
  active: "🟢 В работе",
  closed: "✅ Закрыт",
  refused: "🚫 Отказ",
  blocked: "⛔ Заблокирован",
};

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

      // ---- Отзывы (Яндекс / 2ГИС): централизованный кэш в KV ----
      // GET  /api/reviews         — публично, отдаёт витрину отзывов (кэш).
      // POST /api/admin/reviews   — под ADMIN_TOKEN, обновляет витрину.
      if (url.pathname === "/api/reviews" && request.method === "GET") {
        const raw = await env.PRODUCTS.get("reviews");
        return new Response(raw || JSON.stringify({ sources: [] }), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=600" },
        });
      }
      if (url.pathname === "/api/admin/reviews" && request.method === "POST") {
        if (!authorized(request, env)) return json({ success: false, error: "unauthorized" }, 401, cors);
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.sources)) return json({ success: false, error: "bad_reviews" }, 400, cors);
        await env.PRODUCTS.put("reviews", JSON.stringify({ sources: body.sources, updatedAt: new Date().toISOString() }));
        return json({ success: true, count: body.sources.length }, 200, cors);
      }

      // ---- Приём лида -> Telegram ----
      if (url.pathname === "/api/lead" && request.method === "POST") {
        return await handleLead(request, env, cors);
      }

      // ---- Telegram webhook: нажатия кнопок под заявкой ----
      // Вызывается самим Telegram (server-to-server), CORS не нужен.
      // Защита — секретным заголовком X-Telegram-Bot-Api-Secret-Token.
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
        await triggerRebuild(env, "seed");
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
        await triggerRebuild(env, "save"); // пересобрать пререндер-страницы с новыми ценами
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
        await triggerRebuild(env, "restore");
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
    headers: { ...(cors || {}), "Content-Type": "application/json" },
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

// Пересборка сайта на GitHub Pages после изменения каталога — чтобы пререндер-страницы
// /p/<id>/ обновились с новыми ценами/наличием. Best-effort: если секреты не заданы —
// тихо пропускаем (пользователи и так видят актуальные цены через гидратацию из KV).
// Нужны переменные: GH_DISPATCH_TOKEN (fine-grained PAT, права Actions/Contents на репо),
// GH_REPO (например "DeepBlue2416/DeepBlue2416.github.io").
async function triggerRebuild(env, reason) {
  if (!env.GH_DISPATCH_TOKEN || !env.GH_REPO) return;
  try {
    await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "appleitochka-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: "catalog-updated", client_payload: { reason: reason || "update" } }),
    });
  } catch (e) { /* best-effort */ }
}

function authorized(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return env.ADMIN_TOKEN && token && safeEqual(token, env.ADMIN_TOKEN);
}

// Сравнение строк с защитой от тайминг-атак
function safeEqual(a, b) {
  a = String(a); b = String(b);
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

// ==== Telegram helpers ================================================

// Нормализуем телефон в стабильный ключ: только цифры, последние 15.
function normPhone(p) {
  return String(p || "").replace(/\D/g, "").slice(-15);
}

// Универсальный вызов Telegram Bot API. Возвращает разобранный JSON.
async function tgCall(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Инлайн-клавиатура под заявкой. status ∈ new|active|closed|refused.
// blocked — состояние бан-листа (кнопка-переключатель). callback_data: код(2) + ":" + телефон.
function leadKeyboard(phone, status, blocked) {
  const mark = (s, label) => (status === s ? `${label} ✓` : label);
  const blockBtn = blocked
    ? { text: "🔓 Разблокировать", callback_data: `ub:${phone}` }
    : { text: "⛔ Заблокировать", callback_data: `bl:${phone}` };
  return {
    inline_keyboard: [
      [
        { text: mark("active", "🟢 В работе"), callback_data: `sa:${phone}` },
        { text: mark("closed", "✅ Закрыт"), callback_data: `sc:${phone}` },
        { text: mark("refused", "🚫 Отказ"), callback_data: `sr:${phone}` },
      ],
      [blockBtn, { text: "🗑 Удалить спам", callback_data: `dl:${phone}` }],
    ],
  };
}

async function isBlocked(env, phone) {
  if (!phone || !env.PRODUCTS) return false;
  try { return !!(await env.PRODUCTS.get(`tg:block:${phone}`)); } catch { return false; }
}

// Синхронизируем клавиатуру (состояние блокировки/статус) на ВСЕХ сообщениях номера.
async function syncKeyboards(env, phone, blocked) {
  let list = [];
  try { list = JSON.parse((await env.PRODUCTS.get(`tg:msgs:${phone}`)) || "[]"); } catch {}
  for (const it of list) {
    let status = "new";
    try {
      const saved = await env.PRODUCTS.get(`tg:lead:${it.c}:${it.m}`);
      if (saved) status = JSON.parse(saved).status || "new";
    } catch {}
    await tgCall(env, "editMessageReplyMarkup", {
      chat_id: it.c,
      message_id: it.m,
      reply_markup: leadKeyboard(phone, status, blocked),
    });
  }
}

// Запоминаем сообщение лида: исходный текст (для смены статуса) и связь с телефоном
// (чтобы «Удалить спам» мог снести все сообщения этого номера).
async function rememberLeadMessage(env, chatId, msgId, text, phone) {
  try {
    await env.PRODUCTS.put(
      `tg:lead:${chatId}:${msgId}`,
      JSON.stringify({ text, phone, status: "new" }),
      { expirationTtl: 60 * 60 * 24 * 60 } // 60 дней
    );
    let list = [];
    try { list = JSON.parse((await env.PRODUCTS.get(`tg:msgs:${phone}`)) || "[]"); } catch {}
    list.push({ c: chatId, m: msgId });
    if (list.length > 200) list = list.slice(-200);
    await env.PRODUCTS.put(`tg:msgs:${phone}`, JSON.stringify(list), { expirationTtl: 60 * 60 * 24 * 60 });
  } catch {}
}

async function handleLead(request, env, cors) {
  const data = await request.json().catch(() => null);
  if (!data || !data.name || !data.phone) {
    return json({ success: false, error: "name_and_phone_required" }, 400, cors);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const np = normPhone(data.phone);

  // Заблокированный номер: молча «принимаем» заявку (сайт покажет успех),
  // но оператору ничего не шлём — чтобы спамер не понял, что он в бане.
  if (np && env.PRODUCTS) {
    try {
      if (await env.PRODUCTS.get(`tg:block:${np}`)) {
        return json({ success: true, ok: true }, 200, cors);
      }
    } catch {}
  }

  // Ограничение частоты (анти-спам)
  if (await rateLimited(env, ip)) {
    return json({ success: false, error: "rate_limited", message: "Слишком много заявок. Попробуйте через минуту." }, 429, cors);
  }

  // Проверка капчи Cloudflare Turnstile (защита от спама)
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

  const res = await tgCall(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: leadKeyboard(np, "new", false),
  });

  if (!res || !res.ok) {
    return json({ success: false, error: "telegram_failed", detail: res && res.description }, 502, cors);
  }

  // Запоминаем для управления лидом (статус / удаление спама)
  const m = res.result;
  if (m && m.chat && np) {
    await rememberLeadMessage(env, m.chat.id, m.message_id, text, np);
  }

  return json({ success: true, ok: true }, 200, cors);
}

// ==== Telegram webhook: обработка нажатий кнопок ======================
async function handleTgWebhook(request, env) {
  // Проверяем секретный заголовок (его выставляет Telegram, если задан при setWebhook).
  if (env.TG_WEBHOOK_SECRET) {
    const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!safeEqual(got, env.TG_WEBHOOK_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }
  }

  const update = await request.json().catch(() => null);

  // --- Текстовые команды оператора (152-ФЗ «право быть забытым») ---
  // /delete_data +7XXXXXXXXXX — удаляет ВСЕ данные номера: сообщения бота в чате,
  // связанные записи в KV и бан-статус. Реализует запрос на удаление перс. данных.
  const msg = update && update.message;
  if (msg && typeof msg.text === "string") {
    const mDel = msg.text.trim().match(/^\/delete_data(?:@\w+)?\s+(.+)$/i);
    if (mDel) {
      const phone = normPhone(mDel[1]);
      const reply = (t) => tgCall(env, "sendMessage", { chat_id: msg.chat.id, text: t, parse_mode: "HTML", reply_to_message_id: msg.message_id });
      if (!phone) { await reply("Укажите телефон: <code>/delete_data +7XXXXXXXXXX</code>"); return new Response("ok"); }
      let list = [];
      try { list = JSON.parse((await env.PRODUCTS.get(`tg:msgs:${phone}`)) || "[]"); } catch {}
      let n = 0;
      for (const it of list) {
        const r = await tgCall(env, "deleteMessage", { chat_id: it.c, message_id: it.m });
        if (r && r.ok) n++;
        try { await env.PRODUCTS.delete(`tg:lead:${it.c}:${it.m}`); } catch {}
      }
      try { await env.PRODUCTS.delete(`tg:msgs:${phone}`); } catch {}
      try { await env.PRODUCTS.delete(`tg:block:${phone}`); } catch {}
      await reply(`✅ Данные номера удалены. Сообщений стёрто: ${n}. Записи в KV очищены (152-ФЗ).`);
      return new Response("ok");
    }
    if (/^\/(start|help)\b/i.test(msg.text.trim())) {
      await tgCall(env, "sendMessage", { chat_id: msg.chat.id, text: "Бот заявок «Apple и точка».\nКоманда оператора: <code>/delete_data +7XXXXXXXXXX</code> — удалить данные покупателя (152-ФЗ).", parse_mode: "HTML" });
      return new Response("ok");
    }
  }

  const cq = update && update.callback_query;
  // Не callback (обычное сообщение и т.п.) — просто подтверждаем приём.
  if (!cq || !cq.data) return new Response("ok");

  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const msgId = cq.message && cq.message.message_id;
  const action = String(cq.data).slice(0, 2);
  const phone = String(cq.data).slice(3);

  // Исходный текст заявки (без строки статуса) — чтобы статус не «накапливался».
  let baseText = (cq.message && (cq.message.text || cq.message.caption)) || "";
  try {
    const saved = await env.PRODUCTS.get(`tg:lead:${chatId}:${msgId}`);
    if (saved) baseText = JSON.parse(saved).text || baseText;
  } catch {}

  const answer = (t) => tgCall(env, "answerCallbackQuery", { callback_query_id: cq.id, text: t || "" });

  // Сохраняем статус в записи сообщения (чтобы синхронизация клавиатур его не сбрасывала).
  const persistStatus = async (statusKey) => {
    try {
      const saved = await env.PRODUCTS.get(`tg:lead:${chatId}:${msgId}`);
      const rec = saved ? JSON.parse(saved) : { text: baseText, phone };
      rec.status = statusKey;
      await env.PRODUCTS.put(`tg:lead:${chatId}:${msgId}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 60 });
    } catch {}
  };

  const setStatus = async (statusKey) => {
    const label = STATUS_LABEL[statusKey] || "";
    const newText = baseText + (label ? `\n\n<b>Статус:</b> ${label}` : "");
    await persistStatus(statusKey);
    const blocked = await isBlocked(env, phone);
    await tgCall(env, "editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: newText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: leadKeyboard(phone, statusKey, blocked),
    });
  };

  try {
    if (action === "sa") { await setStatus("active"); await answer("Отмечено: в работе"); }
    else if (action === "sc") { await setStatus("closed"); await answer("Отмечено: закрыт"); }
    else if (action === "sr") { await setStatus("refused"); await answer("Отмечено: отказ"); }
    else if (action === "bl") {
      if (phone) await env.PRODUCTS.put(`tg:block:${phone}`, "1", { expirationTtl: 60 * 60 * 24 * 365 });
      await syncKeyboards(env, phone, true);   // обновляем кнопку на ВСЕХ сообщениях номера
      await answer("Номер заблокирован — кнопка переключена на всех заявках");
    } else if (action === "ub") {
      if (phone) await env.PRODUCTS.delete(`tg:block:${phone}`);
      await syncKeyboards(env, phone, false);
      await answer("Номер разблокирован");
    } else if (action === "dl") {
      // Удаляем все сообщения бота от этого номера (спам).
      let list = [];
      try { list = JSON.parse((await env.PRODUCTS.get(`tg:msgs:${phone}`)) || "[]"); } catch {}
      let n = 0;
      for (const it of list) {
        const r = await tgCall(env, "deleteMessage", { chat_id: it.c, message_id: it.m });
        if (r && r.ok) n++;
        try { await env.PRODUCTS.delete(`tg:lead:${it.c}:${it.m}`); } catch {}
      }
      // На всякий случай удаляем и текущее сообщение, если его не было в списке.
      await tgCall(env, "deleteMessage", { chat_id: chatId, message_id: msgId });
      try { await env.PRODUCTS.delete(`tg:msgs:${phone}`); } catch {}
      await answer(`Удалено сообщений: ${n}`);
    } else {
      await answer();
    }
  } catch (e) {
    await answer("Ошибка: " + String(e).slice(0, 80));
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
