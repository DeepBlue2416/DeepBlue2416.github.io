// scripts/catalog-estimate-18.cjs — проставляет ориентировочные цены позициям
// iPhone 18, по которым поставщик ещё не присылал прайс.
//
// Как считаем: берём цену того же объёма у 17-й серии (18 Pro ← 17 Pro,
// 18 Pro Max ← 17 Pro Max). Цены поставщика на новинку скачут и за первые
// недели сползают к уровню прошлой модели, поэтому показывать их в каталоге
// нет смысла. Все такие цены помечаются priceEstimated: true — рядом выводится
// «цена ориентировочная, уточните у менеджера».
//
// Запуск: node scripts/catalog-estimate-18.cjs
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "src", "data", "products.js");
global.window = {};
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(FILE, "utf8"));
const catalog = global.window.__CATALOG__;
const products = catalog.products;

// Коэффициенты объёмов — посчитаны по реальным ценам iPhone 17 Pro Max.
const LADDER = { "256 ГБ": 1, "512 ГБ": 1.127, "1 ТБ": 1.272, "2 ТБ": 1.572 };
const CARD_RATIO = 1.15;
function to990(n) {
  const down = Math.floor((n - 990) / 1000) * 1000 + 990;
  const up = down + 1000;
  return n - down <= up - n ? down : up;
}

const PAIRS = { "iPhone 18 Pro": "iPhone 17 Pro", "iPhone 18 Pro Max": "iPhone 17 Pro Max" };
const ORDER = Object.keys(LADDER);
let filled = 0;
for (const [newS, oldS] of Object.entries(PAIRS)) {
  const list = products.filter((p) => p.series === newS);
  // Цены прошлой модели по объёмам: берём минимум среди цветов (без скрытых).
  const base = {};
  products.filter((p) => p.series === oldS && !p.hidden && p.priceCash > 0).forEach((p) => {
    base[p.storage] = Math.min(base[p.storage] || Infinity, p.priceCash);
  });
  if (!Object.keys(base).length) continue;
  for (const p of list) {
    let price = base[p.storage];
    if (!price && LADDER[p.storage]) {
      // Объёма нет у прошлой модели (например, 2 ТБ) — достраиваем по лестнице.
      const i = ORDER.indexOf(p.storage);
      const known = Object.keys(base).filter((k) => LADDER[k])
        .sort((a, b) => Math.abs(ORDER.indexOf(a) - i) - Math.abs(ORDER.indexOf(b) - i))[0];
      if (known) price = to990((base[known] * LADDER[p.storage]) / LADDER[known]);
    }
    if (!price) continue;
    p.priceCash = price;
    p.priceCard = Math.round((price * CARD_RATIO) / 10) * 10;
    p.priceEstimated = true;
    p.status = "preorder";
    filled++;
  }
}

catalog.meta.updatedAt = new Date().toISOString().slice(0, 10);
fs.writeFileSync(FILE, "// Автосгенерировано CRM-панелью админа.\nwindow.__CATALOG__ = " + JSON.stringify(catalog) + ";\n");

console.log(`✓ ориентировочных цен проставлено: ${filled}`);
for (const s of Object.keys(PAIRS)) {
  const rows = products.filter((p) => p.series === s);
  const by = {};
  rows.forEach((p) => { (by[p.storage] = by[p.storage] || []).push((p.priceEstimated ? "≈" : "") + p.priceCash); });
  console.log(" ", s, Object.entries(by).map(([k, v]) => `${k}: ${[...new Set(v)].join("/")}`).join(" | "));
}
