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
// Иконки <i data-lucide="…"> превращаются в SVG только после загрузки JS, и до
// этого на телефоне видны пустые квадраты в шапке и в блоке преимуществ. Здесь
// те же SVG вставляются в HTML при сборке — иконки видны с первого кадра.
// icons.js на страницах остаётся: он нужен для разметки, которую рисует JS.
async function inlineIcons(dir) {
  const { readFile, writeFile, readdir } = await import("node:fs/promises");
  const src = await readFile(path.join(root, "src/js/icons.js"), "utf8");
  const sandbox = {};
  new Function("window", src)(sandbox);
  const svg = sandbox.lucideSVG;
  if (typeof svg !== "function") { console.warn("inlineIcons: icons.js не разобран"); return; }
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
    const out = html.replace(/<i\s+data-lucide="([^"]+)"([^>]*)>\s*<\/i>/g, (m, name, rest) => {
      if (!sandbox.ICONS || !sandbox.ICONS[name]) return m;
      const cls = (rest.match(/data-cls="([^"]*)"/) || [])[1] || "w-5 h-5";
      const sw = (rest.match(/data-sw="([^"]*)"/) || [])[1] || 2;
      n++;
      return svg(name, cls, sw);
    });
    if (out !== html) await writeFile(f, out);
  }
  console.log(`✓ иконки встроены в HTML: ${n}`);
}

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
async function writeIdRedirects(dist, SITE, catalog) {
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  let map = {};
  try { map = JSON.parse(await readFile(path.join(root, "src/data/id-redirects.json"), "utf8")); }
  catch { return; }
  // Каталог менялся после того, как файл редиректов был составлен: часть
  // «старых» адресов снова принадлежит живым товарам, а часть «новых» исчезла.
  // Раньше заглушка писалась без проверок и ЗАТИРАЛА настоящую страницу товара
  // редиректом в никуда — 20 товаров из sitemap отдавали переадресацию на 404,
  // что Search Console и показал («Страница с переадресацией», «Не найдено»).
  // Теперь заглушку пишем, только если старый адрес свободен и цель существует.
  const ids = new Set((catalog.products || []).map((p) => p.id));
  const live = new Set((catalog.products || []).filter((p) => !p.hidden).map((p) => p.id));
  let skippedTaken = 0, skippedDead = 0;
  const pairs = Object.entries(map).filter(([oldId, newId]) => {
    if (ids.has(oldId)) { skippedTaken++; return false; }
    if (!live.has(newId)) { skippedDead++; return false; }
    return true;
  });
  if (skippedTaken || skippedDead) {
    console.log(`• редиректы: пропущено ${skippedTaken} (старый адрес занят живым товаром) и ${skippedDead} (цели нет в каталоге)`);
  }
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


// sitemap.xml с честной датой изменения каждой страницы + список изменённых
// адресов для IndexNow.
//
// Раньше у всех 410 адресов в <lastmod> стояла дата сборки, а сайт
// пересобирается после каждого сохранения в CRM и ещё раз ночью. Для поиска это
// выглядело как «вчера поменялось всё», и такому lastmod он перестаёт верить —
// а это один из немногих сигналов, по которым новый сайт обходят быстрее.
//
// Как считаем: у каждой страницы берём отпечаток HTML (без меток версий ?v=,
// которые меняются от правки любого скрипта), сравниваем с отпечатком из
// прошлой сборки. Прошлую сборку берём с живого сайта — seo-manifest.json
// публикуется рядом с sitemap, так что хранить состояние в репозитории не нужно.
// Совпал отпечаток — дата остаётся прежней, нет — ставится сегодняшняя, и адрес
// попадает в indexnow-urls.json (он лежит вне dist и на сайт не публикуется).
async function writeSitemap(dist, SITE, urls) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const today = new Date().toISOString().slice(0, 10);

  let prev = {};
  // SEO_MANIFEST_URL — взять прошлую сборку из другого места (для проверки).
  const manifestUrl = process.env.SEO_MANIFEST_URL || `${SITE}/seo-manifest.json`;
  if (process.env.SEO_MANIFEST_URL || process.env.CATALOG_SOURCE !== "local") {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      const r = await fetch(manifestUrl, { signal: ac.signal, headers: { "Cache-Control": "no-cache" } });
      clearTimeout(t);
      if (r.ok) prev = (await r.json()).pages || {};
    } catch {}
  }
  const hadPrev = Object.keys(prev).length > 0;

  const fileOf = (u) => {
    const p = decodeURIComponent(u.replace(SITE, "")) || "/";
    return path.join(dist, p.endsWith("/") ? p + "index.html" : p);
  };
  const pages = {};
  const changed = [];
  for (const u of urls) {
    let html = "";
    try { html = await readFile(fileOf(u), "utf8"); } catch { continue; } // нет файла — в карту не кладём
    const norm = html.replace(/\?v=[0-9a-f]{8}/g, "");
    const h = createHash("sha1").update(norm).digest("hex").slice(0, 12);
    const old = prev[u];
    const same = !!old && old.h === h;
    pages[u] = { h, d: same ? old.d : today };
    // «Изменилась» — только если отпечаток другой. Не по дате: сайт
    // пересобирается несколько раз в день, и страница, поменявшаяся утром,
    // иначе улетала бы в IndexNow при каждой следующей сборке.
    if (!same) changed.push(u);
  }

  const body = Object.entries(pages)
    .map(([u, { d }]) => `  <url><loc>${u.replace(/&/g, "&amp;")}</loc><lastmod>${d}</lastmod></url>`)
    .join("\n");
  await writeFile(path.join(dist, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
  await writeFile(path.join(dist, "seo-manifest.json"), JSON.stringify({ built: today, pages }));
  await writeFile(path.join(root, "indexnow-urls.json"), JSON.stringify(changed, null, 1));
  console.log(`✓ sitemap.xml: ${Object.keys(pages).length} URL · изменилось с прошлой сборки: ${changed.length}${hadPrev ? "" : " (прошлой сборки нет — считаем новыми все)"}`);
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

    // 4a-2) Посадочные страницы категорий и моделей (SEO)
    let landingUrls = [];
    try {
      const { buildLandings } = await import("./prerender.js");
      landingUrls = await buildLandings(dist, root, SITE, cat, "Таганроге");
      console.log(`✓ посадочные страницы: ${landingUrls.length} (/catalog/...)`);
    } catch (e) {
      console.warn("landings skipped:", e.message);
    }

    // 4a-3) Страницы услуг: Trade-In, кредит, гарантия, доставка, контакты.
    // Отдельные адреса под запросы об условиях покупки — каталогом они не
    // закрываются, а спрос на них в Таганроге есть.
    let pageUrls = [];
    try {
      const { buildPages } = await import("./pages.js");
      pageUrls = await buildPages(dist, root, SITE, cat, "Таганроге");
      console.log(`✓ страницы услуг: ${pageUrls.length}`);
    } catch (e) {
      console.warn("pages skipped:", e.message);
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
    for (const u of landingUrls) urls.add(u);
    for (const u of pageUrls) urls.add(u);
    // Статические страницы. admin.html и prices.html НЕ включаем: они закрыты
    // в robots.txt и помечены noindex — в карте сайта им не место.
    urls.add(`${SITE}/privacy.html`);
    urls.add(`${SITE}/terms.html`);
    (cat.products || [])
      .filter((p) => !p.hidden)
      .forEach((p) => urls.add(`${SITE}/p/${encodeURIComponent(p.id)}/`));
    // Старые адреса в карту сайта не попадают: заглушки пишутся отдельно.
    await writeIdRedirects(dist, SITE, cat);

    // 4c) Подстановка контактов и счётчика — ПОСЛЕ пререндера.
    //
    // Порядок критичен, и раньше он был неверным: оба шага выполнялись до
    // генерации карточек, поэтому 268 страниц /p/<id>/ оставались с
    // заглушками «+7 000 000-00-00» и «ваш город» и без счётчика Метрики.
    // Именно эти страницы и видят посетители из поиска.
    await substituteContacts(dist);
    await inlineIcons(dist);
    await injectMetrika(dist);

    // 4d) Версионирование локальных скриптов и стилей.
    await bustCache(dist);

    // 4e) sitemap.xml с настоящими датами изменения — САМЫМ последним шагом,
    // когда HTML уже окончательный. Дата берётся из сравнения с прошлой
    // сборкой, см. writeSitemap().
    await writeSitemap(dist, SITE, [...urls]);
  } catch (e) {
    console.warn("sitemap/prerender generation skipped:", e.message);
  }

  console.log("✓ Сборка готова: ./dist");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
