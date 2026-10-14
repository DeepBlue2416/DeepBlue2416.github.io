// Обновление цен + добавление недостающих комплектаций из прайса поставщика.
// Правило цены: цена_поставщика + 5000 → округлить до ближайшей X990.
// Регион(флаг) → SIM: HK/CN/«2Sim» = «2 eSIM», иначе одиночная = «eSIM».
// Существующий объём памяти → ОБНОВЛЯЕМ цену. Отсутствующий объём у модели, которую мы
// уже возим (и цвет у нас есть) → ДОБАВЛЯЕМ SKU клонированием (фото/цвет/спеки наследуются).
// Чужие модели (iPhone 14/15, MacBook) и чужие цвета — пропускаем.
const fs = require("fs");
const path = require("path");
const FILE = path.join(__dirname, "..", "src", "data", "products.js");

const raw = fs.readFileSync(FILE, "utf8");
const eq = raw.indexOf("=", raw.indexOf("window.__CATALOG__"));
const semi = raw.lastIndexOf("}") + 1;
const PREFIX = raw.slice(0, eq + 1) + " ";
const SUFFIX = raw.slice(semi);
const cat = JSON.parse(raw.slice(eq + 1, semi).trim());

// ---- Формула цены ----
const price = (supplier) => Math.round((supplier + 5000) / 1000) * 1000 - 10;

// ---- Карты ----
const MODEL = { "iPhone 17 Air": "iPhone Air" };
const model = (s) => MODEL[s] || s;
const STOR = { "128GB": "128 ГБ", "256GB": "256 ГБ", "512GB": "512 ГБ", "1TB": "1 ТБ", "2TB": "2 ТБ" };
const SLUG = { "128 ГБ": "128-gb", "256 ГБ": "256-gb", "512 ГБ": "512-gb", "1 ТБ": "1-tb", "2 ТБ": "2-tb" };
const simRU = (x) => (x === "2e" ? "2 eSIM" : "eSIM");

function colorRU(mdl, en) {
  const titanium = /16 Pro/.test(mdl);
  const t = { Black: "Чёрный титан", White: "Белый титан", Natural: "Натуральный титан", Desert: "Пустынный титан" };
  if (titanium && t[en]) return t[en];
  if (mdl === "iPhone Air") return { Black: "Чёрный", Blue: "Небесно-голубой", White: "Облачный белый", Gold: "Золотой" }[en] || null;
  if (/17 Pro/.test(mdl)) return { Blue: "Синий", Orange: "Космический оранжевый", Silver: "Серебристый" }[en] || null;
  if (mdl === "iPhone 17") return { Black: "Чёрный", White: "Белый", Blue: "Голубой", Sage: "Шалфейный", Lavender: "Лавандовый" }[en] || null;
  if (mdl === "iPhone 17e") return { Black: "Чёрный", White: "Белый", Pink: "Розовый", "Soft Pink": "Розовый" }[en] || null;
  return { Black: "Чёрный", White: "Белый", Pink: "Розовый", Teal: "Бирюзовый", Ultramarine: "Ультрамарин" }[en] || null;
}

