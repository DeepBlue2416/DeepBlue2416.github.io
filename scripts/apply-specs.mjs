// apply-specs.mjs — применяет подробные характеристики (ispecs.mjs) к текущему
// каталогу src/data/products.js, НЕ трогая товары, цены, фото и категории.
// Для iPhone-серий из I_MODELS ставит детальные specs; остальные — не меняет.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { iSpec, I_MODELS } from "./ispecs.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const JS = path.join(__dir, "..", "src", "data", "products.js");
const JSON_PATH = path.join(__dir, "..", "src", "data", "products.json");

const g = {};
eval(fs.readFileSync(JS, "utf8").replace("window.__CATALOG__", "g.C"));
const cat = g.C;

let updated = 0, skipped = 0;
for (const p of cat.products) {
  if (I_MODELS[p.name]) { p.specs = iSpec(I_MODELS[p.name]); updated++; }
  else skipped++;
}

fs.writeFileSync(JSON_PATH, JSON.stringify(cat, null, 2));
fs.writeFileSync(JS, "// Автосгенерировано + подробные характеристики (apply-specs.mjs).\nwindow.__CATALOG__ = " + JSON.stringify(cat) + ";\n");
console.log("Обновлены характеристики у товаров:", updated, "| без изменений (не iPhone-серия):", skipped);
