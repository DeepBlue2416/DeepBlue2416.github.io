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
//   TG_PRICE_CHANNEL    — ПУБЛИЧНЫЙ канал для скрейпинга. Пусто или "off" —
//                         скрейпинг выключен, прайс принимается форвардами.
//   TG_PRICE_SENDERS    — user id через запятую, от кого бот принимает прайс
//                         форвардами. Пусто = приём выключен. Свой id: /id боту.
//   TG_PRICE_PAGES      — сколько страниц истории читать (по умолчанию 5)
//   SITE_URL, SHOP_NAME — для товарных фидов
//   CARD_RATIO          — цена по карте = наличные × это число (по умолчанию 1.15)
//   GH_DISPATCH_TOKEN   (секрет, опц.) — GitHub fine-grained token с правом
//                         Contents: Read and write на репозиторий сайта. Если
//                         задан, после каждого изменения каталога воркер просит
//                         GitHub пересобрать сайт: страницы товаров, заголовки
//                         в поиске и превью ссылок получают свежие цены.
//   GH_REPO             — owner/repo сайта (по умолчанию DeepBlue2416/DeepBlue2416.github.io)
// Binding KV: PRODUCTS. Ключ "catalog" хранит весь каталог.
//
// Cron: Settings → Trigger Events → Cron Triggers, например "0 5,11,15 * * *"
// (UTC; для Таганрога UTC+3 это 08:00 / 14:00 / 18:00).

import { parseLine, parseMessages } from "./tg-price-parse.js";
import { buildProposals, applyProposals } from "./tg-price-sync.js";
import { handleFeed } from "./tg-feeds.js";

