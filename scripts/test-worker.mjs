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
await check("ВК: не больше 4 свойств у товара", async () => {
  const t = await (await worker.fetch(req("/feed/vk.yml"), ENV)).text();
  const mx = Math.max(...t.split("<offer ").slice(1).map((o) => (o.match(/<param /g) || []).length));
  if (mx > 4) throw new Error(`максимум ${mx}, лимит ВК — 4`);
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

console.log("\n" + "─".repeat(50));
console.log(`ПРОЙДЕНО: ${pass}   ПРОВАЛЕНО: ${fail}`);
if (tmeCalls) console.log(`(обращений к t.me: ${tmeCalls}, ответ подделан)`);
process.exit(fail ? 1 : 0);
