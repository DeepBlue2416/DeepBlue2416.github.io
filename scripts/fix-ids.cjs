// Исправление идентификаторов, которые ВРУТ о товаре.
//
// Откуда берутся: в CRM правили объём памяти или переименовывали серию, а id
// оставался прежним. В результате адрес /p/<id>/ содержит «256-gb» у товара на
// 512 ГБ и «galaxy-s24-ultra» у Galaxy S26 Ultra. Для поиска это прямое
// несоответствие URL и содержимого страницы, для людей — ссылка, обещающая не
// то, что открывается.
//
// ЧТО ДЕЛАЕМ: заменяем в id только ту часть, которая противоречит полям —
// слаг объёма и слаг серии. Остальное, включая числовой или случайный суффикс,
// сохраняем. Полная генерация id «с нуля» изменила бы все 268 адресов, и это
// было бы куда хуже: сейчас меняются только те, что уже сломаны.
//
// СТАРЫЕ АДРЕСА НЕ ТЕРЯЮТСЯ: пара «старый id → новый» пишется в
// src/data/id-redirects.json, а сборка кладёт по старому пути страницу с
// canonical, noindex и переадресацией. Проиндексированные ссылки продолжают
// работать, вес склеивается на новый адрес.
//
// Запуск:
//   node scripts/fix-ids.cjs            # показать, что изменится
//   node scripts/fix-ids.cjs --write     # применить
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "src", "data", "products.js");
const MAP_FILE = path.join(ROOT, "src", "data", "id-redirects.json");
const WRITE = process.argv.includes("--write");

const raw = fs.readFileSync(FILE, "utf8");
const eq = raw.indexOf("=", raw.indexOf("window.__CATALOG__"));
const semi = raw.lastIndexOf("}") + 1;
const cat = JSON.parse(raw.slice(eq + 1, semi).trim());

const TR = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"c",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
const slug = (s) => String(s || "").toLowerCase().replace(/[а-яё]/g, (c) => TR[c] ?? c)
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Слаги объёмов, которые встречаются в id.
const STOR = { "64 ГБ": "64-gb", "128 ГБ": "128-gb", "256 ГБ": "256-gb", "512 ГБ": "512-gb", "1 ТБ": "1-tb", "2 ТБ": "2-tb" };
const ALL_STOR = Object.values(STOR);

// Переименования серий: что искать в id → на что менять. Составлено по
// фактическим расхождениям, а не автоматически: слаг серии в id не всегда
// совпадает с слагом названия (например, «Смарт-часы» в префиксе категории).
const SERIES_RENAME = [
  ["galaxy-s24-ultra", "galaxy-s26-ultra", "Galaxy S26 Ultra"],
  ["apple-watch-series-10", "apple-watch-series-11", "Apple Watch Series 11"],
  ["apple-watch-ultra-2", "apple-watch-ultra-3", "Apple Watch Ultra 3"],
  ["airpods-pro-2", "airpods-pro-3", "AirPods Pro 3"],
];

const taken = new Set(cat.products.map((p) => p.id));
const changes = [];

for (const p of cat.products) {
  let id = p.id;
  const why = [];

  // 1) Объём. Меняем, только если в id стоит слаг ДРУГОГО объёма.
  const want = STOR[p.storage];
  if (want && !id.includes(want)) {
    const wrong = ALL_STOR.find((s) => s !== want && id.includes(s));
    if (wrong) {
      id = id.replace(wrong, want);
      why.push(`объём ${wrong} → ${want}`);
    }
  }

  // 2) Серия. Меняем только по явной карте переименований и только если
  //    серия товара действительно новая.
  for (const [from, to, series] of SERIES_RENAME) {
    if (p.series === series && id.includes(from)) {
      id = id.replace(from, to);
      why.push(`серия ${from} → ${to}`);
      break;
    }
  }

  if (!why.length || id === p.id) continue;

  // Коллизия: такой id уже занят другим товаром. Добавляем различающий хвост,
  // иначе две карточки стали бы жить по одному адресу.
  let unique = id;
  if (taken.has(unique)) {
    let n = 2;
    while (taken.has(`${unique}-${n}`)) n++;
    unique = `${unique}-${n}`;
    why.push("коллизия — добавлен суффикс");
  }

  changes.push({ from: p.id, to: unique, why, p });
  taken.delete(p.id);
  taken.add(unique);
}

// ---- отчёт ----
console.log("═".repeat(74));
console.log(`Всего SKU: ${cat.products.length}. Идентификаторов с расхождением: ${changes.length}`);
if (!changes.length) { console.log("Нечего исправлять."); process.exit(0); }
console.log("");
for (const c of changes) {
  const label = `${c.p.series} ${c.p.storage || ""} ${c.p.color}`.replace(/\s+/g, " ").trim();
  console.log(`  ${label}`);
  console.log(`    было:  ${c.from}`);
  console.log(`    стало: ${c.to}`);
  console.log(`    причина: ${c.why.join("; ")}`);
}
console.log("\n" + "═".repeat(74));

if (!WRITE) {
  console.log("(сухой прогон — файл не изменён. Для применения добавьте --write)");
  process.exit(0);
}

// Карту редиректов НАКАПЛИВАЕМ: если id правили раньше, старые пары терять
// нельзя — ссылки на них могут быть в индексе и во внешних источниках.
let map = {};
try { map = JSON.parse(fs.readFileSync(MAP_FILE, "utf8")); } catch {}
let chained = 0;
for (const c of changes) {
  // Если старый адрес уже указывал куда-то, перецеливаем цепочку на финал:
  // редирект на редирект поисковики проходят хуже.
  for (const [k, v] of Object.entries(map)) {
    if (v === c.from) { map[k] = c.to; chained++; }
  }
  map[c.from] = c.to;
  c.p.id = c.to;
}

cat.meta = cat.meta || {};
cat.meta.updatedAt = new Date().toISOString().slice(0, 10);
fs.writeFileSync(FILE + ".bak", raw);
fs.writeFileSync(FILE, raw.slice(0, eq + 1) + " " + JSON.stringify(cat) + raw.slice(semi));
fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2) + "\n");

console.log(`✓ Исправлено ${changes.length} id. Бэкап: products.js.bak`);
if (chained) console.log(`  Перецелено старых редиректов: ${chained} (чтобы не было цепочек)`);
console.log(`✓ Карта редиректов: src/data/id-redirects.json (${Object.keys(map).length} пар)`);
console.log("  Дальше: npm run build, затем «Сохранить» в /admin.html чтобы залить в KV.");
console.log("  Учтите: избранное у посетителей хранится по id в браузере — после");
console.log("  переименования отметки на этих товарах у них сбросятся.");
