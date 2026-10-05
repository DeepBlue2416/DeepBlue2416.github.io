// Слияние актуального экспорта CRM с текущим каталогом репозитория.
//
// ЗАЧЕМ НЕ ПРОСТАЯ ЗАМЕНА ФАЙЛА: свежий экспорт CRM содержит актуальные цены,
// но в нём МЕНЬШЕ позиций, чем задеплоено. Простая замена молча убрала бы с
// витрины десятки живых товаров (в замере: 38 — старая линейка Samsung и Watch,
// а заодно все аксессуары: чехлы, кабель, MagSafe, Apple Pencil). Снятие старой
// линейки, скорее всего, осознанное, а пропажа аксессуаров — вряд ли.
//
// Правила слияния:
//   • есть в обоих  → берём цены/наличие/бейдж из НОВОГО экспорта (он актуальнее)
//   • только в новом → добавляем
//   • только в текущем → СОХРАНЯЕМ и показываем в отчёте (снять можно флагом)
//
// Запуск:
//   node scripts/merge-catalog.cjs <новый products.js>              # отчёт
//   node scripts/merge-catalog.cjs <новый products.js> --write       # применить
//   node scripts/merge-catalog.cjs <новый products.js> --write --retire-missing
//                                  # плюс снять с продажи то, чего нет в экспорте
//                                  # (status: on_order, НЕ удаление)
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const srcArg = args.find((a) => !a.startsWith("--"));
const WRITE = args.includes("--write");
const RETIRE = args.includes("--retire-missing");

if (!srcArg) {
  console.error("Укажите файл свежего экспорта: node scripts/merge-catalog.cjs products__3_.js [--write] [--retire-missing]");
  process.exit(1);
}

const FILE = path.join(__dirname, "..", "src", "data", "products.js");

function loadCatalog(p) {
  const prev = global.window;
  global.window = {};
  delete require.cache[require.resolve(path.resolve(p))];
  require(path.resolve(p));
  const c = global.window.__CATALOG__;
  global.window = prev;
  if (!c || !Array.isArray(c.products)) throw new Error(`не похоже на каталог: ${p}`);
  return c;
}

const cur = loadCatalog(FILE);
const inc = loadCatalog(srcArg);

const curById = new Map(cur.products.map((p) => [p.id, p]));
const incById = new Map(inc.products.map((p) => [p.id, p]));

// Поля, которые считаем «живыми данными» и тянем из свежего экспорта.
// Фото и характеристики НЕ трогаем: в репозитории они могут быть полнее
// (в экспорте попадались позиции с images: null там, где снимки есть на диске).
// series/name включены намеренно: в экспорте видно переименование линейки
// (Apple Watch Series 10 → Series 11, AirPods Pro 2 → Pro 3, S24 Ultra → S26
// Ultra). Это осознанное решение оператора, и если тянуть только цены, витрина
// продолжит показывать прошлое поколение. Побочный эффект: id остаются от
// старой модели — они попадают в раздел «требует внимания» ниже.
const LIVE = ["priceCash", "priceCard", "status", "badge", "series", "name"];

const changed = [], added = [], onlyCur = [], sameSame = [];

for (const [id, ip] of incById) {
  const cp = curById.get(id);
  if (!cp) { added.push(ip); continue; }
  const diff = [];
  for (const f of LIVE) {
    if (ip[f] !== undefined && ip[f] !== cp[f]) diff.push([f, cp[f], ip[f]]);
  }
  if (diff.length) changed.push({ id, product: cp, incoming: ip, diff });
  else sameSame.push(id);
}
for (const [id, cp] of curById) if (!incById.has(id)) onlyCur.push(cp);

// ---- отчёт ----
const fmt = (v) => (typeof v === "number" ? v.toLocaleString("ru-RU") : String(v ?? "—"));
console.log("═".repeat(74));
console.log(`Текущий каталог: ${cur.products.length} SKU (updatedAt ${cur.meta && cur.meta.updatedAt})`);
console.log(`Свежий экспорт : ${inc.products.length} SKU (updatedAt ${inc.meta && inc.meta.updatedAt})`);
console.log("═".repeat(74));
console.log(`  цены/наличие изменятся:  ${changed.length}`);
console.log(`  без изменений:           ${sameSame.length}`);
console.log(`  добавится из экспорта:   ${added.length}`);
console.log(`  есть только в текущем:   ${onlyCur.length}  ${RETIRE ? "→ будут сняты с продажи" : "→ СОХРАНЯЮТСЯ"}`);

