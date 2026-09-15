// worker/index.js — Cloudflare Worker для «Apple i Точка»
// 1) Отправка лидов с сайта в Telegram-чат оператора (FR-4.1)
// 2) Мини-CRM API: чтение/запись цен и наличия в KV (FR-4.2)
// 3) Управление лидами прямо в Telegram: статус, блокировка номера, удаление спама
// 4) Синхронизация прайса из Telegram-канала по расписанию → предложения по ценам
// 5) Товарные фиды для ВК / 2ГИС / Яндекс.Карт, генерируемые из KV на лету
//
// Переменные. В веб-морде: Workers & Pages → воркер → Settings → Variables.
//   TELEGRAM_BOT_TOKEN  (секрет) — токен бота @BotFather
//   TELEGRAM_CHAT_ID    (секрет) — id чата/группы оператора
//   ADMIN_TOKEN         (секрет) — пароль для /admin.html и /prices.html
//   TURNSTILE_SECRET    (секрет, опц.) — Cloudflare Turnstile
//   TG_WEBHOOK_SECRET   (секрет, опц., нужен для кнопок под лидом)
//     После деплоя один раз зарегистрируйте webhook:
//     curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/api/tg/webhook&secret_token=<SECRET>"
//   ALLOWED_ORIGINS     — домены сайта через запятую
//   TG_PRICE_CHANNEL    — канал с прайсом (по умолчанию OPTMSK77)
//   TG_PRICE_PAGES      — сколько страниц истории читать (по умолчанию 5)
//   SITE_URL, SHOP_NAME — для товарных фидов
//   CARD_RATIO          — цена по карте = наличные × это число (по умолчанию 1.15)
// Binding KV: PRODUCTS. Ключ "catalog" хранит весь каталог.
//
// Cron: Settings → Trigger Events → Cron Triggers, например "0 5,11,15 * * *"
// (UTC; для Таганрога UTC+3 это 08:00 / 14:00 / 18:00).

import { parseLine } from "./tg-price-parse.js";
import { buildProposals, applyProposals } from "./tg-price-sync.js";
import { handleFeed } from "./tg-feeds.js";

const KV_KEY = "catalog";
const TG_PRICES_KEY = "parsed_tg_prices";
const TG_PROPOSALS_KEY = "tg_price_proposals";
const TG_SYNC_LOG_KEY = "tg_sync_log";

// Человекочитаемые подписи статусов лида.
const STATUS_LABEL = {
  new: "",
  active: "🟢 В работе",
  closed: "✅ Закрыт",
  refused: "🚫 Отказ",
  blocked: "⛔ Заблокирован",
};