// [модель(EN), память(EN), цвет(EN), sim('e'/'2e'), цена]
const SUPPLIER = [
  // ===== ЧАСТЬ 1 (обновление существующих объёмов) =====
  ["iPhone 17 Air","256GB","Black","e",71800],["iPhone 17 Air","256GB","Blue","e",69100],
  ["iPhone 17 Air","256GB","White","e",72800],["iPhone 17 Air","256GB","Gold","e",70600],
  ["iPhone 17 Air","512GB","Black","e",79300],["iPhone 17 Air","512GB","Blue","e",75000],
  ["iPhone 17 Air","512GB","White","e",82900],["iPhone 17 Air","512GB","Gold","e",76800],
  ["iPhone 16 Pro","128GB","Desert","2e",84100],["iPhone 16 Pro","128GB","Natural","2e",83400],
  ["iPhone 16 Pro","128GB","White","2e",77900],["iPhone 16 Pro","256GB","Natural","e",99300],
  ["iPhone 16 Pro Max","256GB","Natural","e",94100],["iPhone 16 Pro Max","256GB","White","e",94500],
  ["iPhone 16 Pro Max","256GB","Desert","e",93600],["iPhone 16 Pro Max","256GB","Natural","e",100000],
  ["iPhone 16 Pro Max","512GB","Black","e",105100],["iPhone 16 Pro Max","512GB","Natural","e",104300],
  ["iPhone 16 Pro Max","512GB","White","e",104600],["iPhone 16 Pro Max","512GB","Black","e",115300],
  ["iPhone 16 Pro Max","512GB","Desert","e",111000],["iPhone 16 Pro Max","512GB","White","e",114700],
  ["iPhone 17e","256GB","Black","e",55700],["iPhone 17e","256GB","White","e",54700],["iPhone 17e","256GB","Pink","e",54800],
  ["iPhone 17e","512GB","Black","e",64800],["iPhone 17e","512GB","White","e",66300],["iPhone 17e","512GB","Soft Pink","e",64800],
  ["iPhone 17e","512GB","Black","e",71300],["iPhone 17e","512GB","White","e",69800],["iPhone 17e","512GB","Pink","e",72100],
  ["iPhone 17","256GB","Black","e",72100],["iPhone 17","256GB","Blue","e",71900],["iPhone 17","256GB","White","e",72100],
  ["iPhone 17","256GB","Lavender","e",73000],["iPhone 17","256GB","Sage","e",72300],
  ["iPhone 17 Pro","256GB","Blue","e",94600],["iPhone 17 Pro","256GB","Orange","e",92700],["iPhone 17 Pro","256GB","Silver","e",97300],
  ["iPhone 17 Pro","256GB","Blue","2e",97100],["iPhone 17 Pro","256GB","Orange","2e",95700],["iPhone 17 Pro","256GB","Silver","2e",98600],
  ["iPhone 17 Pro","512GB","Blue","e",112500],["iPhone 17 Pro","512GB","Orange","e",108700],["iPhone 17 Pro","512GB","Silver","e",109300],
  ["iPhone 17 Pro","512GB","Blue","2e",116800],["iPhone 17 Pro","512GB","Orange","2e",115100],["iPhone 17 Pro","512GB","Silver","2e",120300],
  ["iPhone 16","128GB","Black","e",60000],["iPhone 16","128GB","Pink","e",60800],["iPhone 16","128GB","White","e",60600],["iPhone 16","128GB","Ultramarine","e",60600],
  ["iPhone 16","256GB","Black","e",65400],["iPhone 16","256GB","Pink","e",65400],["iPhone 16","256GB","Teal","e",64900],
  ["iPhone 16 Plus","128GB","Black","e",65300],["iPhone 16 Plus","128GB","Pink","e",65700],["iPhone 16 Plus","128GB","Teal","e",65500],["iPhone 16 Plus","128GB","Ultramarine","e",65400],

  // ===== ЧАСТЬ 2 (недостающие комплектации — ДОБАВЛЕНИЕ) =====
  ["iPhone 17 Air","1TB","Black","e",87300],["iPhone 17 Air","1TB","Blue","e",81700],["iPhone 17 Air","1TB","White","e",88500],
  ["iPhone 17","512GB","Black","e",86200],["iPhone 17","512GB","Blue","e",86000],["iPhone 17","512GB","White","e",89800],
  ["iPhone 17","512GB","Lavender","e",89000],["iPhone 17","512GB","Sage","e",87300],
  ["iPhone 17 Pro","1TB","Blue","e",121200],["iPhone 17 Pro","1TB","Orange","e",120400],["iPhone 17 Pro","1TB","Silver","e",126300],
  ["iPhone 17 Pro","1TB","Blue","2e",135000],["iPhone 17 Pro","1TB","Orange","2e",129000],["iPhone 17 Pro","1TB","Silver","2e",137300],
  ["iPhone 16 Pro","512GB","Desert","e",118800],["iPhone 16 Pro","1TB","White","e",117100],
  ["iPhone 16 Pro Max","1TB","Desert","e",118700],["iPhone 16 Pro Max","1TB","White","e",120500],
  ["iPhone 16","512GB","Teal","e",81300],["iPhone 16","512GB","Ultramarine","e",84300],
];

// ---- Дедуп по (модель,память,ЦВЕТ-RU,sim): минимальная цена ----
const best = new Map();
const skippedColor = [];
for (const [mdlEN, storEN, colEN, sim, p] of SUPPLIER) {
  const nm = model(mdlEN), st = STOR[storEN], col = colorRU(nm, colEN);
  if (!st || !col) { skippedColor.push(`НЕТ ЦВЕТА/ПАМЯТИ: ${mdlEN} ${storEN} ${colEN}`); continue; }
  const key = [nm, st, col, sim].join("|");
  if (!best.has(key) || p < best.get(key).p) best.set(key, { nm, st, col, sim, p });
}

// Снимок исходных (модель|память|цвет) — решаем add/update по ИСХОДНОМУ каталогу.
const origSC = new Set(cat.products.map((p) => [p.name, p.storage, p.color].join("|")));
const simSetOf = (nm) => new Set(cat.products.filter((p) => p.name === nm).map((p) => p.sim));
let seq = cat.products.reduce((m, p) => { const x = String(p.id).match(/-(\d+)$/); return x ? Math.max(m, +x[1]) : m; }, 0);

