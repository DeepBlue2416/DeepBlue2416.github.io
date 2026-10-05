// Локальный прогон воркера БЕЗ Cloudflare и без сети.
//
// Зачем: задеплоенный воркер трогает живые цены и шлёт сообщения в Telegram.
// Проверять его «на бою» — плохая идея. Здесь поднимается тот же код с
// поддельными KV и fetch, так что можно прогнать все маршруты за секунду
// и убедиться, что деплой ничего не сломает.
//
// Что подделываем:
//   env.PRODUCTS  — KV в памяти (get/put/delete)
//   fetch к t.me  — отдаём сохранённый HTML из fixtures/ (см. --html)
//   fetch к Telegram API — заглушка, реальных сообщений НЕ шлём
//
// Запуск:
//   node scripts/test-worker.mjs
//   node scripts/test-worker.mjs --html fixtures/tme-page.html   # и парсер канала
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const htmlIdx = process.argv.indexOf("--html");
const HTML_FIXTURE = htmlIdx >= 0 ? process.argv[htmlIdx + 1] : null;

// ---- каталог для KV ----
global.window = {};
require(path.join(ROOT, "src/data/products.js"));
const CATALOG = global.window.__CATALOG__;

// ---- поддельный KV ----
function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
  };
}

// ---- подмена fetch ----
const realFetch = globalThis.fetch;
let tmeCalls = 0;
const vkSent = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    // Ничего не отправляем — возвращаем правдоподобный успех.
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1 } } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (u.includes("t.me/s/")) {
    tmeCalls++;
    if (!HTML_FIXTURE) return new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    return new Response(fs.readFileSync(path.join(ROOT, HTML_FIXTURE), "utf8"), {
      status: 200, headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (u.includes("api.vk.com")) {
    // Ответы бота ВКонтакте не уходят в сеть: складываем их для проверок.
    const p = new URLSearchParams(String(opts.body));
    vkSent.push({ peer: p.get("peer_id"), text: p.get("message"), keyboard: p.get("keyboard"), token: p.get("access_token") });
    return new Response(JSON.stringify({ response: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("challenges.cloudflare.com")) {
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }
  return realFetch ? realFetch(url, opts) : new Response("", { status: 404 });
};

// HTMLRewriter в Node отсутствует — если фикстуры нет, до него не дойдём.
if (typeof globalThis.HTMLRewriter === "undefined" && HTML_FIXTURE) {
  console.error("HTMLRewriter недоступен в Node — разбор канала проверяйте через");
  console.error("scripts/tg-price-report.mjs на текстовом дампе, либо в `wrangler dev`.");
  process.exit(1);
}

const TOKEN = "test-token-123";
const ENV = {
  PRODUCTS: makeKV(),
  ADMIN_TOKEN: TOKEN,
  ALLOWED_ORIGINS: "https://appleitochka.ru",
  TELEGRAM_BOT_TOKEN: "x",
  TELEGRAM_CHAT_ID: "1",
  SITE_URL: "https://appleitochka.ru",
  SHOP_NAME: "Apple и точка",
  CARD_RATIO: "1.15",
  TG_PRICE_SENDERS: "111222333,444555666",
  TG_WEBHOOK_SECRET: "hook-secret",
  VK_GROUP_ID: "777",
  VK_CONFIRM_CODE: "abc123",
  VK_CALLBACK_SECRET: "vk-secret",
  VK_GROUP_TOKEN: "vk-token",
};

const worker = (await import(path.join(ROOT, "worker/index.js"))).default;

const req = (p, opts = {}) =>
  new Request("https://api.test" + p, {
    method: opts.method || "GET",
    headers: Object.assign(
      { Origin: "https://appleitochka.ru" },
      opts.auth ? { Authorization: "Bearer " + TOKEN } : {},
      opts.body ? { "Content-Type": "application/json" } : {}
    ),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

let pass = 0, fail = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    fail++;
  }
}
const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what || ""}: ожидалось ${want}, получено ${got}`);
};

console.log("\n── БЕЗ КАТАЛОГА В KV ──");
await check("GET /api/products → 404 catalog_not_seeded", async () => {
  const r = await worker.fetch(req("/api/products"), ENV);
  eq(r.status, 404, "status");
});
await check("GET /api/tg-proposals без токена → 401", async () => {
  const r = await worker.fetch(req("/api/tg-proposals"), ENV);
  eq(r.status, 401, "status");
});
await check("GET /api/tg-sync-status доступен без токена", async () => {
  const r = await worker.fetch(req("/api/tg-sync-status"), ENV);
  eq(r.status, 200, "status");
});

console.log("\n── ЗАЛИВКА КАТАЛОГА ──");
await check("POST /api/admin/seed без токена → 401", async () => {
  const r = await worker.fetch(req("/api/admin/seed", { method: "POST", body: CATALOG }), ENV);
  eq(r.status, 401, "status");
});
await check("POST /api/admin/seed с токеном → ok", async () => {
  const r = await worker.fetch(req("/api/admin/seed", { method: "POST", body: CATALOG, auth: true }), ENV);
  const j = await r.json();
  eq(r.status, 200, "status");
  if (!j.count) throw new Error("не вернул count");
});
await check("seed канонизировал sim", async () => {
  const cat = JSON.parse(await ENV.PRODUCTS.get("catalog"));
  const bad = cat.products.filter((p) => /nano-?sim/i.test(String(p.sim)));
  eq(bad.length, 0, "сырых строк поставщика в KV");
});

console.log("\n── ФИЛЬТРАЦИЯ КАТАЛОГА ──");
const VISIBLE = CATALOG.products.filter((p) => !p.hidden).length;
const HIDDEN = CATALOG.products.length - VISIBLE;

await check("GET /api/products без параметров → только видимые", async () => {
  const r = await worker.fetch(req("/api/products"), ENV);
  const j = await r.json();
  // Скрытые позиции наружу не отдаются даже без query-параметров: этот ответ
  // читают не только витрина, но и внешние интеграции.
  eq(j.products.length, VISIBLE, "кол-во видимых SKU");
  eq(j.products.filter((p) => p.hidden).length, 0, "скрытых в ответе");
});
await check("?includeHidden=1 без токена → 401", async () => {
  const r = await worker.fetch(req("/api/products?includeHidden=1"), ENV);
  eq(r.status, 401, "status");
});
await check("?includeHidden=1 с токеном → полный каталог для CRM", async () => {
  const r = await worker.fetch(req("/api/products?includeHidden=1", { auth: true }), ENV);
  const j = await r.json();
  // Без этого скрытые позиции нельзя было бы вернуть в продажу: админка
  // читает тот же эндпоинт, что и витрина.
  eq(j.products.length, CATALOG.products.length, "кол-во всех SKU");
  if (HIDDEN) eq(j.products.filter((p) => p.hidden).length, HIDDEN, "скрытых в ответе");
});
await check("?simSlots=2&esim=1 → только версии /DS", async () => {
  const r = await worker.fetch(req("/api/products?simSlots=2&esim=1"), ENV);
  const j = await r.json();
  if (!j.products.length) throw new Error("пусто");
  const bad = j.products.filter((p) => p.sim !== "2 SIM + eSIM");
  eq(bad.length, 0, "лишних SKU");
});
await check("?simSlots=1,2 → объединение, а не пересечение", async () => {
  const one = await (await worker.fetch(req("/api/products?simSlots=1"), ENV)).json();
  const two = await (await worker.fetch(req("/api/products?simSlots=2"), ENV)).json();
  const both = await (await worker.fetch(req("/api/products?simSlots=1,2"), ENV)).json();
  eq(both.products.length, one.products.length + two.products.length, "сумма");
});
await check("?category=Samsung&simSlots=2&esim=1 → условия по И", async () => {
  const r = await worker.fetch(req("/api/products?category=Samsung&simSlots=2&esim=1"), ENV);
  const j = await r.json();
  const bad = j.products.filter((p) => p.category !== "Samsung");
  eq(bad.length, 0, "не-Samsung");
});

console.log("\n── ТОВАРНЫЕ ФИДЫ ──");
await check("GET /feed/vk.yml → XML", async () => {
  const r = await worker.fetch(req("/feed/vk.yml"), ENV);
  eq(r.status, 200, "status");
  const t = await r.text();
  if (!t.startsWith("<?xml")) throw new Error("не XML");
});
await check("ВК: фид проходит требования импорта товаров", async () => {
  const t = await (await worker.fetch(req("/feed/vk.yml"), ENV)).text();
  const offers = t.split("<offer ").slice(1);
  if (!offers.length) throw new Error("в фиде нет товаров");
  const mx = Math.max(...offers.map((o) => (o.match(/<param /g) || []).length));
  if (mx > 2) throw new Error(`свойств максимум ${mx}, лимит ВК — 2`);
  for (const tag of ["name", "description", "picture", "price"]) {
    const bad = offers.filter((o) => !new RegExp(`<${tag}>[^<]+</${tag}>`).test(o));
    if (bad.length) throw new Error(`без <${tag}>: ${bad.length} из ${offers.length}`);
  }
  const pics = [...t.matchAll(/<picture>([^<]+)<\/picture>/g)].map((m) => m[1]);
  const notJpg = pics.filter((u) => !/^https:\/\/appleitochka\.ru\/.+\.(jpe?g|png|gif)$/i.test(u));
  if (notJpg.length) throw new Error(`картинки не JPG/PNG/GIF: ${notJpg.length}, например ${notJpg[0]}`);
  const ids = offers.map((o) => o.match(/^id="([^"]+)"/)[1]);
  if (ids.some((i) => !/^\d{1,10}$/.test(i))) throw new Error("id не числовой: " + ids.find((i) => !/^\d{1,10}$/.test(i)));
  eq(new Set(ids).size, ids.length, "id уникальны");
  if (/рассрочк/i.test(t)) throw new Error("в фиде есть «рассрочка»");
});
await check("ВК: в описании аксессуаров нет гарантии, у наушников 3 месяца", async () => {
  const { vkDescription } = await import(path.join(ROOT, "worker/tg-feeds.js"));
  const d = (p) => vkDescription(Object.assign({ name: "X", status: "in_stock" }, p), "Apple и точка");
  if (/гарант/i.test(d({ category: "Аксессуары" }))) throw new Error("гарантия у аксессуара");
  if (!/3 месяца/.test(d({ category: "Наушники" }))) throw new Error("наушники");
  if (!/12 месяцев/.test(d({ category: "iPhone" }))) throw new Error("айфон");
  if (!/б\/у/.test(d({ category: "iPhone", condition: "used" })) || !/3 месяца/.test(d({ category: "iPhone", condition: "used" }))) throw new Error("б/у");
});
await check("Фиды не содержат позиций без цены", async () => {
  const t = await (await worker.fetch(req("/feed/vk.yml"), ENV)).text();
  if (/<price>0<\/price>/.test(t)) throw new Error("есть товар с ценой 0");
});
await check("GET /feed/2gis.csv → CSV с BOM", async () => {
  const r = await worker.fetch(req("/feed/2gis.csv"), ENV);
  // Проверяем БАЙТЫ, а не текст: Response.text() по спецификации Fetch срезает
  // ведущий BOM при UTF-8 декодировании, поэтому через .text() его не увидеть,
  // хотя в отдаваемом потоке он есть.
  const b = new Uint8Array(await r.arrayBuffer());
  if (!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)) {
    throw new Error("нет BOM — Excel на Windows сломает кириллицу");
  }
});
await check("GET /feed/unknown.yml → 404", async () => {
  const r = await worker.fetch(req("/feed/unknown.yml"), ENV);
  eq(r.status, 404, "status");
});

console.log("\n── ПРЕДЛОЖЕНИЯ ПО ЦЕНАМ ──");
await check("POST /api/admin/tg-apply без ids → 400", async () => {
  const r = await worker.fetch(req("/api/admin/tg-apply", { method: "POST", body: {}, auth: true }), ENV);
  eq(r.status, 400, "status");
});
await check("tg-apply без предложений в KV → 409", async () => {
  const r = await worker.fetch(req("/api/admin/tg-apply", { method: "POST", body: { ids: ["x"] }, auth: true }), ENV);
  eq(r.status, 409, "status");
});

// Кладём предложения вручную и проверяем применение + ручную правку.
const sample = CATALOG.products.filter((p) => p.priceCash > 0).slice(0, 3);
await ENV.PRODUCTS.put("tg_price_proposals", JSON.stringify({
  builtAt: new Date().toISOString(),
  proposals: [
    { id: sample[0].id, label: "A", retail: sample[0].priceCash + 1000, oldPrice: sample[0].priceCash, blocked: null },
    { id: sample[1].id, label: "B", retail: 5990, oldPrice: sample[1].priceCash, blocked: "цена ниже порога" },
    { id: sample[2].id, label: "C", retail: sample[2].priceCash + 500, oldPrice: sample[2].priceCash, blocked: null },
  ],
  unmatched: [], stats: {},
}));

await check("применяется только выбранное", async () => {
  const r = await worker.fetch(req("/api/admin/tg-apply", { method: "POST", body: { ids: [sample[0].id] }, auth: true }), ENV);
  const j = await r.json();
  eq(j.applied, 1, "applied");
  const cat = JSON.parse(await ENV.PRODUCTS.get("catalog"));
  eq(cat.products.find((p) => p.id === sample[0].id).priceCash, sample[0].priceCash + 1000, "цена A");
  eq(cat.products.find((p) => p.id === sample[2].id).priceCash, sample[2].priceCash, "цена C не тронута");
});
await check("priceCard пересчитан ×1.15, а не скопирован", async () => {
  const cat = JSON.parse(await ENV.PRODUCTS.get("catalog"));
  const p = cat.products.find((x) => x.id === sample[0].id);
  const want = Math.round((p.priceCash * 1.15) / 10) * 10;
  eq(p.priceCard, want, "priceCard");
});
await check("заблокированное не применяется без ручной правки", async () => {
  const r = await worker.fetch(req("/api/admin/tg-apply", { method: "POST", body: { ids: [sample[1].id] }, auth: true }), ENV);
  const j = await r.json();
  eq(j.applied, 0, "applied");
});
await check("ручная правка перебивает блокировку", async () => {
  await ENV.PRODUCTS.put("tg_price_proposals", JSON.stringify({
    proposals: [{ id: sample[1].id, label: "B", retail: 5990, oldPrice: sample[1].priceCash, blocked: "цена ниже порога" }],
    unmatched: [], stats: {},
  }));
  const r = await worker.fetch(req("/api/admin/tg-apply", {
    method: "POST", body: { ids: [sample[1].id], prices: { [sample[1].id]: 144490 } }, auth: true,
  }), ENV);
  const j = await r.json();
  eq(j.applied, 1, "applied");
  const cat = JSON.parse(await ENV.PRODUCTS.get("catalog"));
  eq(cat.products.find((p) => p.id === sample[1].id).priceCash, 144490, "цена B");
});
await check("абсурдная ручная цена отклоняется", async () => {
  await ENV.PRODUCTS.put("tg_price_proposals", JSON.stringify({
    proposals: [{ id: sample[2].id, label: "C", retail: sample[2].priceCash, oldPrice: sample[2].priceCash, blocked: null }],
    unmatched: [], stats: {},
  }));
  const r = await worker.fetch(req("/api/admin/tg-apply", {
    method: "POST", body: { ids: [sample[2].id], prices: { [sample[2].id]: 50 } }, auth: true,
  }), ENV);
  const j = await r.json();
  eq(j.applied, 0, "applied");
  if (!j.rejected || !j.rejected.length) throw new Error("нет rejected в ответе");
});
await check("перед применением создан бэкап в истории", async () => {
  const r = await worker.fetch(req("/api/admin/history", { auth: true }), ENV);
  const j = await r.json();
  if (!j.versions || !j.versions.length) throw new Error("история пуста");
});

console.log("\n── РУЧНАЯ ВСТАВКА ПРАЙСА ──");
const PASTE = fs.readFileSync(path.join(ROOT, "fixtures/optmsk77-2026-09-15.txt"), "utf8");
await check("POST /api/admin/tg-paste без токена → 401", async () => {
  const r = await worker.fetch(req("/api/admin/tg-paste", { method: "POST", body: { text: PASTE } }), ENV);
  eq(r.status, 401, "status");
});
await check("пустой текст → 400", async () => {
  const r = await worker.fetch(req("/api/admin/tg-paste", { method: "POST", body: { text: "  " }, auth: true }), ENV);
  eq(r.status, 400, "status");
});
await check("текст без цен → 422, предложения не затираются", async () => {
  const r = await worker.fetch(req("/api/admin/tg-paste", { method: "POST", body: { text: "просто какой-то текст без единой цены вообще" }, auth: true }), ENV);
  eq(r.status, 422, "status");
});
await check("реальный прайс → предложения созданы", async () => {
  const r = await worker.fetch(req("/api/admin/tg-paste", { method: "POST", body: { text: PASTE }, auth: true }), ENV);
  const j = await r.json();
  eq(r.status, 200, "status");
  if (!j.proposals) throw new Error("предложений 0");
  const stored = JSON.parse(await ENV.PRODUCTS.get("tg_price_proposals"));
  if (!stored.proposals.length) throw new Error("в KV ничего не записано");
  console.log(`      разобрано ${j.parsed}, сопоставлено строк ${j.matchedLines}, предложений ${j.proposals}, однозначных ${j.applicable}`);
});

console.log("\n── ОТЗЫВЫ ──");
await check("GET /api/reviews на пустом хранилище → 200 и пустой список", async () => {
  const r = await worker.fetch(req("/api/reviews"), ENV);
  eq(r.status, 200, "status");
  const j = await r.json();
  if (!Array.isArray(j.sources)) throw new Error("нет массива sources");
});
await check("POST /api/admin/reviews без токена → 401", async () => {
  const r = await worker.fetch(req("/api/admin/reviews", { method: "POST", body: { sources: [] } }), ENV);
  eq(r.status, 401, "status");
});
await check("POST /api/admin/reviews с мусором → 400", async () => {
  const r = await worker.fetch(req("/api/admin/reviews", { method: "POST", body: { nope: 1 }, auth: true }), ENV);
  eq(r.status, 400, "status");
});
await check("сохранение и чтение отзывов", async () => {
  const src = [{ name: "Яндекс Карты", url: "https://ya.ru", rating: "4,9", count: "42 отзыва",
                 featured: [{ author: "Иван", date: "12.09", rating: 5, text: "Всё быстро" }] }];
  const w = await worker.fetch(req("/api/admin/reviews", { method: "POST", body: { sources: src }, auth: true }), ENV);
  eq((await w.json()).count, 1, "сохранено источников");
  const j = await (await worker.fetch(req("/api/reviews"), ENV)).json();
  eq(j.sources[0].name, "Яндекс Карты", "название");
  eq(j.sources[0].featured[0].rating, 5, "оценка");
});
await check("лишние поля и перебор оценки отсекаются", async () => {
  const src = [{ name: "X", evil: "<script>", featured: [{ author: "A", rating: 99, text: "t" }] }];
  await worker.fetch(req("/api/admin/reviews", { method: "POST", body: { sources: src }, auth: true }), ENV);
  const j = await (await worker.fetch(req("/api/reviews"), ENV)).json();
  if ("evil" in j.sources[0]) throw new Error("лишнее поле сохранилось");
  eq(j.sources[0].featured[0].rating, 5, "оценка обрезана до 5");
});

console.log("\n── ЛИДЫ ──");
await check("POST /api/lead без телефона → 400", async () => {
  const r = await worker.fetch(req("/api/lead", { method: "POST", body: { name: "Иван" } }), ENV);
  eq(r.status, 400, "status");
});
await check("POST /api/lead корректный → ok (в Telegram ничего не ушло)", async () => {
  const r = await worker.fetch(req("/api/lead", { method: "POST", body: { name: "Иван", phone: "+79001234567" } }), ENV);
  const j = await r.json();
  eq(j.success, true, "success");
});

console.log("\n── СКРЕЙПИНГ КАНАЛА ──");
await check("без TG_PRICE_CHANNEL скрейпинг отключён → 409, а не падение", async () => {
  const r = await worker.fetch(req("/api/admin/sync-tg", { method: "POST", auth: true }), ENV);
  eq(r.status, 409, "status");
  const j = await r.json();
  eq(j.error, "scraping_disabled", "error");
});
await check("с публичным каналом: пустая страница → ошибка, прайс НЕ затирается", async () => {
  const env2 = { ...ENV, TG_PRICE_CHANNEL: "SOMEPUBLIC" };
  await env2.PRODUCTS.put("parsed_tg_prices", JSON.stringify([{ model: "старое", price: 1 }]));
  try { await worker.fetch(req("/api/admin/sync-tg", { method: "POST", auth: true }), env2); } catch {}
  const kept = JSON.parse(await env2.PRODUCTS.get("parsed_tg_prices"));
  if (!kept.length) throw new Error("прежний прайс затёрт пустым результатом");
});
await check("статус синхронизации записан с текстом ошибки", async () => {
  const r = await worker.fetch(req("/api/tg-sync-status"), ENV);
  const j = await r.json();
  if (j.ok !== false || !j.error) throw new Error("нет диагностики в логе");
});

console.log("\n── ПРИЁМ ПРАЙСА ФОРВАРДАМИ ──");
const hook = (message) =>
  new Request("https://api.test/api/tg/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify({ message }),
  });
const fwd = (text, userId, msgId = 1, originId = 1) => ({
  message_id: msgId,
  from: { id: userId },
  chat: { id: -100123 },
  text,
  forward_origin: { chat: { id: -1002496669874 }, message_id: originId, date: 1 },
});
const PRICE = [
  "APPLE (iPhone 17 Pro)",
  "iPhone 17 Pro 256GB Silver 🇯🇵 — 97 300",
  "iPhone 17 Pro 256GB Blue 🇯🇵 — 94 600",
].join("\n");

await check("неверный секрет вебхука → 403", async () => {
  const r = await worker.fetch(
    new Request("https://api.test/api/tg/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong" },
      body: JSON.stringify({ message: fwd(PRICE, 111222333) }),
    }),
    ENV
  );
  eq(r.status, 403, "status");
});
await check("форвард от ПОСТОРОННЕГО игнорируется", async () => {
  await ENV.PRODUCTS.delete("tg_price_proposals");
  await worker.fetch(hook(fwd(PRICE, 999999999)), ENV);
  const left = await ENV.PRODUCTS.get("tg_price_proposals");
  if (left) throw new Error("прайс от чужого пользователя был принят");
});
await check("приём выключен, если TG_PRICE_SENDERS пуст", async () => {
  const env3 = { ...ENV, TG_PRICE_SENDERS: "" };
  await env3.PRODUCTS.delete("tg_price_proposals");
  await worker.fetch(hook(fwd(PRICE, 111222333)), env3);
  if (await env3.PRODUCTS.get("tg_price_proposals")) throw new Error("принял при пустом списке");
});
await check("форвард от разрешённого → предложения собраны", async () => {
  await ENV.PRODUCTS.delete("tg_price_buffer");
  await ENV.PRODUCTS.delete("tg_price_proposals");
  const r = await worker.fetch(hook(fwd(PRICE, 111222333)), ENV);
  eq(r.status, 200, "status");
  const j = JSON.parse(await ENV.PRODUCTS.get("tg_price_proposals"));
  eq(j.source, "forward", "source");
  if (!j.proposals.length) throw new Error("предложений нет");
});
await check("цены в каталоге НЕ изменились сами", async () => {
  const cat = JSON.parse(await ENV.PRODUCTS.get("catalog"));
  const p = cat.products.find((x) => x.series === "iPhone 17 Pro" && x.storage === "256 ГБ");
  if (!p) throw new Error("не нашёл товар для сверки");
  const prop = JSON.parse(await ENV.PRODUCTS.get("tg_price_proposals")).proposals.find((x) => x.id === p.id);
  if (prop && prop.retail === p.priceCash && prop.oldPrice !== p.priceCash) {
    throw new Error("цена применилась без подтверждения");
  }
});
await check("повторный форвард того же сообщения не дублируется", async () => {
  const before = JSON.parse(await ENV.PRODUCTS.get("tg_price_buffer")).chunks.length;
  await worker.fetch(hook(fwd(PRICE, 111222333, 2, 1)), ENV);
  const after = JSON.parse(await ENV.PRODUCTS.get("tg_price_buffer")).chunks.length;
  eq(after, before, "размер буфера");
});
await check("вторая пачка накапливается, а не заменяет первую", async () => {
  const more = "iPhone 17 Pro 512GB Silver 🇯🇵 — 109 300";
  await worker.fetch(hook(fwd(more, 111222333, 3, 2)), ENV);
  const buf = JSON.parse(await ENV.PRODUCTS.get("tg_price_buffer"));
  eq(buf.chunks.length, 2, "сообщений в буфере");
  const j = JSON.parse(await ENV.PRODUCTS.get("tg_price_proposals"));
  if (j.stats.parsed < 3) throw new Error("строки первой пачки потерялись: " + j.stats.parsed);
});
await check("/reset очищает буфер", async () => {
  await worker.fetch(hook({ message_id: 9, from: { id: 111222333 }, chat: { id: -100123 }, text: "/reset" }), ENV);
  if (await ENV.PRODUCTS.get("tg_price_buffer")) throw new Error("буфер не очищен");
});
await check("текст без цен не ломает приём", async () => {
  const r = await worker.fetch(hook(fwd("Всем привет, отгрузка завтра", 111222333, 10, 77)), ENV);
  eq(r.status, 200, "status");
});

await check("флаг задал SIM, а такой комплектации нет — строка не подставляется в соседний вариант", async () => {
  const { buildProposals } = await import(path.join(ROOT, "worker/tg-price-sync.js"));
  const cat = { products: [
    { id: "b-sim", brand: "Apple", series: "iPhone 17", storage: "256 ГБ", color: "Голубой", sim: "SIM + eSIM", priceCash: 83490 },
  ] };
  const { parseMessages } = await import(path.join(ROOT, "worker/tg-price-parse.js"));
  const r = buildProposals(parseMessages(["IPHONE 17\n17 256GB Blue 🇯🇵 — 77 400\n17 256GB Blue 🇮🇳 — 79 300"]), cat);
  eq(r.proposals.length, 1, "предложений");
  eq(r.proposals[0].supplier, 79300, "закупка должна быть индийская");
  eq(r.proposals[0].duplicates, 1, "дублей");
  eq(r.unmatched.length, 1, "японская строка в несопоставленных");
});
await check("скрытый вариант 2 eSIM не отдаёт цену видимому SIM + eSIM", async () => {
  const { buildProposals } = await import(path.join(ROOT, "worker/tg-price-sync.js"));
  const { parseMessages } = await import(path.join(ROOT, "worker/tg-price-parse.js"));
  const cat = { products: [
    { id: "b-sim", brand: "Apple", series: "iPhone 17", storage: "256 ГБ", color: "Голубой", sim: "SIM + eSIM", priceCash: 83490 },
    { id: "b-esim", brand: "Apple", series: "iPhone 17", storage: "256 ГБ", color: "Голубой", sim: "2 eSIM", priceCash: 83490, hidden: true },
  ] };
  const r = buildProposals(parseMessages(["IPHONE 17\n17 256GB Blue 🇯🇵 — 77 400\n17 256GB Blue 🇮🇳 — 79 300"]), cat);
  eq(r.proposals.length, 1, "предложений");
  eq(r.proposals[0].id, "b-sim", "id");
  eq(r.proposals[0].supplier, 79300, "закупка");
  if (!/скрыт/.test(r.unmatched[0]?.reason || "")) throw new Error("причина: " + r.unmatched[0]?.reason);
});
await check("прайс на iPhone 18 Pro сопоставляется с каталогом", async () => {
  const { buildProposals } = await import(path.join(ROOT, "worker/tg-price-sync.js"));
  const { parseMessages } = await import(path.join(ROOT, "worker/tg-price-parse.js"));
  const msg = [
    "IPHONE 18 PRO",
    "iPhone 18 Pro 512 Glacier 🇭🇰 — 176 000",
    "18 pro max 1TB Black 🇭🇰 — 249 000",
  ].join("\n");
  const r = buildProposals(parseMessages([msg]), CATALOG);
  eq(r.stats.unmatched, 0, "несопоставленных");
  eq(r.proposals.length, 2, "предложений");
  const max = r.proposals.find((p) => /1 ТБ/.test(p.label));
  eq(max.retail, 253990, "розница 1 ТБ");
  eq(max.sim, "SIM + eSIM", "комплектация");
});

// ---------------------------------------------------------------------------
// Второй поставщик (прайс от 05.10.2026): формат «256Gb», «₽», «(Dual-Sim + E-Sim)»
// ---------------------------------------------------------------------------
await check("прайс второго поставщика: разобраны все товарные строки", async () => {
  const { parseMessages, parseLine } = await import(path.join(ROOT, "worker/tg-price-parse.js"));
  const text = fs.readFileSync(path.join(ROOT, "fixtures/supplier2-2026-10-05.txt"), "utf8");
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => /₽$/.test(l));
  eq(lines.filter((l) => !parseLine(l)).length, 0, "неразобранных строк с ценой");
  const items = parseMessages([text]);
  eq(items.length, lines.length, "позиций");
  const air = items.find((i) => /17 Air/.test(i.model) && i.storage === "1 ТБ" && i.color === "Black");
  eq(air.price, 89400, "цена iPhone 17 Air 1Tb Black");
  const dual = items.find((i) => i.sim === "2 SIM + eSIM");
  eq(dual.model, "iPhone 18 Pro Max", "модель без скобок от (Dual-Sim + E-Sim)");
  eq(dual.flag, "🇨🇳", "флаг");
});
await check("выброс внутри прайса блокируется и не вытесняет нормальную строку", async () => {
  const { buildProposals } = await import(path.join(ROOT, "worker/tg-price-sync.js"));
  const { parseMessages } = await import(path.join(ROOT, "worker/tg-price-parse.js"));
  const mk = (id, color) => ({ id, brand: "Apple", series: "iPhone 18 Pro Max", storage: "1 ТБ", color, sim: "SIM + eSIM", priceCash: 0 });
  const cat = { products: [mk("b", "Чёрный"), mk("u", "Бордовый"), mk("g", "Ледниковый"), mk("s", "Серебристый")] };
  const msg = [
    "iPhone 18 Pro Max",
    "iPhone 18 Pro Max 1Tb Black 🇭🇰 – 192 400 ₽",
    "iPhone 18 Pro Max 1Tb Burgundy 🇰🇷 – 21 000 ₽",
    "iPhone 18 Pro Max 1Tb Burgundy 🇭🇰 – 194 400 ₽",
    "iPhone 18 Pro Max 1Tb Glacier 🇪🇺 – 190 400 ₽",
    "iPhone 18 Pro Max 1Tb Silver 🇪🇺 – 190 400 ₽",
  ].join("\n");
  const r = buildProposals(parseMessages([msg]), cat);
  const u = r.proposals.find((p) => p.id === "u");
  eq(u.supplier, 194400, "у бордового осталась нормальная закупка");
  eq(u.blocked, null, "нормальная строка не заблокирована");
  eq(u.duplicates, 2, "дубль учтён");
  // Тот же выброс без нормальной пары: цена не должна пройти даже на позицию без старой цены.
  const r2 = buildProposals(parseMessages([msg.replace("iPhone 18 Pro Max 1Tb Burgundy 🇭🇰 – 194 400 ₽\n", "")]), cat);
  const u2 = r2.proposals.find((p) => p.id === "u");
  if (!/ниже остальных строк/.test(u2.blocked || "")) throw new Error("выброс не заблокирован: " + u2.blocked);
});
await check("новые флаги: 🇪🇺 и 🇮🇩 дают SIM + eSIM, 🇷🇺 уходит на ручной выбор", async () => {
  const { simFor } = await import(path.join(ROOT, "worker/tg-price-sync.js"));
  eq(simFor({ flag: "🇪🇺" }, "Apple", "iPhone 17 Pro"), "SIM + eSIM", "🇪🇺 17 Pro");
  eq(simFor({ flag: "🇮🇩" }, "Apple", "iPhone 16 Pro Max"), "SIM + eSIM", "🇮🇩 16 Pro Max");
  eq(simFor({ flag: "🇨🇦" }, "Apple", "iPhone 16 Pro"), "SIM + eSIM", "🇨🇦 16 Pro");
  eq(simFor({ flag: "🇨🇦" }, "Apple", "iPhone 17 Pro"), "2 eSIM", "🇨🇦 17 Pro");
  eq(simFor({ flag: "🇷🇺" }, "Apple", "iPhone 16 Pro"), null, "🇷🇺");
});

await check("недостающие варианты из прайса: план по фикстуре второго поставщика", async () => {
  const { planNewVariants, addVariants, buildProposals } = await import(path.join(ROOT, "worker/tg-price-sync.js"));
  const { parseMessages } = await import(path.join(ROOT, "worker/tg-price-parse.js"));
  const offers = parseMessages([fs.readFileSync(path.join(ROOT, "fixtures/supplier2-2026-10-05.txt"), "utf8")]);
  const before = buildProposals(offers, CATALOG);
  const plan = planNewVariants(offers, CATALOG);
  const find = (label, sim) => plan.add.find((x) => x.label === label && x.product.sim === sim);
  // Японский iPhone 18 Pro: 107 100 + 5 000 → 111 990, комплектация без лотка.
  const jp = find("iPhone 18 Pro 256 ГБ Ледниковый", "2 eSIM");
  eq(jp.product.priceCash, 111990, "цена японского 18 Pro 256 Glacier");
  eq(jp.product.specs["Формат SIM-карт"], "eSIM", "характеристика SIM");
  eq(jp.product.status, "preorder", "статус как у образца");
  eq(jp.product.priceEstimated, undefined, "пометка «ориентировочная» снята");
  // Китайский 16 Pro с двумя SIM.
  const cn = find("iPhone 16 Pro 128 ГБ Белый титан", "2 SIM");
  eq(cn.product.priceCash, 89990, "цена китайского 16 Pro 128 White");
  eq(cn.product.specs["Поддержка eSIM"], "нет", "eSIM у версии с двумя SIM");
  // Новый объём: образец берётся с ближайшего объёма того же цвета.
  const tb2 = find("iPhone 18 Pro 2 ТБ Ледниковый", "SIM + eSIM");
  eq(tb2.product.specs["Встроенная память"], "2 ТБ", "память в характеристиках");
  const tpl = CATALOG.products.find((p) => p.series === "iPhone 18 Pro" && p.color === "Ледниковый" && p.storage === "1 ТБ");
  eq(JSON.stringify(tb2.product.images), JSON.stringify(tpl.images), "фото как у ближайшего объёма того же цвета");
  if (!find("iPhone 18 Pro Max 256 ГБ Бордовый", "2 SIM + eSIM")) throw new Error("нет варианта Dual-Sim + E-Sim");
  // Чего быть не должно: строки 🇷🇺 и выбросы.
  if (plan.add.some((x) => /🇷🇺/.test(x.sourceLine || "") || x.supplier < 40000)) throw new Error("в план попала подозрительная строка");
  eq(new Set(plan.add.map((x) => x.product.id)).size, plan.add.length, "id уникальны");
  eq(plan.add.some((x) => CATALOG.products.some((p) => p.id === x.product.id)), false, "id не совпадают с существующими");
  // После добавления строки сопоставляются, а цена уже стоит: новых предложений по ним нет.
  const { catalog: next, added } = addVariants(CATALOG, plan);
  eq(added, plan.add.length, "добавлено");
  const after = buildProposals(offers, next);
  if (!(after.stats.unmatched < before.stats.unmatched - 30)) throw new Error(`несопоставленных было ${before.stats.unmatched}, стало ${after.stats.unmatched}`);
  eq(planNewVariants(offers, next).add.length, 0, "повторный запуск ничего не добавляет");
  const i = next.products.findIndex((p) => p.id === jp.product.id);
  eq(next.products[i - 1].series, "iPhone 18 Pro", "вариант стоит рядом со своей моделью");
});
await check("POST /api/admin/tg-add-variants: dryRun не пишет, без него добавляет и бэкапит", async () => {
  const text = fs.readFileSync(path.join(ROOT, "fixtures/supplier2-2026-10-05.txt"), "utf8");
  await worker.fetch(req("/api/admin/tg-paste", { method: "POST", auth: true, body: { text } }), ENV);
  eq((await worker.fetch(req("/api/admin/tg-add-variants", { method: "POST", body: {} }), ENV)).status, 401, "без токена");
  const n0 = JSON.parse(await ENV.PRODUCTS.get("catalog")).products.length;
  const dry = await (await worker.fetch(req("/api/admin/tg-add-variants", { method: "POST", auth: true, body: { dryRun: true } }), ENV)).json();
  eq(JSON.parse(await ENV.PRODUCTS.get("catalog")).products.length, n0, "dryRun не изменил каталог");
  if (!(dry.add.length > 30)) throw new Error("в плане " + dry.add.length);
  const res = await (await worker.fetch(req("/api/admin/tg-add-variants", { method: "POST", auth: true, body: {} }), ENV)).json();
  eq(res.added, dry.add.length, "добавлено");
  eq(JSON.parse(await ENV.PRODUCTS.get("catalog")).products.length, n0 + res.added, "товаров в каталоге");
  const hist = JSON.parse(await ENV.PRODUCTS.get("cat:hist:index"));
  if (!/добавлением вариантов/.test(hist[0].note)) throw new Error("нет бэкапа: " + hist[0].note);
  const pub = await (await worker.fetch(req("/api/products"), ENV)).json();
  const list = pub.products || pub;
  if (!list.some((p) => p.series === "iPhone 18 Pro" && p.sim === "2 eSIM" && p.priceCash > 0)) throw new Error("новый вариант не виден на витрине");
});

// ---------------------------------------------------------------------------
// Автоответчик ВКонтакте
// ---------------------------------------------------------------------------
const vkReq = (body, headers = {}) =>
  new Request("https://api.test/api/vk/callback", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers),
    body: JSON.stringify(Object.assign({ group_id: 777, secret: "vk-secret" }, body)),
  });
const vkMsg = (peer, text, payload) => vkReq({ type: "message_new", object: { message: { from_id: peer, peer_id: peer, text, payload } } });
const vkAsk = async (peer, text, payload) => {
  const before = vkSent.length;
  const r = await worker.fetch(vkMsg(peer, text, payload), ENV);
  eq(await r.text(), "ok", "ответ ВКонтакте");
  return vkSent.slice(before);
};

await check("ВК: подтверждение адреса сервера", async () => {
  const r = await worker.fetch(vkReq({ type: "confirmation" }), ENV);
  eq(await r.text(), "abc123", "строка подтверждения");
});
await check("ВК: чужое сообщество и неверный секрет отклоняются", async () => {
  eq((await worker.fetch(vkReq({ type: "message_new", group_id: 1, object: {} }), ENV)).status, 403, "чужая группа");
  const before = vkSent.length;
  eq((await worker.fetch(vkReq({ type: "message_new", secret: "nope", object: { message: { from_id: 5, peer_id: 5, text: "айфон 17" } } }), ENV)).status, 403, "секрет");
  eq(vkSent.length, before, "ничего не отправлено");
});
await check("ВК: кнопка «Начать» → приветствие с кнопками моделей", async () => {
  const out = await vkAsk(101, "Начать", JSON.stringify({ command: "start" }));
  eq(out.length, 1, "сообщений");
  if (!/Напишите модель/.test(out[0].text)) throw new Error(out[0].text);
  const kb = JSON.parse(out[0].keyboard);
  const labels = kb.buttons.flat().map((b) => b.action.label);
  if (!labels.includes("Трейд-ин") || !labels.some((l) => /^iPhone/.test(l))) throw new Error(labels.join(", "));
  eq(out[0].token, "vk-token", "ключ доступа");
});
await check("ВК: «сколько стоит айфон 17 про 256» → цена именно этой модели и объёма", async () => {
  const out = await vkAsk(102, "Здравствуйте, сколько стоит айфон 17 про 256?");
  const t = out[0].text;
  if (!/^iPhone 17 Pro, цены/.test(t)) throw new Error(t);
  if (!/256 ГБ: (от )?\d/.test(t)) throw new Error("нет строки 256 ГБ: " + t);
  if (/512 ГБ|1 ТБ/.test(t)) throw new Error("лишние объёмы: " + t);
  if (!t.includes("https://appleitochka.ru/catalog/iphone/iphone-17-pro/")) throw new Error("нет ссылки: " + t);
  if (/рассрочк/i.test(t)) throw new Error("рассрочку не обещаем");
  // Цена в ответе равна минимальной розничной по каталогу.
  const min = Math.min(...CATALOG.products.filter((p) => p.series === "iPhone 17 Pro" && p.storage === "256 ГБ" && !p.hidden && p.priceCash > 0).map((p) => p.priceCash));
  if (!t.includes(String(min).replace(/\B(?=(\d{3})+(?!\d))/g, " "))) throw new Error(`нет цены ${min}: ${t}`);
});
await check("ВК: разбор моделей в свободном тексте", async () => {
  const { vkAnswer } = await import(path.join(ROOT, "worker/vk-bot.js"));
  const series = (q) => { const a = vkAnswer(q, null, CATALOG, {}); return a.kind === "price" ? a.series : a.kind; };
  eq(series("17 про макс 512"), "iPhone 17 Pro Max", "17 про макс");
  eq(series("Айфон 17"), "iPhone 17", "айфон 17");
  eq(series("айфон 16е цена"), "iPhone 16e", "16е");
  eq(series("iphone 17 air"), "iPhone Air", "17 air");
  eq(series("расскажите про айфон 17"), "iPhone 17", "«про» как предлог");
  eq(series("сколько стоит 18 pro"), "iPhone 18 Pro", "18 pro без слова айфон");
  eq(series("галакси с26 ультра"), "Galaxy S26 Ultra", "с26 ультра");
  eq(series("макбук эйр 13"), "MacBook Air 13 M3", "макбук эйр 13");
  eq(series("аирподс про 3"), "AirPods Pro 3", "аирподс про 3");
  eq(series("могу подойти в 16 часов?"), "stub", "цифра в обычной фразе");
  eq(series("сколько стоит айфон?"), "list", "только вид техники");
  eq(series("есть рассрочка?"), "info", "рассрочка");
  if (!/Рассрочки у нас нет/.test(vkAnswer("есть рассрочка?", null, CATALOG, {}).text)) throw new Error("ответ про рассрочку");
  eq(series("Адрес и часы работы"), "info", "кнопка адреса");
  // Скрытые и б/у позиции бот не называет.
  const cat = { products: [
    { id: "a", category: "iPhone", series: "iPhone 15", storage: "128 ГБ", priceCash: 50990, hidden: true },
    { id: "b", category: "iPhone", series: "iPhone 14", storage: "128 ГБ", priceCash: 30990, condition: "used" },
  ] };
  eq(vkAnswer("айфон 15", null, cat, {}).kind, "stub", "скрытая модель");
  eq(vkAnswer("айфон 14", null, cat, {}).kind, "stub", "б/у модель");
});
await check("ВК: заглушка не повторяется, а ответ с ценой приходит", async () => {
  eq((await vkAsk(103, "а вы завтра будете?")).length, 1, "первая заглушка");
  eq((await vkAsk(103, "ау")).length, 0, "вторая заглушка подряд");
  eq((await vkAsk(103, "айфон 17 про макс")).length, 1, "вопрос о модели");
});
await check("ВК: после ответа продавца бот молчит", async () => {
  eq((await vkAsk(104, "айфон 17")).length, 1, "до продавца");
  // Эхо собственного ответа бота не считается продавцом.
  await worker.fetch(vkReq({ type: "message_reply", object: { peer_id: 104, from_id: -777, text: "..." } }), ENV);
  eq((await vkAsk(104, "айфон 17 про")).length, 1, "после эха бота");
  await worker.fetch(vkReq({ type: "message_reply", object: { peer_id: 104, from_id: -777, admin_author_id: 42, text: "Добрый день!" } }), ENV);
  eq((await vkAsk(104, "айфон 17 про макс")).length, 0, "после продавца");
});
await check("ВК: повтор события и беседы игнорируются, VK_BOT=off выключает ответы", async () => {
  const before = vkSent.length;
  await worker.fetch(new Request("https://api.test/api/vk/callback", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Retry-Counter": "1" },
    body: JSON.stringify({ type: "message_new", group_id: 777, secret: "vk-secret", object: { message: { from_id: 105, peer_id: 105, text: "айфон 17" } } }),
  }), ENV);
  await worker.fetch(vkReq({ type: "message_new", object: { message: { from_id: 105, peer_id: 2000000001, text: "айфон 17" } } }), ENV);
  ENV.VK_BOT = "off";
  await worker.fetch(vkMsg(106, "айфон 17"), ENV);
  delete ENV.VK_BOT;
  eq(vkSent.length, before, "ничего не отправлено");
});
await check("ВК: в ответах нет закупочных цен из прайса", async () => {
  const supplier = JSON.parse((await ENV.PRODUCTS.get("parsed_tg_prices")) || "[]").map((o) => o.price);
  const all = vkSent.map((m) => m.text).join("\n").replace(/\s(?=\d{3}\b)/g, "");
  const leaked = supplier.filter((p) => p % 1000 !== 990 && all.includes(String(p)));
  eq(leaked.length, 0, "закупочных цен в ответах");
});
console.log("\n" + "─".repeat(50));
console.log(`ПРОЙДЕНО: ${pass}   ПРОВАЛЕНО: ${fail}`);
if (tmeCalls) console.log(`(обращений к t.me: ${tmeCalls}, ответ подделан)`);
process.exit(fail ? 1 : 0);
