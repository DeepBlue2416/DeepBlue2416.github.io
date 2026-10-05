// Безопасная правка ВАШЕГО worker/index.js: добавляет фильтрацию каталога,
// канонизацию SIM и cron-синхронизацию прайса из Telegram.
//
// Почему кодмод, а не готовый файл: ваш задеплоенный воркер содержит код,
// которого нет ни в одном присланном архиве (TG-парсер, управление лидами).
// Переписывать его руками = риск тихой опечатки в обработке заявок. Скрипт
// вставляет только новое, ищет точные якоря и ПРЕРЫВАЕТСЯ, если якорь не найден
// или правка уже применена — ничего не портит и безопасен к повторному запуску.
//
// Запуск:
//   node scripts/patch-worker.cjs worker/index.js            # проверить (dry-run)
//   node scripts/patch-worker.cjs worker/index.js --write     # применить
const fs = require("fs");

const file = process.argv[2];
const WRITE = process.argv.includes("--write");
if (!file) {
  console.error("Использование: node scripts/patch-worker.cjs <путь к worker/index.js> [--write]");
  process.exit(1);
}
let src = fs.readFileSync(file, "utf8");
const before = src;
const done = [], skipped = [], failed = [];

function edit(name, anchor, replacement, alreadyMarker) {
  if (alreadyMarker && src.includes(alreadyMarker)) { skipped.push(`${name} — уже применено`); return; }
  const n = src.split(anchor).length - 1;
  if (n === 0) { failed.push(`${name} — якорь не найден`); return; }
  if (n > 1) { failed.push(`${name} — якорь встречается ${n} раз, неоднозначно`); return; }
  src = src.replace(anchor, replacement);
  done.push(name);
}

// ---------------------------------------------------------------------------
// 1. Импорты модулей прайса
// ---------------------------------------------------------------------------
edit(
  "импорты tg-price-*",
  'const KV_KEY = "catalog";',
  `import { parseLine } from "./tg-price-parse.js";
import { buildProposals, applyProposals } from "./tg-price-sync.js";

const KV_KEY = "catalog";`,
  'from "./tg-price-parse.js"'
);

// ---------------------------------------------------------------------------
// 2. Ключи KV для предложений и лога синхронизации
// ---------------------------------------------------------------------------
edit(
  "ключи KV",
  'const TG_PRICES_KEY = "parsed_tg_prices";',
  `const TG_PRICES_KEY = "parsed_tg_prices";
const TG_PROPOSALS_KEY = "tg_price_proposals";
const TG_SYNC_LOG_KEY = "tg_sync_log";`,
  "TG_PROPOSALS_KEY"
);

// ---------------------------------------------------------------------------
// 3. scheduled() — то, без чего cron вообще не вызывается
// ---------------------------------------------------------------------------
edit(
  "handler scheduled()",
  `export default {
  async fetch(request, env) {`,
  `export default {
  // Cron Triggers вызывают ИМЕННО scheduled(), а не fetch(). Пока этого метода
  // не было, расписание срабатывало «в пустоту»: Cloudflare писал в логи
  // «Handler does not export a scheduled() function».
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTgSync(env, event.cron));
  },

  async fetch(request, env) {`,
  "async scheduled(event, env, ctx)"
);

// ---------------------------------------------------------------------------
// 4. Фильтрация каталога на сервере (?simSlots=2&esim=1 и др.)
// ---------------------------------------------------------------------------
edit(
  "серверная фильтрация /api/products",
  `        return new Response(raw, {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // ---- Приём лида -> Telegram ----`,
  `        // Без query-параметров — прежнее поведение: каталог целиком (витрина
        // фильтрует на клиенте). С параметрами — фильтруем на сервере теми же
        // ортогональными правилами: ?simSlots=2&esim=1, ?simSlots=1,2,
        // ?category=&series=&storage=&color=&region=
        if (![...url.searchParams.keys()].length) {
          return new Response(raw, {
            status: 200,
            headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        }
        const catalog0 = JSON.parse(raw);
        const filtered = filterProducts(catalog0.products || [], url.searchParams);
        return json({ ...catalog0, products: filtered, total: filtered.length }, 200, cors);
      }

      // ---- Приём лида -> Telegram ----`,
  "filterProducts(catalog0.products"
);

// ---------------------------------------------------------------------------
// 5. Канонизация SIM при записи в KV
// ---------------------------------------------------------------------------
edit(
  "канонизация SIM в /api/admin/seed",
  `        await env.PRODUCTS.put(KV_KEY, JSON.stringify(body));
        return json({ ok: true, count: body.products.length }, 200, cors);`,
  `        canonicalizeSim(body.products);
        await env.PRODUCTS.put(KV_KEY, JSON.stringify(body));
        return json({ ok: true, count: body.products.length }, 200, cors);`,
  "canonicalizeSim(body.products)"
);

