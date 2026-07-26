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

      // ---- CRM: обновление цен/статусов ----
      if (url.pathname === "/api/admin/update" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        return await handleUpdate(request, env, cors);
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
async function handleLead(request, env, cors) {
  const data = await request.json().catch(() => null);
  if (!data || !data.name || !data.phone) {
    return json({ error: "name_and_phone_required" }, 400, cors);
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

  const tgResp = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    }
  );

  if (!tgResp.ok) {
    const detail = await tgResp.text();
    return json({ error: "telegram_failed", detail }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
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
