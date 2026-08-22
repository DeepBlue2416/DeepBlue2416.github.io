// Простейший сборщик: складывает готовый статический сайт в ./dist
// Публикуется на GitHub Pages. Ничего умного — только копирование.
import { cp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

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
      console.log(`✓ фиды: feed-yandex.yml + feed-google.xml (${nf} товаров с ценой)`);
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