export default {
  // Cron Triggers вызывают ИМЕННО scheduled(), а не fetch(). Пока этого метода
  // не было, расписание срабатывало «в пустоту»: Cloudflare писал в логи
  // «Handler does not export a scheduled() function».
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTgSync(env, event.cron));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // ---- Товарные фиды (из KV, всегда свежие) ----
      // /feed/vk.yml  /feed/2gis.yml  /feed/2gis.csv  /feed/yandex-maps.yml
      if (url.pathname.startsWith("/feed/")) {
        const fed = await handleFeed(url, env, KV_KEY);
        if (fed) return fed;
      }

      // ---- Сырой разобранный прайс ----
      // Под токеном: это закупочные цены поставщика, наружу отдавать нельзя.
      if (url.pathname === "/api/tg-prices" && request.method === "GET") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const raw = await env.PRODUCTS.get(TG_PRICES_KEY);
        return new Response(raw || "[]", {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // ---- Статус последней синхронизации (диагностика cron) ----
      // Без токена: секретов не содержит, а смотреть его нужно часто.
      if (url.pathname === "/api/tg-sync-status" && request.method === "GET") {
        const raw = await env.PRODUCTS.get(TG_SYNC_LOG_KEY);
        return new Response(raw || JSON.stringify({ ok: false, error: "cron ещё ни разу не запускался" }), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // ---- Предложения по ценам ----
      if (url.pathname === "/api/tg-proposals" && request.method === "GET") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const raw = await env.PRODUCTS.get(TG_PROPOSALS_KEY);
        return new Response(raw || JSON.stringify({ proposals: [], unmatched: [], stats: {} }), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // ---- Ручной запуск синхронизации ----
      // Тем же кодом, что и cron: иначе ручной и автоматический путь разъедутся
      // и отладка перестанет что-либо доказывать.
      if (url.pathname === "/api/admin/sync-tg" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const log = await runTgSync(env, "manual", url.searchParams.get("channel"), url.searchParams.get("pages"));
        return json({ success: log.ok, ...log }, log.ok ? 200 : 502, cors);
      }

      // ---- Применить ВЫБРАННЫЕ предложения ----
      if (url.pathname === "/api/admin/tg-apply" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        return await handleTgApply(request, env, cors);
      }

      // ---- Публичный каталог (реальное время из KV) ----
      if (url.pathname === "/api/products" && request.method === "GET") {
        const raw = await env.PRODUCTS.get(KV_KEY);
        if (!raw) {
          return json({ error: "catalog_not_seeded" }, 404, cors);
        }
        // Без query-параметров — прежнее поведение: каталог целиком (витрина
        // фильтрует на клиенте). С параметрами — фильтруем на сервере теми же
        // ортогональными правилами: ?simSlots=2&esim=1, ?simSlots=1,2,
        // ?category=&series=&storage=&watchSize=&color=&region=
        if (![...url.searchParams.keys()].length) {
          return new Response(raw, {
            status: 200,
            headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        }
        const catalog = JSON.parse(raw);
        const filtered = filterProducts(catalog.products || [], url.searchParams);
        return json({ ...catalog, products: filtered, total: filtered.length }, 200, cors);
      }

      // ---- Приём лида -> Telegram ----
      if (url.pathname === "/api/lead" && request.method === "POST") {
        return await handleLead(request, env, cors);
      }

      // ---- Telegram webhook: нажатия кнопок под заявкой ----
      // Вызывается самим Telegram (server-to-server), CORS не нужен.
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
        canonicalizeSim(body.products);
        await env.PRODUCTS.put(KV_KEY, JSON.stringify(body));
        return json({ ok: true, count: body.products.length }, 200, cors);
      }

      // ---- CRM: обновление цен/статусов ----
      if (url.pathname === "/api/admin/update" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        return await handleUpdate(request, env, cors);
      }

      // ---- CRM: сохранить ВЕСЬ каталог ----
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
        canonicalizeSim(cat.products);
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

// ======================================================================
// SIM: канонизация и разбор на ортогональные признаки.
// ДЕРЖАТЬ ИДЕНТИЧНЫМ src/js/config.js — фронтенд и бэкенд обязаны понимать
// комплектации одинаково, иначе клиентская и серверная выборка разойдутся.
// ======================================================================
function normSim(s) {
  if (s == null) return "";
  const v = String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const low = v.toLowerCase();
  if (low === "" || low === "—" || low === "-" || low === "нет") return "";
  // «2 SIM + eSIM» проверяем ПЕРВЫМ: иначе «2x Nano-SIM + eSIM» совпадёт
  // как одиночный «SIM + eSIM» либо как «2 eSIM».
  if (/2\s*x?\s*(nano-?sim|physical\s*sim|sim)s?\s*\+\s*e-?sim|dual\s*sim\s*\+\s*e-?sim/.test(low)) return "2 SIM + eSIM";
  if (/2\s*e-?sim|dual\s*e-?sim|двойн\w*\s*e-?sim/.test(low)) return "2 eSIM";
  if (/(physical|nano|sim)\s*\+\s*e-?sim|sim\s*\+\s*e-?sim/.test(low)) return "SIM + eSIM";
  if (/2\s*x?\s*(nano-?sim|physical\s*sim|sim)s?\b|dual\s*sim/.test(low)) return "2 SIM";
  if (/^e-?sim$/.test(low)) return "eSIM";
  if (/physical\s*sim|nano-?sim|^sim$/.test(low)) return "SIM";
  return v;
}

function simInfo(s) {
  switch (normSim(s)) {
    case "SIM": return { slots: 1, esim: false };
    case "eSIM": return { slots: 0, esim: true };
    case "SIM + eSIM": return { slots: 1, esim: true };
    case "2 eSIM": return { slots: 0, esim: true };
    case "2 SIM": return { slots: 2, esim: false };
    case "2 SIM + eSIM": return { slots: 2, esim: true };
    default: return { slots: 0, esim: false };
  }
}

// Приводим sim к канонической метке ПРИ ЗАПИСИ, чтобы в KV не попадали «сырые»
// строки поставщика («2x Nano-SIM + eSIM», «Dual SIM»).
function canonicalizeSim(products) {
  for (const p of products || []) {
    if (p && "sim" in p) p.sim = normSim(p.sim) || "—";
  }
  return products;
}

// Серверная выборка. Все условия по И; simSlots и esim независимы, поэтому
// «2 слота» + «есть eSIM» вместе дают именно версии .../DS.
function filterProducts(products, q) {
  const eq = (key, field) => {
    const want = q.get(key);
    return want ? (p) => String(p[field] ?? "") === want : null;
  };
  const tests = [
    eq("category", "category"), eq("series", "series"), eq("storage", "storage"),
    eq("watchSize", "watchSize"), eq("color", "color"), eq("region", "region"),
  ].filter(Boolean);

  const slotsRaw = q.get("simSlots");
  if (slotsRaw) {
    const want = slotsRaw.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n));
    if (want.length) tests.push((p) => want.includes(simInfo(p.sim).slots));
  }
  const esimRaw = q.get("esim");
  if (esimRaw === "1" || esimRaw === "true") tests.push((p) => simInfo(p.sim).esim);

  return products.filter((p) => tests.every((t) => t(p)));
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
  if (!env.PRODUCTS || !ip) return false;
  const LIMIT = 3, WINDOW = 900;
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

// Инлайн-клавиатура под заявкой. status ∈ new|active|closed|refused|blocked.
// В callback_data: 2-буквенный код действия + ":" + нормализованный телефон.
function leadKeyboard(phone, status) {
  if (status === "blocked") {
    return { inline_keyboard: [[{ text: "✅ Разблокировать", callback_data: `ub:${phone}` }]] };
  }
  const mark = (s, label) => (status === s ? `${label} ✓` : label);
  return {
    inline_keyboard: [
      [
        { text: mark("active", "🟢 В работе"), callback_data: `sa:${phone}` },
        { text: mark("closed", "✅ Закрыт"), callback_data: `sc:${phone}` },
        { text: mark("refused", "🚫 Отказ"), callback_data: `sr:${phone}` },
      ],
      [
        { text: "⛔ Блокировать", callback_data: `bl:${phone}` },
        { text: "🗑 Удалить спам", callback_data: `dl:${phone}` },
      ],
    ],
  };
}

// Запоминаем сообщение лида: исходный текст (для смены статуса) и связь с телефоном
// (чтобы «Удалить спам» мог снести все сообщения этого номера).
async function rememberLeadMessage(env, chatId, msgId, text, phone) {
  try {
    await env.PRODUCTS.put(
      `tg:lead:${chatId}:${msgId}`,
      JSON.stringify({ text, phone }),
      { expirationTtl: 60 * 60 * 24 * 60 }
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
    reply_markup: leadKeyboard(np, "new"),
  });

  if (!res || !res.ok) {
    return json({ success: false, error: "telegram_failed", detail: res && res.description }, 502, cors);
  }

  const m = res.result;
  if (m && m.chat && np) {
    await rememberLeadMessage(env, m.chat.id, m.message_id, text, np);
  }

  return json({ success: true, ok: true }, 200, cors);
}

// ==== Telegram webhook: обработка нажатий кнопок ======================
async function handleTgWebhook(request, env) {
  if (env.TG_WEBHOOK_SECRET) {
    const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!safeEqual(got, env.TG_WEBHOOK_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }
  }

  const update = await request.json().catch(() => null);
  const cq = update && update.callback_query;
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

  const setStatus = async (statusKey) => {
    const label = STATUS_LABEL[statusKey] || "";
    const newText = baseText + (label ? `\n\n<b>Статус:</b> ${label}` : "");
    await tgCall(env, "editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: newText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: leadKeyboard(phone, statusKey),
    });
  };

  try {
    if (action === "sa") { await setStatus("active"); await answer("Отмечено: в работе"); }
    else if (action === "sc") { await setStatus("closed"); await answer("Отмечено: закрыт"); }
    else if (action === "sr") { await setStatus("refused"); await answer("Отмечено: отказ"); }
    else if (action === "bl") {
      if (phone) await env.PRODUCTS.put(`tg:block:${phone}`, "1", { expirationTtl: 60 * 60 * 24 * 365 });
      await setStatus("blocked");
      await answer("Номер заблокирован — новые заявки с него не придут");
    } else if (action === "ub") {
      if (phone) await env.PRODUCTS.delete(`tg:block:${phone}`);
      await tgCall(env, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: baseText,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: leadKeyboard(phone, "new"),
      });
      await answer("Номер разблокирован");
    } else if (action === "dl") {
      let list = [];
      try { list = JSON.parse((await env.PRODUCTS.get(`tg:msgs:${phone}`)) || "[]"); } catch {}
      let n = 0;
      for (const it of list) {
        const r = await tgCall(env, "deleteMessage", { chat_id: it.c, message_id: it.m });
        if (r && r.ok) n++;
        try { await env.PRODUCTS.delete(`tg:lead:${it.c}:${it.m}`); } catch {}
      }
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
    // Комплектация и регион тоже правятся из CRM — канонизируем на входе.
    if (typeof ch.sim === "string" && ch.sim.trim()) p.sim = normSim(ch.sim) || "—";
    if (typeof ch.region === "string") p.region = ch.region.trim();
    applied++;
  }

  if (catalog.meta) catalog.meta.updatedAt = new Date().toISOString().slice(0, 10);
  await env.PRODUCTS.put(KV_KEY, JSON.stringify(catalog));
  return json({ ok: true, applied }, 200, cors);
}

// ======================================================================
// Синхронизация прайса из Telegram.
// ВАЖНО: cron НЕ пишет цены в каталог. Прайс берётся скрейпингом HTML-страницы
// t.me; одна ошибка разбора опубликовала бы неверную цену на живой витрине.
// Поэтому cron готовит ПРЕДЛОЖЕНИЯ, а применяет их человек через
// POST /api/admin/tg-apply со списком ids (страница /prices.html).
// ======================================================================
async function runTgSync(env, cronExpr, channelOverride, pagesOverride) {
  const startedAt = new Date().toISOString();
  const channel = channelOverride || env.TG_PRICE_CHANNEL || "OPTMSK77";
  const pages = Math.max(1, Math.min(30, parseInt(pagesOverride || env.TG_PRICE_PAGES || "5", 10) || 5));
  const log = { startedAt, cron: cronExpr || null, channel, pages, ok: false };

  try {
    const { offers, messages, pagesRead } = await fetchAndParseTgChannel(channel, pages);
    log.messages = messages;
    log.pagesRead = pagesRead;

    // Пустой результат — ОШИБКА, а не успех: иначе затрём валидный прайс.
    if (!offers.length) {
      throw new Error(`0 позиций с t.me/s/${channel} — канал закрыт, выключено веб-превью или изменилась вёрстка`);
    }

    const rawCat = await env.PRODUCTS.get(KV_KEY);
    if (!rawCat) throw new Error("catalog_not_seeded — сначала залейте каталог");
    const catalog = JSON.parse(rawCat);

    const result = buildProposals(offers, catalog);

    await env.PRODUCTS.put(TG_PRICES_KEY, JSON.stringify(offers));
    await env.PRODUCTS.put(TG_PROPOSALS_KEY, JSON.stringify({
      builtAt: new Date().toISOString(), channel, pagesRead, ...result,
    }));

    log.ok = true;
    log.stats = result.stats;
    log.finishedAt = new Date().toISOString();
    console.log(`[tg-sync] ok ${channel}: ${JSON.stringify(result.stats)}`);

    // Мало сопоставилось — первый признак, что у поставщика сменился формат.
    if (result.stats.parsed > 10 && result.stats.matchedLines / result.stats.parsed < 0.5) {
      await notifyOperator(env, `⚠️ Прайс @${channel}: сопоставлено ${result.stats.matchedLines} строк из ${result.stats.parsed}. Проверьте /prices.html`);
    }
  } catch (e) {
    log.error = String((e && e.message) || e).slice(0, 500);
    log.finishedAt = new Date().toISOString();
    console.error(`[tg-sync] FAIL (${channel}): ${log.error}`);
    await notifyOperator(env, `❌ Синхронизация прайса @${channel} упала: ${log.error}`);
  }

  try { await env.PRODUCTS.put(TG_SYNC_LOG_KEY, JSON.stringify(log)); } catch {}
  return log;
}

// Молча падающий cron — худший вариант: он выглядит работающим.
async function notifyOperator(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await tgCall(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true });
  } catch {}
}

// Применение выбранных предложений. Режима «применить всё» намеренно нет:
// оператор должен видеть, что именно применяет.
async function handleTgApply(request, env, cors) {
  const body = await request.json().catch(() => null);
  const ids = body && Array.isArray(body.ids) ? body.ids : null;
  if (!ids || !ids.length) {
    return json({ success: false, error: "ids_required" }, 400, cors);
  }

  const rawProp = await env.PRODUCTS.get(TG_PROPOSALS_KEY);
  if (!rawProp) return json({ success: false, error: "no_proposals" }, 409, cors);
  const stored = JSON.parse(rawProp);

  const rawCat = await env.PRODUCTS.get(KV_KEY);
  if (!rawCat) return json({ success: false, error: "catalog_not_seeded" }, 409, cors);

  // Бэкап до записи — цены откатываются через /api/admin/restore.
  await pushHistory(env, rawCat, `перед применением прайса (${ids.length})`);

  const overrides = body && body.prices && typeof body.prices === "object" ? body.prices : null;
  const ratio = Number(env.CARD_RATIO) > 1 ? Number(env.CARD_RATIO) : 1.15;
  const { catalog: next, applied, rejected } = applyProposals(
    JSON.parse(rawCat), stored.proposals || [], ids, overrides, ratio
  );
  await env.PRODUCTS.put(KV_KEY, JSON.stringify(next));

  const appliedSet = new Set(ids);
  const rest = (stored.proposals || []).filter((p) => !appliedSet.has(p.id));
  await env.PRODUCTS.put(TG_PROPOSALS_KEY, JSON.stringify({ ...stored, proposals: rest }));

  return json({ success: true, applied, rejected, remaining: rest.length }, 200, cors);
}

// ======================================================================
// Чтение канала через веб-превью t.me (бот и админ-права НЕ нужны).
//
// ГЛУБИНА ИСТОРИИ: одна страница t.me/s/<channel> отдаёт примерно 16–20
// последних сообщений. Чтобы уйти глубже, страница запрашивается с параметром
// ?before=<id>, где id — номер самого старого сообщения текущей страницы.
// Номер берётся из атрибута data-post="<channel>/<id>". Глубину задаёт
// TG_PRICE_PAGES (по умолчанию 5 ≈ 80–100 сообщений).
//
// Что стоит знать:
//   • страницы читаются последовательно, каждая — отдельный HTTP-запрос,
//     поэтому глубина стоит времени (у воркера ограничен CPU на запрос);
//   • обход прекращается, если страница не дала нового id — значит дошли до
//     начала канала либо изменилась вёрстка. Бесконечного цикла не будет;
//   • превью отдаёт ТЕКУЩУЮ версию сообщения, поэтому отредактированные
//     поставщиком цены подтянутся сами при следующем проходе.
// ======================================================================
async function fetchOnePage(channel, before) {
  const url = `https://t.me/s/${encodeURIComponent(channel)}${before ? `?before=${before}` : ""}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} на ${url}`);

  const messages = [];
  const ids = [];
  let buf = "";

  const rewriter = new HTMLRewriter()
    // Номера постов нужны для пагинации: data-post="channel/12345"
    .on(".tgme_widget_message", {
      element(el) {
        const dp = el.getAttribute("data-post");
        if (dp) {
          const n = parseInt(String(dp).split("/").pop(), 10);
          if (!isNaN(n)) ids.push(n);
        }
      },
    })
    .on(".tgme_widget_message_text", {
      element(el) {
        buf = "";
        el.onEndTag(() => {
          if (buf.trim()) messages.push(buf.trim());
        });
      },
      text(t) { buf += t.text; },
    })
    // В превью переводы строк — это <br>, иначе прайс склеится в одну строку.
    .on(".tgme_widget_message_text br", {
      element() { buf += "\n"; },
    });

  await rewriter.transform(res).text();
  return { messages, minId: ids.length ? Math.min(...ids) : null };
}

async function fetchAndParseTgChannel(channel = "OPTMSK77", maxPages = 5) {
  const allMessages = [];
  let before = null;
  let pagesRead = 0;
  const seenIds = new Set();

  for (let i = 0; i < maxPages; i++) {
    const { messages, minId } = await fetchOnePage(channel, before);
    pagesRead++;
    allMessages.push(...messages);
    if (minId == null || seenIds.has(minId)) break;
    seenIds.add(minId);
    before = minId;
  }

  // Разбор. Строка, которую парсер не принял, считается заголовком категории —
  // так прайс сам себя размечает («APPLE (iPhone 17 Pro)»).
  const items = [];
  let category = null;
  for (const text of allMessages) {
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const parsed = parseLine(line);
      if (parsed) items.push({ category, ...parsed });
      else category = line.replace(/[|•\-–—]+$/g, "").trim() || category;
    }
  }

  // Дедуп: поставщик повторяет позиции и внутри сообщения, и между сообщениями
  // (в реальном прайсе такое сплошь). При коллизии оставляем МЕНЬШУЮ цену.
  const dedup = new Map();
  for (const it of items) {
    const key = [it.model, it.storage, it.color, it.flag, it.sim].join("||");
    const prev = dedup.get(key);
    if (!prev || it.price < prev.price) dedup.set(key, it);
  }

  return { offers: [...dedup.values()], messages: allMessages.length, pagesRead };
}
