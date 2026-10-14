// Переименование метки SIM у iPhone: «eSIM» → «SIM + eSIM».
//
// Причина: в каталоге «eSIM» у iPhone фактически означало версию с одним
// физическим слотом ПЛЮС eSIM, а не eSIM-only. Из-за этого ось `sim` врала:
// фильтр «1 слот» не находил такие модели, а сопоставление с прайсом
// поставщика (где индийские и гонконгские версии именно SIM + eSIM) уходило
// в ручной разбор.
//
// После переименования ось становится физически честной:
//   SIM + eSIM — один физический nano-SIM + eSIM
//   2 eSIM     — только eSIM, два профиля (США, Япония и ОАЭ 17-й серии, iPhone Air)
//   2 SIM      — два физических слота, eSIM нет (материковый Китай)
//   2 SIM + eSIM — два физических слота + eSIM (региональные Samsung .../DS)
//
// ОБЛАСТЬ: только категория iPhone. Намеренно НЕ трогаем:
//   • Samsung — там «eSIM» и «SIM + eSIM» уже существуют как отдельные SKU
//     одной модели и цвета (14 из 17 позиций столкнулись бы в дубли);
//   • смарт-часы — в Apple Watch Cellular физического лотка нет вообще,
//     «eSIM» для них verbatim верно.
//
// ID НЕ МЕНЯЕМ: в них зашит слаг «-esim-», но id — это живые адреса /p/<id>/,
// уже попавшие в индекс, фиды и историю KV. Ломать их ради косметики слага
// дороже, чем оставить расхождение. Это тот же «stale id», что уже есть в
// каталоге от переименований серий.
//
// Запуск:
//   node scripts/rename-iphone-esim.cjs          # показать, что изменится
//   node scripts/rename-iphone-esim.cjs --write  # применить
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "src", "data", "products.js");
const WRITE = process.argv.includes("--write");

const raw = fs.readFileSync(FILE, "utf8");
const eq = raw.indexOf("=", raw.indexOf("window.__CATALOG__"));
const semi = raw.lastIndexOf("}") + 1;
const cat = JSON.parse(raw.slice(eq + 1, semi).trim());

const FROM = "eSIM";
const TO = "SIM + eSIM";
const SCOPE = "iPhone";

// Ключ «того же товара» без учёта SIM — чтобы поймать возможные дубли.
const key = (p) => [p.series, p.storage, p.watchSize || "", p.color, p.region || ""].join("|");
const alreadyTo = new Set(cat.products.filter((p) => p.sim === TO).map(key));

const targets = cat.products.filter((p) => p.category === SCOPE && p.sim === FROM);
const clashes = targets.filter((p) => alreadyTo.has(key(p)));

console.log(`Категория «${SCOPE}»: позиций с меткой «${FROM}» — ${targets.length}`);
console.log(`Конфликтов с существующими «${TO}» — ${clashes.length}`);

if (clashes.length) {
  console.error("\n✗ Переименование создало бы дубли. Прерываюсь, файл не изменён:");
  clashes.slice(0, 10).forEach((p) => console.error(`    ${p.series} ${p.storage} ${p.color} [${p.id}]`));
  process.exit(1);
}

// Что НЕ трогаем — показываем явно, чтобы область правки была видна.
const skipped = {};
cat.products
  .filter((p) => p.sim === FROM && p.category !== SCOPE)
  .forEach((p) => (skipped[p.category] = (skipped[p.category] || 0) + 1));

if (Object.keys(skipped).length) {
  console.log("\nНе трогаем (вне области):");
  Object.entries(skipped).forEach(([c, n]) => console.log(`    ${c}: ${n}`));
}

const bySeries = {};
targets.forEach((p) => (bySeries[p.series] = (bySeries[p.series] || 0) + 1));
console.log("\nБудет переименовано:");
Object.entries(bySeries).forEach(([s, n]) => console.log(`    ${String(n).padStart(3)}  ${s}`));

if (!WRITE) {
  console.log("\n(сухой прогон — файл не изменён. Для применения добавьте --write)");
  process.exit(0);
}

for (const p of targets) {
  p.sim = TO;
  if (p.specs && p.specs["SIM-карта"] === FROM) p.specs["SIM-карта"] = TO;
}
cat.meta = cat.meta || {};
cat.meta.updatedAt = new Date().toISOString().slice(0, 10);

fs.writeFileSync(FILE + ".bak", raw);
fs.writeFileSync(FILE, raw.slice(0, eq + 1) + " " + JSON.stringify(cat) + raw.slice(semi));
console.log(`\n✓ Переименовано ${targets.length} позиций. Бэкап: products.js.bak`);
console.log("  Дальше: npm run build, затем залить каталог в KV через /admin.html");