if (changed.length) {
  console.log("\n── ИЗМЕНЕНИЯ ЦЕН ──");
  changed.slice(0, 40).forEach((c) => {
    const d = c.diff.map(([f, a, b]) => `${f}: ${fmt(a)} → ${fmt(b)}`).join(", ");
    console.log(`  ${(c.product.series + " " + (c.product.storage || "") + " " + c.product.color).trim().padEnd(46).slice(0, 46)} ${d}`);
  });
  if (changed.length > 40) console.log(`  … и ещё ${changed.length - 40}`);
}

if (added.length) {
  console.log("\n── ДОБАВЯТСЯ ──");
  added.forEach((p) => console.log(`  ${p.series} ${p.storage || ""} ${p.color} — ${fmt(p.priceCash)} ₽${p.priceCash > 0 ? "" : "  ⚠ без цены"}`));
}

if (onlyCur.length) {
  console.log("\n── ЕСТЬ ТОЛЬКО В ТЕКУЩЕМ (нет в свежем экспорте) ──");
  const bySeries = {};
  onlyCur.forEach((p) => (bySeries[p.series] = (bySeries[p.series] || 0) + 1));
  Object.entries(bySeries).sort((a, b) => b[1] - a[1]).forEach(([sr, n]) => console.log(`  ${String(n).padStart(3)}  ${sr}`));
  console.log(RETIRE
    ? "\n  Флаг --retire-missing: этим позициям будет выставлен status: on_order."
    : "\n  Сохраняются как есть. Если часть линейки снята с продажи — перезапустите\n  с --retire-missing (выставит status: on_order, товары НЕ удаляются).");
}

// ---- известные поломки: показываем, но не трогаем ----
const merged = { ...cur, products: cur.products.map((p) => ({ ...p })) };
const mById = new Map(merged.products.map((p) => [p.id, p]));

for (const c of changed) {
  const t = mById.get(c.id);
  for (const [f, , to] of c.diff) t[f] = to;
}
for (const p of added) { merged.products.push({ ...p }); mById.set(p.id, mById.get(p.id) || p); }
if (RETIRE) for (const p of onlyCur) mById.get(p.id).status = "on_order";

const problems = [];
for (const p of merged.products) {
  if (!(Number(p.priceCash) > 0)) problems.push(`без цены: ${p.series} ${p.storage || ""} ${p.color} [${p.id}]`);
  // id хранит имя другой модели — следствие переименования серии в CRM без
  // пересоздания id. Ломает URL /p/<id>/ и товарные фиды.
  const slugSeries = String(p.series || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const core = slugSeries.replace(/^-|-$/g, "");
  if (core && p.id && !String(p.id).includes(core.split("-").slice(-2).join("-"))) {
    problems.push(`id не соответствует серии «${p.series}»: ${p.id}`);
  }
}
if (problems.length) {
  console.log("\n── ТРЕБУЕТ ВНИМАНИЯ (не исправляется автоматически) ──");
  problems.slice(0, 25).forEach((x) => console.log("  " + x));
  if (problems.length > 25) console.log(`  … и ещё ${problems.length - 25}`);
}

console.log("\n" + "═".repeat(74));
console.log(`ИТОГО после слияния: ${merged.products.length} SKU`);

if (!WRITE) {
  console.log("(сухой прогон — файл не изменён. Для применения добавьте --write)");
  process.exit(0);
}

const raw = fs.readFileSync(FILE, "utf8");
const eq = raw.indexOf("=", raw.indexOf("window.__CATALOG__"));
const semi = raw.lastIndexOf("}") + 1;
merged.meta = merged.meta || {};
merged.meta.updatedAt = (inc.meta && inc.meta.updatedAt) || new Date().toISOString().slice(0, 10);
fs.writeFileSync(FILE + ".bak", raw);
fs.writeFileSync(FILE, raw.slice(0, eq + 1) + " " + JSON.stringify(merged) + raw.slice(semi));
console.log(`✓ Записано. Бэкап: ${path.basename(FILE)}.bak`);
console.log("  Дальше: node scripts/samsung-s26-ultra.cjs && npm run build");
