// Пополнение ассортимента позициями, которые есть у поставщика, но отсутствуют
// в каталоге, и починка сломанных комплектаций.
//
// Откуда взялся список: прогон реального прайса @OPTMSK77 через
// scripts/tg-price-report.mjs показал строки с причиной «нет объёма», «нет
// цвета» и «нет комплектации». Это не ошибки парсера — это товары, которые
// поставщик отгружает, а магазин не продаёт.
//
// ЦЕНЫ: считаются той же формулой, что и весь прайс (закупка + наценка,
// округление до ближайшей X990), поэтому руками цифры не вписаны — берутся
// закупочные из прайса и прогоняются через retailFrom.
//
// ФОТО: берутся из уже загруженных папок по карте цвет→папка ниже. Карта
// задана явно, а не выведена из имени: у 16 Plus «Бирюзовый» лежит в blue,
// и угадывание дало бы битый путь.
//
// Запуск:
//   node scripts/assortment-update.cjs            # показать, что будет
//   node scripts/assortment-update.cjs --write     # применить
//   node scripts/assortment-update.cjs --write --hide-2sim
//        # добавить версии с двумя физическими слотами СКРЫТЫМИ (hidden: true)
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "src", "data", "products.js");
const WRITE = process.argv.includes("--write");
const HIDE_2SIM = process.argv.includes("--hide-2sim");

const CARD_RATIO = 1.15;
const MARKUP = 5000;
const roundTo990 = (v) => Math.round(v / 1000) * 1000 - 10;
const retail = (supplier) => roundTo990(supplier + MARKUP);

const raw = fs.readFileSync(FILE, "utf8");
const eq = raw.indexOf("=", raw.indexOf("window.__CATALOG__"));
const semi = raw.lastIndexOf("}") + 1;
const cat = JSON.parse(raw.slice(eq + 1, semi).trim());

// Цвет каталога → папка с фото. Проверено по существующим SKU.
const PHOTO_DIR = {
  "iPhone 16 Plus": { "Чёрный": "black", "Розовый": "pink", "Бирюзовый": "blue", "Ультрамарин": "ultramarin", "Белый": "belyy" },
  "iPhone 16 Pro Max": { "Чёрный титан": "chernyy-titan", "Натуральный титан": "naturalnyy-titan", "Белый титан": "white", "Пустынный титан": "gold" },
  "iPhone 16 Pro": { "Пустынный титан": "pustynnyy-titan", "Натуральный титан": "naturalnyy-titan", "Белый титан": "belyy-titan", "Чёрный титан": "chernyy-titan" },
};
const DIR_ROOT = { "iPhone 16 Plus": "16-plus", "iPhone 16 Pro Max": "16-pro-max", "iPhone 16 Pro": "16-pro" };

// Новые позиции: [серия, объём, цвет, SIM, закупка у поставщика]
// Закупочные цены — из прайса @OPTMSK77 (см. fixtures/optmsk77-private-2.txt).
const NEW_SKUS = [
  // 16 Plus: не было объёма 512 ГБ вообще
  ["iPhone 16 Plus", "512 ГБ", "Чёрный", "2 eSIM", 82600],
  ["iPhone 16 Plus", "512 ГБ", "Розовый", "SIM + eSIM", 92600],
  ["iPhone 16 Plus", "512 ГБ", "Бирюзовый", "SIM + eSIM", 90600],
  ["iPhone 16 Plus", "512 ГБ", "Ультрамарин", "SIM + eSIM", 89100],
  // 16 Plus: не было белого цвета
  ["iPhone 16 Plus", "128 ГБ", "Белый", "SIM + eSIM", 73600],
  ["iPhone 16 Plus", "256 ГБ", "Белый", "SIM + eSIM", 80100],
  // 16 Pro Max: не было натурального титана в 1 ТБ
  ["iPhone 16 Pro Max", "1 ТБ", "Натуральный титан", "SIM + eSIM", 118900],
  // Версии с ДВУМЯ физическими слотами (Китай, Гонконг) — таких в каталоге
  // не было ни одной, из-за чего строки прайса уходили на ручной разбор.
  ["iPhone 16 Pro", "128 ГБ", "Пустынный титан", "2 SIM", 92200],
  ["iPhone 16 Pro", "128 ГБ", "Натуральный титан", "2 SIM", 90900],
  ["iPhone 16 Pro", "128 ГБ", "Белый титан", "2 SIM", 86000],
  ["iPhone 16 Pro Max", "512 ГБ", "Белый титан", "2 SIM", 117900],
];

const TR = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"c",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
const slug = (s) => String(s || "").toLowerCase().replace(/[а-яё]/g, (c) => TR[c] ?? c)
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
const SIM_SLUG = { "SIM + eSIM": "sim-esim", "2 eSIM": "2-esim", "2 SIM": "2-sim", "2 SIM + eSIM": "2-sim-esim", "eSIM": "esim" };

