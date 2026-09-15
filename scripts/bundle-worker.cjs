// Сборка воркера в ОДИН файл для вставки в веб-редактор Cloudflare.
//
// Зачем: редактор в дашборде («Edit code») работает с одним модулем — import
// из соседних файлов там не подключить. При этом держать всё в одном файле в
// репозитории неудобно. Поэтому исходники остаются модульными, а этот скрипт
// склеивает их в worker/index.bundled.js: его содержимое целиком копируется
// в редактор.
//
// Запуск: node scripts/bundle-worker.cjs
const fs = require("fs");
const path = require("path");

const W = path.join(__dirname, "..", "worker");
const OUT = path.join(W, "index.bundled.js");

// Порядок важен: сначала зависимости, потом index.js, который их использует.
const MODULES = ["tg-price-parse.js", "tg-price-sync.js", "tg-feeds.js"];

function stripModuleSyntax(code, name) {
  let out = code;
  // Убираем import'ы — после склейки всё в одной области видимости.
  out = out.replace(/^\s*import\s+[^;]+;\s*$/gm, "");
  // Убираем export { ... } и export перед объявлениями.
  out = out.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "");
  out = out.replace(/^\s*export\s+(?=(const|let|var|function|async|class)\b)/gm, "");
  return `// ─── ${name} ──────────────────────────────────────────────\n${out.trim()}\n`;
}

let parts = [
  `// ============================================================================
// worker/index.bundled.js — СОБРАННЫЙ ФАЙЛ. НЕ РЕДАКТИРОВАТЬ ВРУЧНУЮ.
// Сгенерирован scripts/bundle-worker.cjs из worker/*.js.
// Правьте исходные модули и пересоберите: node scripts/bundle-worker.cjs
//
// Как применить: скопировать содержимое целиком в Cloudflare →
// Workers & Pages → ваш воркер → Edit code → заменить всё → Deploy.
// ============================================================================
`,
];

for (const m of MODULES) {
  const p = path.join(W, m);
  if (!fs.existsSync(p)) {
    console.error(`✗ Нет модуля ${m} — прерываюсь.`);
    process.exit(1);
  }
  parts.push(stripModuleSyntax(fs.readFileSync(p, "utf8"), m));
}

const idx = fs.readFileSync(path.join(W, "index.js"), "utf8");
parts.push(stripModuleSyntax(idx, "index.js (основной)"));

let bundled = parts.join("\n");

// `export default { fetch, scheduled }` обязан остаться — это точка входа.
if (!/export\s+default\s*\{/.test(bundled)) {
  bundled = bundled.replace(/^\s*default\s*\{/m, "export default {");
}
if (!/export\s+default\s*\{/.test(bundled)) {
  console.error("✗ В сборке нет `export default {` — воркер не запустится. Проверьте worker/index.js.");
  process.exit(1);
}

// Дубли объявлений после склейки — верный признак, что функция определена и в
// модуле, и в index.js. В одной области видимости это SyntaxError.
const names = {};
// Ловим и function, и const/let/class: коллизия в любом объявлении верхнего
// уровня после склейки даёт SyntaxError «has already been declared».
for (const m of bundled.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) {
  names[m[1]] = (names[m[1]] || 0) + 1;
}
for (const m of bundled.matchAll(/^(?:const|let|class)\s+([A-Za-z0-9_$]+)\s*[=({]/gm)) {
  names[m[1]] = (names[m[1]] || 0) + 1;
}
const dupes = Object.entries(names).filter(([, n]) => n > 1);
if (dupes.length) {
  console.error("✗ Дублирующиеся объявления функций после склейки:");
  dupes.forEach(([n, c]) => console.error(`    ${n} — ${c} раза`));
  console.error("  Уберите дубль из worker/index.js (он есть в модуле) и повторите.");
  process.exit(1);
}

fs.writeFileSync(OUT, bundled);
const kb = (bundled.length / 1024).toFixed(1);
console.log(`✓ ${path.relative(process.cwd(), OUT)} — ${kb} КБ, ${bundled.split("\n").length} строк`);
console.log(`  Модулей склеено: ${MODULES.length} + index.js`);
console.log(`  Дальше: скопировать файл целиком в редактор Cloudflare и нажать Deploy.`);
