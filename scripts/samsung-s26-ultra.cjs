// Добавление/обновление Samsung Galaxy S26 Ultra (региональные версии /DS).
//
// ЦЕНА:  в таблице ниже — ЗАКУПОЧНЫЕ цены. Розница считается тем же правилом,
//        что и для Apple: закупка + наценка, затем округление до ближайшей X990
//        (для Samsung наценка 4500 ₽). Единое правило для обоих брендов, чтобы
//        цены не выбивались визуально: раньше Samsung шёл flat, из-за чего его
//        цены не заканчивались на 990, а Apple — заканчивались.
//        priceCard = наличные × 1.10 (конвенция каталога, медиана ровно 1.1000).
// SIM:   суффикс «/DS» в коде модели = два физических слота Nano-SIM; у S26 Ultra
//        eSIM есть во всех регионах → каноническая метка «2 SIM + eSIM».
// РЕГИОН: отдельное измерение SKU (поле region), т.к. модель+память+цвет+SIM
//        у региональных версий совпадают, а цена — нет.
// ФОТО:  берутся из уже загруженных папок src/assets/products/samsung/S26Ultra/<папка>.
//        Соответствие цвет→папка задаётся явно (COLORS.dir) — по имени цвета
//        угадывать нельзя: «Cobalt Violet» лежит в cobalt/, а не в violet/.
//
// Идемпотентен: ключ SKU = модель|память|цвет|sim|регион, повторный запуск
// обновляет цены, а не плодит дубли. Идентификаторы детерминированные.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "src", "data", "products.js");
const PHOTO_ROOT = path.join(ROOT, "src", "assets", "products", "samsung", "S26Ultra");

const raw = fs.readFileSync(FILE, "utf8");
const eq = raw.indexOf("=", raw.indexOf("window.__CATALOG__"));
const semi = raw.lastIndexOf("}") + 1;
const PREFIX = raw.slice(0, eq + 1) + " ";
const SUFFIX = raw.slice(semi);
const cat = JSON.parse(raw.slice(eq + 1, semi).trim());

// ---- Константы модели ----
const SERIES = "Galaxy S26 Ultra";
const CATEGORY = "Samsung";
const SERIES_ORDER = 2618; // рядом с Galaxy S24 Ultra (2418), новее по номеру
const CARD_RATIO = 1.15;   // цена по карте = наличные + 15%
const MARKUP = 4500;       // наценка Samsung
// Ближайшая X990, при ничьей вверх. Ничья на практике невозможна: цены
// поставщика кратны 100, наценка тоже, а ничья требует остатка 490.
const retailFrom = (supplier) => Math.round((supplier + MARKUP) / 1000) * 1000 - 10;
const SIM = "2 SIM + eSIM";
const MODEL_CODE = "SM-S948B/DS";

const SPECS_BASE = {
  "Экран": '6.9" QHD+ AMOLED 120 Гц',
  "Чип": "Snapdragon 8 Elite Gen 5",
  "Камера": "200 Мп + 50 Мп + 12 Мп",
  "Батарея": "5000 мА·ч",
  "Стилус": "S Pen",
  "Оперативная память": "12 ГБ",
  "Код модели": MODEL_CODE,
  "SIM-карта": SIM,
};

// Цвет каталога → папка с фото + hex свотча.
const COLORS = {
  Black: { dir: "black", hex: "#2c2c2e" },
  White: { dir: "white", hex: "#f2f2f4" },
  "Cobalt Violet": { dir: "cobalt", hex: "#6a6ad8" },
};

// Прайс: [цвет, память, регион, ЗАКУПКА]
// Восстановлено из присланной таблицы розницы как «розница − 4500» (она была
// посчитана по старому flat-правилу). Когда придёт прайс с закупочными ценами
// напрямую — вписывайте их сюда как есть.
const SUPPLIER = [
  ["Black", "256 ГБ", "🇦🇪 ОАЭ", 75300],
  ["Black", "256 ГБ", "🇰🇿 Казахстан", 76600],
  ["White", "256 ГБ", "🇦🇪 ОАЭ", 77900],
  ["White", "256 ГБ", "🇰🇿 Казахстан", 78400],
  ["White", "256 ГБ", "🇹🇭 Таиланд", 77300],
  ["Cobalt Violet", "256 ГБ", "🇦🇪 ОАЭ", 75200],
];