const KV_KEY = "catalog";
const TG_PRICES_KEY = "parsed_tg_prices";
const TG_PROPOSALS_KEY = "tg_price_proposals";
const TG_SYNC_LOG_KEY = "tg_sync_log";
const REVIEWS_KEY = "reviews";

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
    // Скрейпинг веб-превью работает только с ПУБЛИЧНЫМ каналом. Если прайс
    // приходит форвардами (приватный канал поставщика), TG_PRICE_CHANNEL нужно
    // оставить пустым или поставить "off" — тогда cron ничего не делает и не
    // шлёт оператору ошибку каждые полчаса.
    const ch = String(env.TG_PRICE_CHANNEL || "").trim();
    if (!ch || ch.toLowerCase() === "off") {
      console.log("[tg-sync] скрейпинг выключен (TG_PRICE_CHANNEL пуст) — прайс принимается форвардами");
      return;
    }
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
        const chan = String(env.TG_PRICE_CHANNEL || "").trim();
        let st;
        try { st = raw ? JSON.parse(raw) : { ok: false, error: "cron ещё ни разу не запускался" }; }
        catch { st = { ok: false, error: "журнал синхронизации повреждён" }; }
        st.channelEnabled = !!chan && chan.toLowerCase() !== "off";
        return new Response(JSON.stringify(st), {
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
        const ch = (url.searchParams.get("channel") || env.TG_PRICE_CHANNEL || "").trim();
        if (!ch || ch.toLowerCase() === "off") {
          return json({
            success: false,
            error: "scraping_disabled",
            hint: "TG_PRICE_CHANNEL пуст или off. Скрейпинг доступен только для публичного канала; приватный присылайте форвардами боту.",
          }, 409, cors);
        }
        const log = await runTgSync(env, "manual", ch, url.searchParams.get("pages"));
        return json({ success: log.ok, ...log }, log.ok ? 200 : 502, cors);
      }

      // ---- Прайс, вставленный вручную ----
      // Нужен, когда канал поставщика приватный: страницы t.me/s/<channel> у
      // таких каналов не существует, и скрейпинг превью невозможен в принципе.
      // Оператор копирует сообщения из Telegram и вставляет текст — дальше всё
      // идёт тем же путём, что и при автоматической синхронизации.
      if (url.pathname === "/api/admin/tg-paste" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        return await handleTgPaste(request, env, cors);
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
        const catalog = JSON.parse(raw);

        // ?includeHidden=1 — полный каталог, включая скрытые позиции. Только
        // под токеном и только для CRM: иначе скрытые товары нельзя было бы
        // увидеть и вернуть в продажу — админка читает этот же эндпоинт.
        if (url.searchParams.get("includeHidden") === "1") {
          if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
          return json({ ...catalog, total: (catalog.products || []).length }, 200, cors);
        }

        if (![...url.searchParams.keys()].length) {
          // Раньше отдавали сырой JSON из KV одним куском. Теперь приходится
          // разобрать и собрать обратно, чтобы вырезать скрытые позиции:
          // витрина фильтрует на клиенте, но полагаться на это нельзя —
          // этот же ответ читают внешние интеграции.
          const visible = (catalog.products || []).filter((p) => !p.hidden);
          return json({ ...catalog, products: visible, total: visible.length }, 200, cors);
        }
        const filtered = filterProducts(catalog.products || [], url.searchParams);
        return json({ ...catalog, products: filtered, total: filtered.length }, 200, cors);
      }

      // ---- Витрина отзывов ----
      // Публично: список читают и сайт, и CRM. Роут был в более раннем
      // варианте воркера и потерялся при сборке — фронтенд его зовёт на каждой
      // загрузке страницы и получал 404 (видно в консоли браузера). Витрина при
      // этом падала на встроенный список из config.js, а правки из CRM
      // сохранить было нельзя вообще.
      if (url.pathname === "/api/reviews" && request.method === "GET") {
        const raw = await env.PRODUCTS.get(REVIEWS_KEY);
        // Пустое хранилище — не ошибка: фронтенд в этом случае берёт список из
        // config.js. Поэтому отдаём 200 с пустым массивом, а не 404.
        return new Response(raw || JSON.stringify({ sources: [] }), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // ---- CRM: сохранить витрину отзывов ----
      if (url.pathname === "/api/admin/reviews" && request.method === "POST") {
        if (!authorized(request, env)) return json({ success: false, error: "unauthorized" }, 401, cors);
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.sources)) {
          return json({ success: false, error: "bad_reviews" }, 400, cors);
        }
        // Чистим форму: наружу это отдаётся публично и вставляется в разметку,
        // поэтому храним только ожидаемые поля и ограничиваем длину.
        const clean = body.sources.slice(0, 20).map((s0) => ({
          name: String(s0 && s0.name || "").slice(0, 120),
          url: String(s0 && s0.url || "").slice(0, 500),
          widgetUrl: String(s0 && s0.widgetUrl || "").slice(0, 500),
          rating: String(s0 && s0.rating || "").slice(0, 10),
          count: String(s0 && s0.count || "").slice(0, 40),
          featured: Array.isArray(s0 && s0.featured)
            ? s0.featured.slice(0, 20).map((r) => ({
                author: String(r && r.author || "").slice(0, 120),
                date: String(r && r.date || "").slice(0, 40),
                rating: Math.max(1, Math.min(5, Math.round(Number(r && r.rating) || 5))),
                text: String(r && r.text || "").slice(0, 2000),
              }))
            : [],
        }));
        await env.PRODUCTS.put(REVIEWS_KEY, JSON.stringify({
          sources: clean,
          updatedAt: new Date().toISOString(),
        }));
        return json({ success: true, ok: true, count: clean.length }, 200, cors);
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
        await triggerRebuild(env);
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
        await triggerRebuild(env);
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
        await triggerRebuild(env);
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
  // Скрытые не отдаём наружу даже по прямому запросу с фильтрами.
  products = (products || []).filter((p) => !p.hidden);
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

  // Состояние: ?condition=new отдаёт только новые (поля condition нет),
  // ?condition=used|demo — соответствующие позиции. Те же правила, что на
  // витрине, иначе серверная выборка и клиентская разойдутся.
  const cond = q.get("condition");
  if (cond === "new") tests.push((p) => !p.condition);
  else if (cond) tests.push((p) => String(p.condition || "") === cond);

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
  // Имя не обязательно: чем меньше полей, тем больше заявок. Достаточно
  // телефона — по нему оператор и перезванивает.
  if (!data || !data.phone) {
    return json({ success: false, error: "phone_required" }, 400, cors);
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
  const name = String(data.name || "").slice(0, 120);
  const phone = String(data.phone).slice(0, 40);
  const comment = String(data.comment || "").slice(0, 1000);
  const product = String(data.product || "—").slice(0, 200);
  const price = String(data.price || "—").slice(0, 60);

  const text =
    `🛒 <b>Новая заявка с сайта</b>\n\n` +
    `📱 <b>Товар:</b> ${escapeHtml(product)}\n` +
    `💰 <b>Цена:</b> ${escapeHtml(price)}\n` +
    (name ? `👤 <b>Имя:</b> ${escapeHtml(name)}\n` : "") +
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

  // Обычные сообщения: приём прайса ФОРВАРДАМИ. Нужно потому, что канал
  // поставщика приватный — веб-превью t.me/s/<channel> у закрытых каналов
  // не существует, и скрейпить нечего. Оператор пересылает сообщения с
  // прайсом боту, бот их разбирает.
  if (update && update.message) {
    return await handlePriceMessage(update.message, env);
  }

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
  await triggerRebuild(env);
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
    // Каталог проверяем ПЕРВЫМ: без него сопоставлять не с чем, а чтение канала
    // это 5 HTTP-запросов. Раньше они делались впустую при каждом прогоне.
    const rawCat = await env.PRODUCTS.get(KV_KEY);
    if (!rawCat) throw new Error("catalog_not_seeded — сначала залейте каталог через /admin.html");
    const catalog = JSON.parse(rawCat);

    const { offers, messages, pagesRead } = await fetchAndParseTgChannel(channel, pages);
    log.messages = messages;
    log.pagesRead = pagesRead;

    // Пустой результат — ОШИБКА, а не успех: иначе затрём валидный прайс.
    if (!offers.length) {
      throw new Error(`0 позиций с t.me/s/${channel} — канал закрыт, выключено веб-превью или изменилась вёрстка`);
    }

    const result = buildProposals(offers, catalog);

    await env.PRODUCTS.put(TG_PRICES_KEY, JSON.stringify(offers));

    // Перезапись предложений затирает набор, который оператор может разбирать
    // прямо сейчас (галочки и ручные правки живут на странице). Поэтому если
    // предложения не изменились по сути — оставляем прежние и только обновляем
    // отметку времени. Сравниваем по составу id+цена, а не по всему JSON:
    // builtAt меняется всегда и сравнение стало бы бессмысленным.
    const fingerprint = (props) =>
      (props || []).map((x) => `${x.id}:${x.retail}`).sort().join("|");
    let prevPrint = "";
    try {
      const prevRaw = await env.PRODUCTS.get(TG_PROPOSALS_KEY);
      if (prevRaw) prevPrint = fingerprint(JSON.parse(prevRaw).proposals);
    } catch {}

    if (prevPrint && prevPrint === fingerprint(result.proposals)) {
      log.unchanged = true;
      console.log(`[tg-sync] прайс не изменился — предложения оставлены как есть`);
    } else {
      await env.PRODUCTS.put(TG_PROPOSALS_KEY, JSON.stringify({
        builtAt: new Date().toISOString(), channel, pagesRead, ...result,
      }));
    }

    log.ok = true;
    log.stats = result.stats;
    log.finishedAt = new Date().toISOString();
    console.log(`[tg-sync] ok ${channel}: ${JSON.stringify(result.stats)}`);

    // Мало сопоставилось — первый признак, что у поставщика сменился формат.
    if (result.stats.parsed > 10 && result.stats.matchedLines / result.stats.parsed < 0.5) {
      await notifyOperator(env, `⚠️ Прайс @${channel}: сопоставлено ${result.stats.matchedLines} строк из ${result.stats.parsed}. Проверьте /prices.html`, "lowmatch");
    }
  } catch (e) {
    log.error = String((e && e.message) || e).slice(0, 500);
    log.finishedAt = new Date().toISOString();
    console.error(`[tg-sync] FAIL (${channel}): ${log.error}`);
    await notifyOperator(env, `❌ Синхронизация прайса @${channel} упала: ${log.error}`, "fail:" + log.error.slice(0, 60));
  }

  try { await env.PRODUCTS.put(TG_SYNC_LOG_KEY, JSON.stringify(log)); } catch {}
  return log;
}

// Молча падающий cron — худший вариант: он выглядит работающим.
// dedupeKey — если передан, одинаковое сообщение не повторяется чаще, чем раз
// в NOTIFY_COOLDOWN. При cron раз в 30 минут одна и та же поломка иначе даёт
// 48 сообщений в сутки, и оператор перестаёт их читать.
const NOTIFY_COOLDOWN = 6 * 60 * 60 * 1000; // 6 часов

async function notifyOperator(env, text, dedupeKey) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  if (dedupeKey) {
    const k = `tg:notify:${dedupeKey}`;
    try {
      const last = await env.PRODUCTS.get(k);
      if (last && Date.now() - Number(last) < NOTIFY_COOLDOWN) return;
      await env.PRODUCTS.put(k, String(Date.now()), { expirationTtl: 60 * 60 * 24 });
    } catch {}
  }

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
  await triggerRebuild(env);

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

  return { offers: parseMessages(allMessages), messages: allMessages.length, pagesRead };
}

