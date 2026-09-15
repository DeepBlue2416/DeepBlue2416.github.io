// Простейший сборщик: складывает готовый статический сайт в ./dist
// Публикуется на GitHub Pages. Ничего умного — только копирование.
import { cp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");


// Читает контакты из config.js и подставляет их в элементы с data-атрибутами
// во всех .html внутри dist. Значения берутся из единственного источника
// (src/js/config.js), чтобы разметка и рантайм не разъезжались.
async function substituteContacts(dir) {
  const { readFile, writeFile, readdir } = await import("node:fs/promises");
  const cfg = await readFile(path.join(root, "src/js/config.js"), "utf8");
  const pick = (re) => { const m = cfg.match(re); return m ? m[1] : null; };

  const phone = pick(/phone:\s*"([^"]+)"/);
  const phoneHref = pick(/phoneHref:\s*"([^"]+)"/);
  const city = pick(/city:\s*"([^"]+)"/);
  const email = pick(/email:\s*"([^"]+)"/);

  const files = [];
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".html")) files.push(full);
    }
  }
  await walk(dir);

  let touched = 0;
  for (const f of files) {
    let html = await readFile(f, "utf8");
    const before = html;

    if (phone) {
      // <a data-phone href="#">+7 000 000-00-00</a> → реальные номер и tel:
      html = html.replace(
        /(<a\b[^>]*\bdata-phone\b[^>]*>)([^<]*)(<\/a>)/g,
        (_, open, __, close) => {
          const withHref = phoneHref
            ? open.replace(/href="[^"]*"/, `href="tel:${phoneHref}"`)
            : open;
          return withHref + phone + close;
        }
      );
    }
    if (city) {
      html = html.replace(/(<span\b[^>]*\bdata-city\b[^>]*>)([^<]*)(<\/span>)/g, `$1${city}$3`);
    }
    if (email) {
      html = html.replace(/\[указать e-mail оператора\]/g, email);
    }

    if (html !== before) { await writeFile(f, html); touched++; }
  }

  // Остатки заглушек — не молчим: это то, что увидят модераторы и поисковики.
  const leftovers = [];
  for (const f of files) {
    const html = await readFile(f, "utf8");
    for (const bad of ["000-00-00", "ваш город", "[указать"]) {
      if (html.includes(bad)) leftovers.push(`${path.relative(dir, f)}: ${bad}`);
    }
  }
  console.log(`✓ контакты подставлены в ${touched} HTML-файлов`);
  if (leftovers.length) {
    console.warn("⚠ НЕЗАПОЛНЕННЫЕ ЗАГЛУШКИ (их увидят поисковики и модерация рекламы):");
    for (const l of [...new Set(leftovers)].slice(0, 12)) console.warn("    " + l);
  }
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  // 1) Весь src целиком (index.html, admin.html, js, data, assets, скомпилированный tailwind.css)
  await cp(path.join(root, "src"), dist, { recursive: true });

  // 2) public поверх (favicon, robots.txt, CNAME при наличии)
  const pub = path.join(root, "public");
  if (existsSync(pub)) {
    await cp(pub, dist, { recursive: true });
  }

  // 3) .nojekyll — чтобы GitHub Pages не прогонял сайт через Jekyll
  await mkdir(dist, { recursive: true });
  const { writeFile, readFile } = await import("node:fs/promises");
  await writeFile(path.join(dist, ".nojekyll"), "");

  // 3b) Подстановка контактов в СТАТИЧЕСКИЙ HTML.
  //
  // Зачем: в разметке телефон и город стоят заглушками («+7 000 000-00-00»,
  // «ваш город»), а реальные значения подставляет app.js на клиенте. Живой
  // посетитель видит верные данные, но в исходном HTML остаются заглушки — их и
  // видят индексаторы Яндекса с Google и модераторы рекламных кабинетов.
  // Отдельно хуже с privacy.html: там app.js вообще не подключён, поэтому
  // заглушка в политике конфиденциальности не заменялась НИКОГДА.
  await substituteContacts(dist);

  // 4) Каталог: пререндер карточек (SEO) + sitemap.xml на чистых URL /p/<id>/
  try {
    const cfgSrc = await readFile(path.join(root, "src/js/config.js"), "utf8");
    const m = cfgSrc.match(/siteUrl:\s*"([^"]+)"/);
    const SITE = (m ? m[1] : "https://appleitochka.ru").replace(/\/$/, "");
    const bm = cfgSrc.match(/brand:\s*"([^"]+)"/);
    const BRAND = bm ? bm[1] : "Apple и точка";
    const g = {};
    global.window = g;
    // eslint-disable-next-line no-eval
    (0, eval)(await readFile(path.join(root, "src/data/products.js"), "utf8"));
    const cat = g.__CATALOG__ || { products: [], categories: [] };

    // 4a) Пререндер статических страниц товаров dist/p/<id>/index.html
    try {
      const { prerender } = await import("./prerender.js");
      const n = await prerender(dist, root, SITE, cat);
      console.log(`✓ пререндер карточек: ${n} страниц (/p/<id>/)`);
    } catch (e) {
      console.warn("prerender skipped:", e.message);
    }

    // 4c) Товарные фиды с ценами: Yandex YML + Google Merchant RSS
    try {
      const { buildFeeds } = await import("./feeds.js");
      const nf = await buildFeeds(dist, SITE, cat, BRAND);
      console.log(`✓ фиды: feed-yandex.yml + feed-google.xml (${nf.nOffers} SKU) + feed-yandex-maps.yml (${nf.nMaps} карточек)`);
    } catch (e) {
      console.warn("feeds skipped:", e.message);
    }

    // 4b) sitemap.xml — главная + чистые URL товаров
    const urls = new Set();
    urls.add(`${SITE}/`);
    (cat.products || []).forEach((p) => urls.add(`${SITE}/p/${encodeURIComponent(p.id)}/`));
    const today = new Date().toISOString().slice(0, 10);
    const body = [...urls]
      .map((u) => `  <url><loc>${u.replace(/&/g, "&amp;")}</loc><lastmod>${today}</lastmod></url>`)
      .join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
    await writeFile(path.join(dist, "sitemap.xml"), xml);
    console.log(`✓ sitemap.xml: ${urls.size} URL`);
  } catch (e) {
    console.warn("sitemap/prerender generation skipped:", e.message);
  }

  console.log("✓ Сборка готова: ./dist");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