function photosFor(series, color) {
  const root = DIR_ROOT[series];
  const dir = (PHOTO_DIR[series] || {})[color];
  if (!root || !dir) return [];
  const abs = path.join(ROOT, "src", "assets", "products", "iphone", root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((f) => /\.(webp|jpg|jpeg|png|avif)$/i.test(f))
    .sort()
    .map((f) => `assets/products/iphone/${root}/${dir}/${f}`);
}

const key = (p) => [p.series, p.storage, p.watchSize || "", p.color, p.sim, p.region || ""].join("|");
const index = new Map(cat.products.map((p) => [key(p), p]));

const added = [], updated = [], warn = [];

// ---- 1. Починка дублей у iPhone 17e ----
// В 17e у Чёрного и Белого лежит по ДВА одинаковых SKU «SIM + eSIM» вместо
// пары «SIM + eSIM» / «2 eSIM» — так, как правильно сделано у Розового.
// Похоже, при правке в CRM у второй строки потерялась комплектация. Из-за
// этого eSIM-версии поставщика не сопоставлялись ни с чем.
const fixed17e = [];
for (const [st, colors] of [["256 ГБ", ["Чёрный", "Белый"]], ["512 ГБ", ["Чёрный", "Белый"]]]) {
  for (const color of colors) {
    const same = cat.products.filter(
      (p) => p.series === "iPhone 17e" && p.storage === st && p.color === color
    );
    const sims = same.map((p) => p.sim);
    const dup = sims.filter((x, i) => sims.indexOf(x) !== i);
    if (!dup.length) continue;
    // Чиним только если пара одинаковая, а нужной комплектации нет вовсе.
    const missing = dup[0] === "2 eSIM" ? "SIM + eSIM" : "2 eSIM";
    if (sims.includes(missing)) continue;
    const victim = same.find((p, i) => sims.indexOf(p.sim) !== i);
    if (!victim) continue;
    fixed17e.push(`${st} ${color}: «${victim.sim}» → «${missing}» [${victim.id}]`);
    if (WRITE) {
      victim.sim = missing;
      if (victim.specs && victim.specs["SIM-карта"]) victim.specs["SIM-карта"] = missing;
    }
  }
}

// ---- 2. Добавление новых позиций ----
for (const [series, storage, color, sim, supplier] of NEW_SKUS) {
  const target = { series, storage, color, sim, watchSize: "", region: "" };
  if (index.has(key(target))) {
    updated.push(`уже есть: ${series} ${storage} ${color} ${sim}`);
    continue;
  }

  // Шаблон — SKU той же серии (спеки, категория, порядок). Фото берём по
  // карте цвета, а не из шаблона: у нового цвета шаблон будет другого цвета.
  const tmpl = cat.products.find((p) => p.series === series);
  if (!tmpl) { warn.push(`нет ни одного SKU серии «${series}» — пропускаю`); continue; }

  const images = photosFor(series, color);
  if (!images.length) warn.push(`нет фото для «${series} ${color}» — SKU создан без изображений`);

  const cash = retail(supplier);
  const sku = JSON.parse(JSON.stringify(tmpl));
  sku.storage = storage;
  sku.color = color;
  sku.colorHex = (cat.products.find((p) => p.series === series && p.color === color) || {}).colorHex || tmpl.colorHex;
  sku.sim = sim;
  sku.images = images.length ? images : null;
  sku.thumbs = undefined;
  delete sku.thumbs;
  sku.priceCash = cash;
  sku.priceCard = Math.round((cash * CARD_RATIO) / 10) * 10;
  sku.status = "in_stock";
  sku.badge = "";
  delete sku.region;
  sku.specs = Object.assign({}, tmpl.specs, { "Встроенная память": storage, "SIM-карта": sim });
  sku.id = ["item", "iphone", slug(series), slug(color), slug(storage), SIM_SLUG[sim] || slug(sim)].join("-");

  // Версии с двумя физическими слотами можно завести скрытыми: их
  // сопоставление заработает, а на витрине они появятся по вашему решению.
  if (HIDE_2SIM && sim === "2 SIM") sku.hidden = true;

  cat.products.push(sku);
  index.set(key(sku), sku);
  added.push(`${series} ${storage} ${color} ${sim} → ${cash} / ${sku.priceCard}${sku.hidden ? "  (скрыт)" : ""}  ${images.length} фото`);
}

// ---- Отчёт ----
console.log("═".repeat(72));
if (fixed17e.length) {
  console.log(`ПОЧИНКА КОМПЛЕКТАЦИЙ (iPhone 17e): ${fixed17e.length}`);
  fixed17e.forEach((x) => console.log("  " + x));
  console.log("");
}
console.log(`ДОБАВЛЯЕТСЯ: ${added.length}`);
added.forEach((x) => console.log("  + " + x));
if (updated.length) { console.log(`\nУЖЕ ЕСТЬ: ${updated.length}`); updated.forEach((x) => console.log("  = " + x)); }
if (warn.length) { console.log("\n⚠ ПРЕДУПРЕЖДЕНИЯ:"); warn.forEach((x) => console.log("  " + x)); }
console.log("\n" + "═".repeat(72));
console.log(`Всего SKU станет: ${cat.products.length}`);

if (!WRITE) {
  console.log("(сухой прогон — файл не изменён. Для применения добавьте --write)");
  process.exit(0);
}

cat.meta = cat.meta || {};
cat.meta.updatedAt = new Date().toISOString().slice(0, 10);
fs.writeFileSync(FILE + ".bak", raw);
fs.writeFileSync(FILE, raw.slice(0, eq + 1) + " " + JSON.stringify(cat) + raw.slice(semi));
console.log("✓ Записано. Бэкап: products.js.bak");
console.log("  Дальше: npm run build, затем «Сохранить» в /admin.html чтобы залить в KV");