const updated = [], added = [], skipped = [...skippedColor];

for (const { nm, st, col, sim, p } of best.values()) {
  const newPrice = price(p);
  const sims = simSetOf(nm);
  const targetSim = sims.size === 1 ? [...sims][0] : simRU(sim);
  const existedStorage = origSC.has([nm, st, col].join("|"));

  if (existedStorage) {
    const sameNSC = cat.products.filter((x) => x.name === nm && x.storage === st && x.color === col);
    let targets = sameNSC.filter((x) => x.sim === targetSim);
    let note = "";
    if (!targets.length) { targets = sameNSC; note = ` [SIM ${targetSim} не найден → ко всем ${sameNSC.length}]`; }
    targets.forEach((t) => { t.priceCash = newPrice; t.priceCard = newPrice; });
    updated.push(`upd ${nm} ${st} ${col} ${targetSim} ×${targets.length} → ${newPrice} (пост.${p})${note}`);
  } else {
    const sameNC = cat.products.filter((x) => x.name === nm && x.color === col);
    if (!sameNC.length) { skipped.push(`НЕТ ЦВЕТА В КАТАЛОГЕ (не добавляю): ${nm} ${col}`); continue; }
    const dupe = cat.products.find((x) => x.name === nm && x.storage === st && x.color === col && x.sim === targetSim);
    if (dupe) { dupe.priceCash = newPrice; dupe.priceCard = newPrice; updated.push(`upd(add-dup) ${nm} ${st} ${col} ${targetSim} → ${newPrice}`); continue; }
    const tmpl = sameNC.find((x) => x.sim === targetSim) || sameNC[0];
    const clone = JSON.parse(JSON.stringify(tmpl));
    clone.storage = st; clone.sim = targetSim;
    clone.priceCash = newPrice; clone.priceCard = newPrice;
    clone.status = "in_stock"; clone.badge = "";
    seq += 1;
    let id = tmpl.id;
    if (SLUG[tmpl.storage]) id = id.replace(SLUG[tmpl.storage], SLUG[st]);
    if (tmpl.sim !== targetSim) id = id.replace(tmpl.sim === "2 eSIM" ? "2-esim" : "esim", targetSim === "2 eSIM" ? "2-esim" : "esim");
    id = id.replace(/-\d+$/, "-" + seq);
    clone.id = id;
    if (clone.specs) for (const k of Object.keys(clone.specs)) if (/встроенн/i.test(k)) clone.specs[k] = st;
    cat.products.push(clone);
    added.push(`ADD ${nm} ${st} ${col} ${targetSim} → ${newPrice} (пост.${p}) [${id}]`);
  }
}

// ---- Зеркало dual=single для ОБНОВЛЁННЫХ существующих объёмов (врем., до dual-цен) ----
const touchedSku = new Set();
for (const { nm, st, col, sim } of best.values()) {
  const sims = simSetOf(nm); const ts = sims.size === 1 ? [...sims][0] : simRU(sim);
  if (origSC.has([nm, st, col].join("|"))) touchedSku.add([nm, st, col, ts].join("|"));
}
const groupTouched = new Set([...touchedSku].map((k) => k.split("|").slice(0, 3).join("|")));
const groupPrice = {};
for (const pr of cat.products) {
  const g = [pr.name, pr.storage, pr.color].join("|");
  if (touchedSku.has([pr.name, pr.storage, pr.color, pr.sim].join("|"))) groupPrice[g] = pr.priceCash;
}
let mirrored = 0;
for (const pr of cat.products) {
  const g = [pr.name, pr.storage, pr.color].join("|");
  if (groupTouched.has(g) && !touchedSku.has([pr.name, pr.storage, pr.color, pr.sim].join("|")) && groupPrice[g] != null) {
    pr.priceCash = groupPrice[g]; pr.priceCard = groupPrice[g]; mirrored++;
  }
}

cat.meta = cat.meta || {};
cat.meta.updatedAt = "2026-08-22";
fs.writeFileSync(FILE, PREFIX + JSON.stringify(cat) + SUFFIX);

console.log(`ОБНОВЛЕНО: ${updated.length} | ДОБАВЛЕНО: ${added.length} | ЗЕРКАЛО: ${mirrored} | ПРОПУЩЕНО: ${skipped.length} | всего: ${cat.products.length}`);
console.log("\n--- ДОБАВЛЕНО ---"); added.forEach((x) => console.log("  " + x));
console.log("\n--- ПРОПУЩЕНО ---"); skipped.forEach((x) => console.log("  " + x));
