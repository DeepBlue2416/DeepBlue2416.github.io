// Скрытие и возврат позиций без удаления из каталога.
//
// Скрытая позиция (hidden: true) остаётся в products.js и в CRM, но исчезает
// с витрины, со страницы товара, из поиска, из пререндер-страниц, из sitemap,
// из товарных фидов для ВК/2ГИС/Карт и из предложений по ценам. То есть для
// покупателя и площадок её нет, а данные, фото и история цен целы.
//
// Зачем скрипт, если чекбокс есть в CRM: галочка удобна для одной позиции, а
// для «убрать все версии с двумя физическими слотами» или «снять всю линейку
// Galaxy S24» кликать по десяткам карточек мучительно.
//
// Примеры:
//   node scripts/visibility.cjs list                     # что сейчас скрыто
//   node scripts/visibility.cjs hide --sim "2 SIM"        # скрыть по комплектации
//   node scripts/visibility.cjs hide --series "Galaxy S24"
//   node scripts/visibility.cjs hide --category Samsung --storage "512 ГБ"
//   node scripts/visibility.cjs show --series "Galaxy S24"
//   node scripts/visibility.cjs hide --no-price           # скрыть позиции без цены
//
// Без --write показывает, что изменится, и ничего не пишет.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "src", "data", "products.js");
const argv = process.argv.slice(2);
const cmd = argv[0];
const WRITE = argv.includes("--write");

const opt = (name) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : null;
};
const has = (name) => argv.includes("--" + name);

if (!["list", "hide", "show"].includes(cmd)) {
  console.log("Использование: node scripts/visibility.cjs <list|hide|show> [фильтры] [--write]");
  console.log("Фильтры: --series, --category, --color, --storage, --sim, --region, --id, --no-price");
  process.exit(cmd ? 1 : 0);
}

const raw = fs.readFileSync(FILE, "utf8");
const eq = raw.indexOf("=", raw.indexOf("window.__CATALOG__"));
const semi = raw.lastIndexOf("}") + 1;
const cat = JSON.parse(raw.slice(eq + 1, semi).trim());

// ---- list ----
if (cmd === "list") {
  const hid = cat.products.filter((p) => p.hidden);
  console.log(`Всего SKU: ${cat.products.length}, скрыто: ${hid.length}`);
  if (!hid.length) { console.log("(скрытых нет)"); process.exit(0); }
  const by = {};
  hid.forEach((p) => (by[p.series] = (by[p.series] || []).concat(p)));
  for (const [s, list] of Object.entries(by)) {
    console.log(`\n  ${s} — ${list.length}`);
    list.forEach((p) => console.log(`      ${p.storage || ""} ${p.color} ${p.sim || ""} ${p.region || ""}`.replace(/\s+/g, " ").trim()));
  }
  process.exit(0);
}

// ---- отбор ----
// Требуем хотя бы один фильтр: `hide` без условий скрыл бы весь каталог.
const FILTERS = ["series", "category", "color", "storage", "sim", "region", "id"];
const given = FILTERS.filter((f) => opt(f) !== null);
if (!given.length && !has("no-price")) {
  console.error("✗ Не задан ни один фильтр. Это скрыло бы весь каталог — прерываюсь.");
  console.error("  Добавьте, например: --series \"Galaxy S24\" или --sim \"2 SIM\"");
  process.exit(1);
}

// Сравнение по подстроке для series/category (удобно снимать линейку целиком),
// точное — для остальных: «256 ГБ» не должно совпадать с «256 ГБ» у другого поля.
const SUBSTR = new Set(["series", "category"]);
const matches = (p) => {
  for (const f of given) {
    const want = opt(f);
    const val = String(p[f] ?? "");
    if (SUBSTR.has(f)) { if (!val.toLowerCase().includes(want.toLowerCase())) return false; }
    else if (val !== want) return false;
  }
  if (has("no-price") && Number(p.priceCash) > 0) return false;
  return true;
};

const want = cmd === "hide";
const targets = cat.products.filter((p) => matches(p) && !!p.hidden !== want);

console.log(`Условие: ${given.map((f) => `${f}="${opt(f)}"`).join(", ")}${has("no-price") ? " + без цены" : ""}`);
console.log(`${want ? "Будет скрыто" : "Будет возвращено в продажу"}: ${targets.length} SKU\n`);
targets.forEach((p) =>
  console.log(`  ${(p.series + " " + (p.storage || "") + " " + p.color + " " + (p.sim || "") + " " + (p.region || "")).replace(/\s+/g, " ").trim()}`)
);

if (!targets.length) { console.log("(нечего менять)"); process.exit(0); }

if (!WRITE) {
  console.log("\n(сухой прогон — файл не изменён. Для применения добавьте --write)");
  process.exit(0);
}

for (const p of targets) {
  // hidden храним только когда true — как это делает CRM, чтобы не засорять
  // каждую позицию полем "hidden": false.
  if (want) p.hidden = true;
  else delete p.hidden;
}

cat.meta = cat.meta || {};
cat.meta.updatedAt = new Date().toISOString().slice(0, 10);
fs.writeFileSync(FILE + ".bak", raw);
fs.writeFileSync(FILE, raw.slice(0, eq + 1) + " " + JSON.stringify(cat) + raw.slice(semi));

const left = cat.products.filter((p) => p.hidden).length;
console.log(`\n✓ Готово. Скрытых в каталоге: ${left}. Бэкап: products.js.bak`);
console.log("  Дальше: npm run build, затем «Сохранить» в /admin.html чтобы залить в KV");
