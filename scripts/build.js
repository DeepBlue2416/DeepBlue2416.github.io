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

// Вставляет код Яндекс.Метрики перед </head> в публичные страницы.
// admin.html и prices.html намеренно пропускаем: это рабочие инструменты,
// их посещения исказили бы статистику магазина.
async function injectMetrika(dir) {
  const { readFile, writeFile, readdir } = await import("node:fs/promises");
  const cfg = await readFile(path.join(root, "src/js/config.js"), "utf8");
  const m = cfg.match(/metrikaId:\s*"([^"]*)"/);
  const id = m && m[1] && m[1].trim();
  if (!id) { console.log("• Метрика: номер не задан — код не вставлен"); return; }
  if (!/^\d+$/.test(id)) { console.warn(`⚠ Метрика: «${id}» не похож на номер счётчика — пропускаю`); return; }

  // yandex_*.html и google*.html — файлы подтверждения прав в Вебмастере и
  // Search Console. Их содержимое сверяется посимвольно, поэтому ничего в них
  // не вставляем.
  const SKIP = new Set(["admin.html", "prices.html"]);
  const isVerify = (n) => /^(yandex_|google)[\w-]*\.html$/i.test(n);

  // Сниппет в том виде, в котором его сейчас отдаёт Метрика: номер счётчика
  // передаётся в адресе tag.js (?id=...), плюс флаг ssr:true — он нужен как
  // раз для таких сайтов, как этот, где страницы отрендерены заранее.
  // Счётчик НЕ стартует сам. По 152-ФЗ и правилам обработки cookie аналитика
  // не должна собирать данные до согласия посетителя, а Вебвизор пишет
  // действия на странице с первой же секунды. Поэтому здесь объявляется
  // загрузчик, а вызывается он либо сразу (если согласие уже сохранено), либо
  // по событию из баннера. Отказ означает, что tag.js вообще не загрузится.
  const snippet = `  <!-- Yandex.Metrika counter (загружается после согласия) -->
  <script type="text/javascript">
    window.__ymId = ${id};
    window.__ymLoad = function () {
      if (window.__ymLoaded) return;
      window.__ymLoaded = true;
      (function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
      m[i].l=1*new Date();
      for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
      k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
      (window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=${id}', 'ym');
      ym(${id}, 'init', {ssr:true, webvisor:true, clickmap:true, ecommerce:"dataLayer", accurateTrackBounce:true, trackLinks:true});
    };
    try {
      if (localStorage.getItem("ait:cookie-consent") === "1") window.__ymLoad();
    } catch (e) {}
    window.addEventListener("ait:consent-granted", window.__ymLoad);
  </script>
  <!-- noscript-пиксель НЕ выводим: он сработал бы у посетителей без JS сразу,
       в обход согласия, а отказаться они технически не могут. Потеря в
       статистике ничтожна, зато сбор данных без согласия исключён полностью. -->
  <!-- /Yandex.Metrika counter -->
`;

  let n = 0;
  const files = [];
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".html") && !SKIP.has(e.name) && !isVerify(e.name)) files.push(full);
    }
  }
  await walk(dir);

  for (const f of files) {
    const html = await readFile(f, "utf8");
    if (html.includes("mc.yandex.ru/metrika")) continue;
    // Ставим сразу после <head>, а не перед </head>: Метрика просит размещать
    // код как можно ближе к началу страницы, иначе просмотр не успевает
    // отправиться, если посетитель закрывает вкладку почти сразу.
    const m2 = html.match(/<head[^>]*>/i);
    if (!m2) continue;
    const at = m2.index + m2[0].length;
    await writeFile(f, html.slice(0, at) + "\n" + snippet + html.slice(at));
    n++;
  }
  console.log(`✓ Метрика ${id}: код вставлен в ${n} страниц`);
}