// Разбор набора сообщений в позиции прайса. Вынесено отдельно, потому что
// используется двумя путями: чтением канала и ручной вставкой текста.

// Ручная вставка прайса. Тот же разбор, сопоставление и проверки, что у cron —
// отличается только источником текста.
async function handleTgPaste(request, env, cors) {
  const body = await request.json().catch(() => null);
  const text = body && typeof body.text === "string" ? body.text : "";
  if (text.trim().length < 20) {
    return json({ success: false, error: "empty_text", hint: "вставьте текст прайса" }, 400, cors);
  }

  const rawCat = await env.PRODUCTS.get(KV_KEY);
  if (!rawCat) return json({ success: false, error: "catalog_not_seeded" }, 409, cors);

  // Текст приходит одним куском; разбиваем на «сообщения» по пустым строкам,
  // чтобы заголовки категорий работали так же, как при чтении канала.
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const offers = parseMessages(blocks.length ? blocks : [text]);

  if (!offers.length) {
    return json({ success: false, error: "nothing_parsed", hint: "ни одной строки с ценой не распознано" }, 422, cors);
  }

  const result = buildProposals(offers, JSON.parse(rawCat));
  await env.PRODUCTS.put(TG_PRICES_KEY, JSON.stringify(offers));
  await env.PRODUCTS.put(TG_PROPOSALS_KEY, JSON.stringify({
    builtAt: new Date().toISOString(), channel: "вставлено вручную", ...result,
  }));
  await env.PRODUCTS.put(TG_SYNC_LOG_KEY, JSON.stringify({
    startedAt: new Date().toISOString(), cron: null, channel: "вставлено вручную",
    ok: true, stats: result.stats, finishedAt: new Date().toISOString(),
  }));

  return json({ success: true, ...result.stats }, 200, cors);
}