edit(
  "канонизация SIM в /api/admin/save",
  `        await env.PRODUCTS.put(KV_KEY, JSON.stringify(cat));
        return json({ success: true, ok: true, count: cat.products.length }, 200, cors);`,
  `        canonicalizeSim(cat.products);
        await env.PRODUCTS.put(KV_KEY, JSON.stringify(cat));
        return json({ success: true, ok: true, count: cat.products.length }, 200, cors);`,
  "canonicalizeSim(cat.products)"
);

// ---------------------------------------------------------------------------
// 6. Новые роуты: статус синхронизации, предложения, применение
// ---------------------------------------------------------------------------
edit(
  "роуты прайса",
  `      return json({ error: "not_found" }, 404, cors);`,
  `      // ---- Статус последней синхронизации прайса (диагностика cron) ----
      if (url.pathname === "/api/tg-sync-status" && request.method === "GET") {
        const raw = await env.PRODUCTS.get(TG_SYNC_LOG_KEY);
        return new Response(raw || JSON.stringify({ ok: false, error: "cron ещё ни разу не запускался" }), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // ---- Предложения по ценам (закупочные данные — только под токеном) ----
      if (url.pathname === "/api/tg-proposals" && request.method === "GET") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const raw = await env.PRODUCTS.get(TG_PROPOSALS_KEY);
        return new Response(raw || JSON.stringify({ proposals: [], unmatched: [], stats: {} }), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // ---- Применить ВЫБРАННЫЕ предложения (ids обязателен) ----
      if (url.pathname === "/api/admin/tg-apply" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        return await handleTgApply(request, env, cors);
      }

      return json({ error: "not_found" }, 404, cors);`,
  "/api/tg-sync-status"
);

// ---------------------------------------------------------------------------
// 7. Ручной прогон — через тот же код, что и cron (иначе пути разъезжаются)
// ---------------------------------------------------------------------------
edit(
  "ручной /api/admin/sync-tg через runTgSync",
  `        const channel = url.searchParams.get("channel") || "OPTMSK77";
        const prices = await fetchAndParseTgChannel(channel);
        await env.PRODUCTS.put(TG_PRICES_KEY, JSON.stringify(prices));
        return json({ success: true, count: prices.length, prices }, 200, cors);`,
  `        const log = await runTgSync(env, "manual");
        return json({ success: log.ok, ...log }, log.ok ? 200 : 502, cors);`,
  'runTgSync(env, "manual")'
);

