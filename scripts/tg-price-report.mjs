// Отчёт по прайсу из Telegram: что разобралось, что сопоставилось с каталогом,
// что нет и почему. НИЧЕГО НЕ МЕНЯЕТ — только читает и печатает.
//
// Зачем: подобрать таблицы соответствия (цвета, флаг→SIM) «на глазок» нельзя.
// Этот скрипт показывает на ВАШИХ реальных данных, где именно ломается
// сопоставление, чтобы решения принимались по фактам, а не по догадкам.
//
// Использование:
//   1) Откройте https://t.me/s/OPTMSK77, выделите сообщения с прайсом, скопируйте.
//   2) Сохраните в файл, например price.txt (в корне проекта).
//   3) node scripts/tg-price-report.mjs price.txt
//
// Опции:
//   --json          вывести предложения машинно-читаемо (для CRM)
//   --apply out.js  записать НОВЫЙ файл каталога с применёнными ценами
//                   (исходный src/data/products.js не трогается)
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { parseLine, parseMessages } from "../worker/tg-price-parse.js";
import { buildProposals, applyProposals } from "../worker/tg-price-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const srcFile = args.find((a) => !a.startsWith("--"));
if (!srcFile) {
  console.error("Укажите файл с текстом прайса: node scripts/tg-price-report.mjs price.txt");
  process.exit(1);
}
const asJson = args.includes("--json");
const applyIdx = args.indexOf("--apply");
const applyTo = applyIdx >= 0 ? args[applyIdx + 1] : null;

// ---- каталог ----
global.window = {};
require(path.join(__dirname, "..", "src", "data", "products.js"));
const catalog = global.window.__CATALOG__;

// ---- разбор ----
const text = fs.readFileSync(srcFile, "utf8");
const rawLines = text.split("\n").map((s) => s.trim()).filter(Boolean);

// Разбираем тем же кодом, что и боевой приём форвардов, — иначе отчёт
// показывает не то, что произойдёт на самом деле. Файл считаем одним
// сообщением: заголовки категорий внутри него определяются так же.
const prices = parseMessages([text]);
const unparsed = rawLines.filter((l) => !parseLine(l));

const out = buildProposals(prices, catalog);

if (asJson) {
  console.log(JSON.stringify({ ...out, unparsed }, null, 2));
} else {
  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(0) + "%" : "—");
  console.log("═".repeat(78));
  console.log(`СТРОК В ФАЙЛЕ: ${rawLines.length}`);
  console.log(`  разобрано парсером:      ${prices.length} (${pct(prices.length, rawLines.length)})`);
  console.log(`  НЕ разобрано:            ${unparsed.length}`);
  console.log(`  строк сопоставлено:      ${String(out.stats.matchedLines).padStart(4)} (${pct(out.stats.matchedLines, prices.length)} от разобранных)`);
  console.log(`  не сопоставлено:         ${String(out.stats.unmatched).padStart(4)}`);
  console.log(`  ─ предложений создано:   ${String(out.stats.proposals).padStart(4)}`);
  console.log(`      однозначных:         ${String(out.stats.applicable).padStart(4)}`);
  console.log(`      требуют выбора:      ${String(out.stats.ambiguous).padStart(4)}  (комплектация не определилась)`);
  console.log(`      заблокировано:       ${String(out.stats.blocked).padStart(4)}`);
  console.log("═".repeat(78));

  if (out.proposals.length) {
    console.log("\n── ПРЕДЛОЖЕНИЯ ПО ЦЕНАМ ──");
    for (const p of out.proposals) {
      const tag = p.blocked ? "БЛОК" : " ок ";
      const d = p.deltaPct === null ? "новая" : (p.deltaPct > 0 ? "+" : "") + p.deltaPct + "%";
      console.log(`[${tag}] ${p.label.padEnd(44).slice(0, 44)} ${String(p.sim).padEnd(13)} ${String(p.oldPrice).padStart(7)} → ${String(p.retail).padStart(7)}  ${d}${p.duplicates ? `  (дублей в прайсе: ${p.duplicates})` : ""}`);
      if (p.blocked) console.log(`       ⚠ ${p.blocked}`);
    }
  }

  // Причины отказов — сгруппированы: так сразу видно системную проблему,
  // а не двадцать однотипных строк.
  if (out.unmatched.length) {
    console.log("\n── НЕ СОПОСТАВЛЕНО (по причинам) ──");
    const byKind = {};
    for (const u of out.unmatched) {
      const kind = u.reason.replace(/«[^»]*»/g, "«…»").replace(/\(есть:[^)]*\)/, "").trim();
      (byKind[kind] = byKind[kind] || []).push(u);
    }
    for (const [kind, list] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  ${kind}  —  ${list.length} шт.`);
      list.slice(0, 6).forEach((u) => console.log(`     ${u.offer.sourceLine || [u.offer.model, u.offer.storage, u.offer.color].join(" ")}`));
      if (list.length > 6) console.log(`     … и ещё ${list.length - 6}`);
    }
  }

  if (unparsed.length) {
    console.log("\n── НЕ РАЗОБРАНО ПАРСЕРОМ ──");
    console.log("   (заголовки категорий и служебные строки здесь — норма)");
    unparsed.slice(0, 20).forEach((l) => console.log(`   ${l}`));
    if (unparsed.length > 20) console.log(`   … и ещё ${unparsed.length - 20}`);
  }
}

if (applyTo) {
  const { catalog: next, applied } = applyProposals(catalog, out.proposals);
  const header = "// Автосгенерировано tg-price-report.mjs. НЕ редактировать вручную.\n";
  fs.writeFileSync(applyTo, header + "window.__CATALOG__ = " + JSON.stringify(next) + ";\n");
  console.log(`\n✓ Применено ${applied} цен → ${applyTo}`);
  console.log("  Исходный src/data/products.js НЕ изменён. Сравните файлы перед заменой.");
}