// ======================================================================
// Приём прайса форвардами в Telegram.
//
// Почему так, а не скрейпингом: канал поставщика закрытый. У приватных каналов
// публичной веб-страницы t.me/s/<channel> нет, поэтому прежний путь возвращал
// 0 позиций. Здесь оператор пересылает сообщения боту — ни админ-прав в канале,
// ни участия бота в нём не требуется.
//
// ДОСТУП: только с user id из TG_PRICE_SENDERS (список через запятую). Если
// переменная пуста, приём выключен целиком — иначе любой, кто найдёт бота, смог
// бы подменить цены в каталоге. Узнать свой id: команда /id.
//
// КАК РАБОТАЕТ НАКОПЛЕНИЕ: поставщик присылает прайс пачкой сообщений (по
// одному на серию). Каждый форвард дописывается в буфер, и предложения
// пересобираются по ВСЕМУ буферу — так строки из разных сообщений видят друг
// друга при дедупликации. Буфер живёт BUFFER_TTL и начинается заново, если
// между форвардами прошло больше BUFFER_GAP: пачку за новый день не надо
// смешивать с прошлой.
//
// Команды (только для разрешённых отправителей):
//   /id     — показать свой user id и id чата (для настройки)
//   /reset  — очистить буфер и начать пачку заново
//   /status — что сейчас в буфере и что получилось сопоставить
// ======================================================================
const TG_BUFFER_KEY = "tg_price_buffer";
const BUFFER_TTL = 60 * 60 * 24 * 3;      // 3 суток
const BUFFER_GAP = 3 * 60 * 60 * 1000;    // 3 часа — признак новой пачки
const BUFFER_MAX = 200 * 1024;            // защита от случайной простыни