// ---------------------------------------------------------------------------
// 8. Весь новый код — в конец файла
// ---------------------------------------------------------------------------
const TAIL = `

// ======================================================================
// SIM: канонизация и разбор на ортогональные признаки.
// ДЕРЖАТЬ ИДЕНТИЧНЫМ src/js/config.js — фронтенд и бэкенд обязаны понимать
// комплектации одинаково, иначе клиентская и серверная выборка разойдутся.
// ======================================================================
function normSim(s) {
  if (s == null) return "";
  const v = String(s).replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
  const low = v.toLowerCase();
  if (low === "" || low === "\\u2014" || low === "-" || low === "\\u043d\\u0435\\u0442") return "";
  // «2 SIM + eSIM» проверяем ПЕРВЫМ: иначе «2x Nano-SIM + eSIM» совпадёт
  // как одиночный «SIM + eSIM» либо как «2 eSIM».
  if (/2\\s*x?\\s*(nano-?sim|physical\\s*sim|sim)s?\\s*\\+\\s*e-?sim|dual\\s*sim\\s*\\+\\s*e-?sim/.test(low)) return "2 SIM + eSIM";
  if (/2\\s*e-?sim|dual\\s*e-?sim|\\u0434\\u0432\\u043e\\u0439\\u043d\\w*\\s*e-?sim/.test(low)) return "2 eSIM";
  if (/(physical|nano|sim)\\s*\\+\\s*e-?sim|sim\\s*\\+\\s*e-?sim/.test(low)) return "SIM + eSIM";
  if (/2\\s*x?\\s*(nano-?sim|physical\\s*sim|sim)s?\\b|dual\\s*sim/.test(low)) return "2 SIM";
  if (/^e-?sim$/.test(low)) return "eSIM";
  if (/physical\\s*sim|nano-?sim|^sim$/.test(low)) return "SIM";
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
    if (p && "sim" in p) p.sim = normSim(p.sim) || "\\u2014";
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

// ======================================================================
// Cron-синхронизация прайса из Telegram.
// ВАЖНО: cron НЕ пишет цены в каталог. Прайс берётся скрейпингом HTML-страницы
// t.me; одна ошибка разбора опубликовала бы неверную цену на живой витрине.
// Поэтому cron готовит ПРЕДЛОЖЕНИЯ, а применяет их человек через
// POST /api/admin/tg-apply со списком ids. Проверки в tg-price-sync.js —
// страховка от явного мусора, а не замена проверки глазами.
// ======================================================================
async function runTgSync(env, cronExpr) {
  const startedAt = new Date().toISOString();
  const channel = env.TG_PRICE_CHANNEL || "OPTMSK77";
  const log = { startedAt, cron: cronExpr || null, channel, ok: false };

  try {
    const offers = await fetchAndParseTgChannel(channel);
    // Пустой результат — ОШИБКА, а не успех: иначе затрём валидный прайс.
    if (!offers.length) {
      throw new Error("0 \\u043f\\u043e\\u0437\\u0438\\u0446\\u0438\\u0439 \\u0441 t.me/s/" + channel + " \\u2014 \\u043a\\u0430\\u043d\\u0430\\u043b \\u0437\\u0430\\u043a\\u0440\\u044b\\u0442, \\u0432\\u044b\\u043a\\u043b\\u044e\\u0447\\u0435\\u043d\\u043e \\u0432\\u0435\\u0431-\\u043f\\u0440\\u0435\\u0432\\u044c\\u044e \\u0438\\u043b\\u0438 \\u0438\\u0437\\u043c\\u0435\\u043d\\u0438\\u043b\\u0430\\u0441\\u044c \\u0432\\u0451\\u0440\\u0441\\u0442\\u043a\\u0430");
    }

    const rawCat = await env.PRODUCTS.get(KV_KEY);
    if (!rawCat) throw new Error("catalog_not_seeded");
    const catalog = JSON.parse(rawCat);

    const result = buildProposals(offers, catalog);

    await env.PRODUCTS.put(TG_PRICES_KEY, JSON.stringify(offers));
    await env.PRODUCTS.put(TG_PROPOSALS_KEY, JSON.stringify({
      builtAt: new Date().toISOString(), channel, ...result,
    }));

    log.ok = true;
    log.stats = result.stats;
    log.finishedAt = new Date().toISOString();
    console.log("[tg-sync] ok " + channel + ": " + JSON.stringify(result.stats));

    // Мало сопоставилось — первый признак, что у поставщика сменился формат.
    if (result.stats.parsed > 10 && result.stats.matched / result.stats.parsed < 0.5) {
      await notifyOperator(env, "\\u26a0\\ufe0f \\u041f\\u0440\\u0430\\u0439\\u0441 @" + channel + ": \\u0441\\u043e\\u043f\\u043e\\u0441\\u0442\\u0430\\u0432\\u043b\\u0435\\u043d\\u043e " + result.stats.matched + " \\u0438\\u0437 " + result.stats.parsed + ". \\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044c\\u0442\\u0435 /api/tg-proposals.");
    }
  } catch (e) {
    log.error = String((e && e.message) || e).slice(0, 500);
    log.finishedAt = new Date().toISOString();
    console.error("[tg-sync] FAIL (" + channel + "): " + log.error);
    await notifyOperator(env, "\\u274c \\u0421\\u0438\\u043d\\u0445\\u0440\\u043e\\u043d\\u0438\\u0437\\u0430\\u0446\\u0438\\u044f \\u043f\\u0440\\u0430\\u0439\\u0441\\u0430 @" + channel + " \\u0443\\u043f\\u0430\\u043b\\u0430: " + log.error);
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
  await pushHistory(env, rawCat, "\\u043f\\u0435\\u0440\\u0435\\u0434 \\u043f\\u0440\\u0438\\u043c\\u0435\\u043d\\u0435\\u043d\\u0438\\u0435\\u043c \\u043f\\u0440\\u0430\\u0439\\u0441\\u0430 (" + ids.length + ")");

  const { catalog: next, applied } = applyProposals(JSON.parse(rawCat), stored.proposals || [], ids);
  await env.PRODUCTS.put(KV_KEY, JSON.stringify(next));

  const appliedSet = new Set(ids);
  const rest = (stored.proposals || []).filter((p) => !appliedSet.has(p.id));
  await env.PRODUCTS.put(TG_PROPOSALS_KEY, JSON.stringify({ ...stored, proposals: rest }));

  return json({ success: true, applied, remaining: rest.length }, 200, cors);
}
`;

if (src.includes("function filterProducts(products, q)")) {
  skipped.push("блок новых функций — уже применён");
} else {
  src += TAIL;
  done.push("блок новых функций в конец файла");
}

// ---------------------------------------------------------------------------
// Отчёт
// ---------------------------------------------------------------------------
console.log(`Файл: ${file}`);
if (done.length) { console.log("\n✓ ПРИМЕНЕНО:"); done.forEach((d) => console.log("   " + d)); }
if (skipped.length) { console.log("\n• ПРОПУЩЕНО:"); skipped.forEach((d) => console.log("   " + d)); }
if (failed.length) {
  console.log("\n✗ НЕ УДАЛОСЬ:");
  failed.forEach((d) => console.log("   " + d));
  console.log("\nФайл НЕ изменён. Ваш воркер отличается от ожидаемого — пришлите его,");
  console.log("и я поправлю якоря под вашу версию.");
  process.exit(2);
}

if (!WRITE) {
  console.log(`\n(dry-run: ничего не записано. Размер стал бы ${before.length} → ${src.length} байт)`);
  console.log("Для применения добавьте --write");
} else {
  fs.writeFileSync(file + ".bak", before);
  fs.writeFileSync(file, src);
  console.log(`\n✓ Записано. Бэкап: ${file}.bak`);
  console.log("  Дальше: npx wrangler deploy");
}