// Страницы-редиректы для адресов, изменившихся при исправлении id.
// GitHub Pages серверных редиректов не умеет, поэтому кладём по старому пути
// HTML-заглушку с canonical и noindex: проиндексированные ссылки продолжают
// работать, а склейка в поиске уходит на новый адрес.
async function writeIdRedirects(dist, SITE) {
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  let map = {};
  try { map = JSON.parse(await readFile(path.join(root, "src/data/id-redirects.json"), "utf8")); }
  catch { return; }
  const pairs = Object.entries(map);
  if (!pairs.length) return;
  for (const [oldId, newId] of pairs) {
    const to = `${SITE}/p/${encodeURIComponent(newId)}/`;
    const dir = path.join(dist, "p", oldId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8" />
<title>Товар переехал — Apple и точка</title>
<meta name="robots" content="noindex, follow" />
<link rel="canonical" href="${to}" />
<meta http-equiv="refresh" content="0; url=${to}" />
</head><body><p>Адрес товара изменился. <a href="${to}">Перейти к товару</a>.</p>
<script>location.replace(${JSON.stringify(to)});</script></body></html>
`);
  }
  console.log(`✓ редиректы старых адресов: ${pairs.length}`);
}


// Добавляет ?v=<хэш> к локальным js и css в HTML.
//
// Зачем: файлы подключались как ./js/admin.js без версии, а домен стоит за
// Cloudflare — CDN кэширует их надолго. После деплоя посетитель (и вы) может
// неделю получать старый скрипт, причём Ctrl+F5 не спасает: он сбрасывает
// кэш браузера, а запрос всё равно обслуживает край CDN. Хэш в адресе меняет
// URL при любой правке файла, поэтому новая версия подхватывается сразу и
// чистить кэш вручную больше не нужно.
async function bustCache(dir) {
  const { readFile, writeFile, readdir, stat } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");

  const hashes = new Map();
  async function hashOf(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let h = "";
    try {
      const buf = await readFile(path.join(dir, rel));
      h = createHash("sha1").update(buf).digest("hex").slice(0, 8);
    } catch {}
    hashes.set(rel, h);
    return h;
  }

  const files = [];
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".html")) files.push(full);
    }
  }
  await walk(dir);

  let n = 0;
  for (const f of files) {
    const html = await readFile(f, "utf8");
    // Путь в HTML относительный (./js/app.js или ../../js/app.js) — приводим
    // к пути от корня dist, чтобы хэш считался от того же файла.
    // Префикс бывает трёх видов: «./», «../../» и «/» от корня (так подключают
    // скрипты пререндер-страницы /p/<id>/). Ловим все, иначе 268 карточек
    // товара остаются без версий — на этом уже попались.
    const out = await replaceAsync(html, /(src|href)="((?:\.\.?\/)*|\/)((?:js|data|assets)\/[^"?#]+\.(?:js|css))"/g,
      async (m, attr, prefix, rel) => {
        const h = await hashOf(rel);
        return h ? `${attr}="${prefix}${rel}?v=${h}"` : m;
      });
    if (out !== html) { await writeFile(f, out); n++; }
  }
  console.log(`✓ версии скриптов: обновлено ссылок в ${n} страницах`);
}

// String.replace не умеет async-заменители, поэтому собираем вручную.
async function replaceAsync(str, re, fn) {
  const parts = [];
  let last = 0;
  for (const m of str.matchAll(re)) {
    parts.push(str.slice(last, m.index), await fn(...m));
    last = m.index + m[0].length;
  }
  parts.push(str.slice(last));
  return parts.join("");
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
    let cat = g.__CATALOG__ || { products: [], categories: [] };

    // Актуальный каталог из воркера (KV): цены правятся в CRM и через прайс,
    // а файл в репозитории отстаёт. Пререндер, sitemap и фиды должны видеть
    // то же, что покупатель на сайте. Файл src/data/products.js при этом НЕ
    // перезаписывается: CRM использует его как резервный полный каталог
    // (со скрытыми позициями), а публичный API скрытые не отдаёт.
    // CATALOG_SOURCE=local — собрать строго из файла (офлайн, отладка).
    if (process.env.CATALOG_SOURCE !== "local") {
      const am = cfgSrc.match(/apiBase:\s*"([^"]+)"/);
      const api = (process.env.CATALOG_API || (am ? am[1] : "")).replace(/\/$/, "");
      if (api) {
        try {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 15000);
          const r = await fetch(`${api}/api/products`, { signal: ac.signal, headers: { "Cache-Control": "no-cache" } });
          clearTimeout(t);
          if (!r.ok) throw new Error("HTTP " + r.status);
          const live = await r.json();
          const localVisible = (cat.products || []).filter((p) => !p.hidden).length;
          const n = Array.isArray(live.products) ? live.products.length : 0;
          // Защита от пустого/битого ответа: не пересобираем сайт на обрывке.
          if (n < Math.max(20, Math.floor(localVisible * 0.5))) {
            throw new Error(`в ответе ${n} товаров при ${localVisible} в файле — похоже на сбой`);
          }
          cat = { ...cat, ...live, categories: live.categories || cat.categories, meta: { ...(cat.meta || {}), ...(live.meta || {}) } };
          console.log(`✓ каталог из воркера: ${n} товаров (${api})`);
        } catch (e) {
          console.warn(`⚠ каталог из воркера недоступен (${e.message}) — собираю из src/data/products.js`);
        }
      }
    } else {
      console.log("• CATALOG_SOURCE=local — каталог из src/data/products.js");
    }

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
    // Статические страницы. admin.html и prices.html НЕ включаем: они закрыты
    // в robots.txt и помечены noindex — в карте сайта им не место.
    urls.add(`${SITE}/privacy.html`);
    urls.add(`${SITE}/terms.html`);
    (cat.products || [])
      .filter((p) => !p.hidden)
      .forEach((p) => urls.add(`${SITE}/p/${encodeURIComponent(p.id)}/`));
    const today = new Date().toISOString().slice(0, 10);
    const body = [...urls]
      .map((u) => `  <url><loc>${u.replace(/&/g, "&amp;")}</loc><lastmod>${today}</lastmod></url>`)
      .join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
    await writeFile(path.join(dist, "sitemap.xml"), xml);
    console.log(`✓ sitemap.xml: ${urls.size} URL`);
    // Редиректы пишем ПОСЛЕ sitemap: старые адреса в карту сайта не попадают.
    await writeIdRedirects(dist, SITE);

    // 4c) Подстановка контактов и счётчика — ПОСЛЕ пререндера.
    //
    // Порядок критичен, и раньше он был неверным: оба шага выполнялись до
    // генерации карточек, поэтому 268 страниц /p/<id>/ оставались с
    // заглушками «+7 000 000-00-00» и «ваш город» и без счётчика Метрики.
    // Именно эти страницы и видят посетители из поиска.
    await substituteContacts(dist);
    await injectMetrika(dist);

    // 4d) Версионирование локальных скриптов и стилей.
    await bustCache(dist);
  } catch (e) {
    console.warn("sitemap/prerender generation skipped:", e.message);
  }

  console.log("✓ Сборка готова: ./dist");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