function priceSenders(env) {
  return String(env.TG_PRICE_SENDERS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function handlePriceMessage(msg, env) {
  const ok = () => new Response("ok");
  const from = msg.from && msg.from.id;
  const chatId = msg.chat && msg.chat.id;
  const text = msg.text || msg.caption || "";
  if (!chatId) return ok();

  const reply = async (t) => {
    await tgCall(env, "sendMessage", {
      chat_id: chatId,
      text: t,
      reply_parameters: { message_id: msg.message_id },
      disable_web_page_preview: true,
    });
  };

  // /id отвечаем всем: без него невозможно узнать, что вписать в
  // TG_PRICE_SENDERS. Ничего чувствительного команда не раскрывает —
  // свой собственный id отправитель и так может увидеть в любом боте.
  if (/^\/id\b/.test(text)) {
    await reply(`Ваш user id: ${from}\nid этого чата: ${chatId}\n\nВпишите user id в переменную TG_PRICE_SENDERS у воркера.`);
    return ok();
  }

  const allowed = priceSenders(env);
  if (!allowed.length) {
    // Молчим, а не объясняем: неизвестному собеседнику незачем знать,
    // что у бота вообще есть приём прайса.
    return ok();
  }
  if (!from || !allowed.includes(String(from))) return ok();

  if (/^\/reset\b/.test(text)) {
    await env.PRODUCTS.delete(TG_BUFFER_KEY);
    await reply("Буфер очищен. Пересылайте прайс заново.");
    return ok();
  }

  let buf = null;
  try {
    const raw = await env.PRODUCTS.get(TG_BUFFER_KEY);
    if (raw) buf = JSON.parse(raw);
  } catch {}

  if (/^\/status\b/.test(text)) {
    if (!buf || !buf.chunks || !buf.chunks.length) {
      await reply("Буфер пуст. Перешлите сообщения с прайсом.");
      return ok();
    }
    const st = buf.stats || {};
    await reply(
      `В буфере сообщений: ${buf.chunks.length}\n` +
      `Обновлён: ${new Date(buf.updatedAt).toLocaleString("ru-RU")}\n\n` +
      `Разобрано строк: ${st.parsed ?? "—"}\n` +
      `Сопоставлено: ${st.matchedLines ?? "—"}\n` +
      `Однозначных: ${st.applicable ?? "—"}\n` +
      `Требуют выбора: ${st.ambiguous ?? "—"}\n` +
      `Не сопоставлено: ${st.unmatched ?? "—"}`
    );
    return ok();
  }

  if (!text.trim()) return ok();
  // Служебные команды дальше не идут, чтобы не попасть в буфер как прайс.
  if (text.trim().startsWith("/")) return ok();

  // Новая пачка, если буфера нет или между форвардами был большой перерыв.
  const now = Date.now();
  if (!buf || !buf.chunks || now - (buf.updatedAt || 0) > BUFFER_GAP) {
    buf = { startedAt: now, chunks: [] };
  }

  // Повторный форвард того же сообщения не дублируем: оператор легко
  // пересылает одно и то же дважды, а в прайсе и без того много повторов.
  const origin = msg.forward_origin || {};
  const fid = [
    origin.chat && origin.chat.id,
    origin.message_id,
    origin.date || msg.forward_date || "",
  ].join(":");
  const seen = new Set(buf.chunks.map((c) => c.fid).filter(Boolean));
  if (fid !== "::" && seen.has(fid)) {
    await reply("Это сообщение уже в буфере — пропустил.");
    return ok();
  }

  buf.chunks.push({ fid: fid === "::" ? null : fid, text });
  buf.updatedAt = now;

  // Обрезаем старые куски, если оператор прислал слишком много.
  let total = buf.chunks.reduce((n, c) => n + c.text.length, 0);
  while (total > BUFFER_MAX && buf.chunks.length > 1) {
    total -= buf.chunks.shift().text.length;
  }

  // Разбор всего буфера.
  const catRaw = await env.PRODUCTS.get(KV_KEY);
  if (!catRaw) {
    await reply("Каталог не залит в хранилище — сначала сохраните его из /admin.html.");
    return ok();
  }
  const catalog = JSON.parse(catRaw);

  const offers = parseMessages(buf.chunks.map((c) => c.text));

  if (!offers.length) {
    await reply(
      `В сообщении не нашёл ни одной строки с ценой.\n` +
      `Ожидаю формат вида «iPhone 17 Pro 256GB Silver 🇯🇵 — 97 300».\n` +
      `Сообщений в буфере: ${buf.chunks.length}.`
    );
    await env.PRODUCTS.put(TG_BUFFER_KEY, JSON.stringify(buf), { expirationTtl: BUFFER_TTL });
    return ok();
  }

  const result = buildProposals(offers, catalog);
  buf.stats = result.stats;

  await env.PRODUCTS.put(TG_BUFFER_KEY, JSON.stringify(buf), { expirationTtl: BUFFER_TTL });
  await env.PRODUCTS.put(TG_PRICES_KEY, JSON.stringify(offers));
  await env.PRODUCTS.put(TG_PROPOSALS_KEY, JSON.stringify({
    builtAt: new Date().toISOString(),
    source: "forward",
    messages: buf.chunks.length,
    ...result,
  }));

  const st = result.stats;
  const site = env.SITE_URL || "";
  await reply(
    `Принято. Сообщений в пачке: ${buf.chunks.length}\n\n` +
    `Строк с ценой: ${st.parsed}\n` +
    `Сопоставлено: ${st.matchedLines}\n` +
    `Не сопоставлено: ${st.unmatched}\n\n` +
    `Предложений: ${st.proposals}\n` +
    `  однозначных: ${st.applicable}\n` +
    `  требуют выбора: ${st.ambiguous}\n` +
    `  заблокировано проверками: ${st.blocked}\n\n` +
    `Цены НЕ применены. Проверьте и примените: ${site}/prices.html\n` +
    `Продолжайте пересылать — пересоберу по всей пачке. /reset — начать заново.`
  );
  return ok();
}



// ---------------------------------------------------------------------------
// Пересборка сайта после изменения каталога (repository_dispatch → deploy.yml).
// Без GH_DISPATCH_TOKEN ничего не делает. Ошибка GitHub не мешает сохранению:
// каталог уже записан в KV, а ночная пересборка в deploy.yml всё равно догонит.
// Частые сохранения не страшны — в workflow стоит cancel-in-progress, и
// собирается последняя версия.
// ---------------------------------------------------------------------------
async function triggerRebuild(env) {
  const token = env && env.GH_DISPATCH_TOKEN;
  if (!token) return false;
  const repo = (env.GH_REPO || "DeepBlue2416/DeepBlue2416.github.io").trim();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "appleitochka-worker",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: "catalog-updated" }),
    });
    if (!r.ok) console.log("[rebuild] GitHub ответил", r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) {
    console.log("[rebuild] не удалось:", e && e.message);
    return false;
  } finally {
    clearTimeout(t);
  }
}