// ---- Вспомогательное ----
const TR = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"c",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
const slug = (s) => String(s || "").toLowerCase().replace(/[а-яё]/g, (c) => TR[c] ?? c)
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";

// Фото цвета: сортируем по имени, чтобы порядок кадров был стабильным между прогонами.
function photosFor(dir) {
  const abs = path.join(PHOTO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((f) => /\.(webp|jpg|jpeg|png|avif)$/i.test(f))
    .sort()
    .map((f) => `assets/products/samsung/S26Ultra/${dir}/${f}`);
}

const skuKey = (p) => [p.name, p.storage, p.color, p.sim, p.region || ""].join("|");
const existing = new Map(cat.products.map((p) => [skuKey(p), p]));

// Категория Samsung должна существовать, иначе товар не покажется в каталоге.
if (!cat.categories.some((c) => c.key === CATEGORY)) {
  console.error(`✗ В каталоге нет категории «${CATEGORY}» — прерываюсь, чтобы не создать товары-сироты.`);
  process.exit(1);
}

const added = [], updated = [], warn = [];

for (const [color, storage, region, supplier] of SUPPLIER) {
  const c = COLORS[color];
  if (!c) { warn.push(`нет цвета «${color}» в карте COLORS`); continue; }

  const cash = retailFrom(supplier);
  const card = Math.round((cash * CARD_RATIO) / 10) * 10;
  const target = { name: SERIES, storage, color, sim: SIM, region };
  const hit = existing.get(skuKey(target));

  if (hit) {
    hit.priceCash = cash;
    hit.priceCard = card;
    hit.specs = Object.assign({}, hit.specs, { "Код модели": MODEL_CODE, "SIM-карта": SIM, "Регион поставки": region });
    updated.push(`upd ${color} ${region}: закупка ${supplier} → ${cash} / ${card}`);
    continue;
  }

  const images = photosFor(c.dir);
  if (!images.length) warn.push(`нет фото в S26Ultra/${c.dir} — SKU создан без изображений (${color})`);

  const sku = {
    id: `item-${slug(CATEGORY)}-${slug(SERIES)}-${slug(color)}-${slug(storage)}-${slug(SIM)}-${slug(region)}`,
    category: CATEGORY,
    brand: "Samsung",
    series: SERIES,
    seriesOrder: SERIES_ORDER,
    name: SERIES,
    color,
    colorHex: c.hex,
    storage,
    watchSize: null,
    sim: SIM,
    region,
    images: images.length ? images : null,
    priceCash: cash,
    priceCard: card,
    status: "in_stock",
    badge: "",
    specs: Object.assign({}, SPECS_BASE, { "Встроенная память": storage, "Регион поставки": region }),
  };

  cat.products.push(sku);
  existing.set(skuKey(sku), sku);
  added.push(`ADD ${color} ${storage} ${region}: закупка ${supplier} → ${cash} / ${card} (наценка ${cash-supplier}, ${images.length} фото)`);
}

cat.meta = cat.meta || {};
cat.meta.updatedAt = new Date().toISOString().slice(0, 10);
fs.writeFileSync(FILE, PREFIX + JSON.stringify(cat) + SUFFIX);

console.log(`ДОБАВЛЕНО: ${added.length} | ОБНОВЛЕНО: ${updated.length} | всего SKU: ${cat.products.length}`);
added.forEach((x) => console.log("  " + x));
updated.forEach((x) => console.log("  " + x));
if (warn.length) { console.log("\n⚠ ПРЕДУПРЕЖДЕНИЯ:"); warn.forEach((x) => console.log("  " + x)); }
