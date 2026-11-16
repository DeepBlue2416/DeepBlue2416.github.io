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

  // Откуда берём прошлую сборку:
  // 1) .seo-cache/seo-manifest.json — кэш GitHub Actions (deploy.yml, шаг
  //    «SEO cache»). Основной путь с 0.65.0: с живого сайта сборщик GitHub
  //    манифест не получал (Cloudflare не пускает его, как и к API каталога),
  //    поэтому до этого у всех 410 адресов каждый день стояла новая дата;
  // 2) живой сайт — запасной путь (локальная сборка, пустой кэш).
  let prev = {};
  let prevFrom = "";
  const cacheFile = path.join(root, ".seo-cache", "seo-manifest.json");
  try {
    prev = JSON.parse(await readFile(cacheFile, "utf8")).pages || {};
    if (Object.keys(prev).length) prevFrom = "кэш сборки";
  } catch {}
  // SEO_MANIFEST_URL — взять прошлую сборку из другого места (для проверки).
  const manifestUrl = process.env.SEO_MANIFEST_URL || `${SITE}/seo-manifest.json`;
  if (!prevFrom && (process.env.SEO_MANIFEST_URL || process.env.CATALOG_SOURCE !== "local")) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      const r = await fetch(manifestUrl, { signal: ac.signal, headers: { "Cache-Control": "no-cache" } });
      clearTimeout(t);
      if (r.ok) {
        prev = (await r.json()).pages || {};
        prevFrom = "сайт";
      } else {
        console.warn(`⚠ прошлая сборка с сайта не получена: HTTP ${r.status}`);
      }
    } catch (e) {
      console.warn(`⚠ прошлая сборка с сайта не получена: ${e.message}`);
    }
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
  const manifest = JSON.stringify({ built: today, pages });
  await writeFile(path.join(dist, "seo-manifest.json"), manifest);
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, manifest);
  } catch {}
  await writeFile(path.join(root, "indexnow-urls.json"), JSON.stringify(changed, null, 1));
  console.log(`✓ sitemap.xml: ${Object.keys(pages).length} URL · изменилось с прошлой сборки: ${changed.length}${hadPrev ? ` (прошлая сборка: ${prevFrom})` : " (прошлой сборки нет: считаем новыми все)"}`);
  if (process.env.GITHUB_ACTIONS && !hadPrev) {
    console.log("::warning title=Даты в sitemap::Прошлая сборка не найдена ни в кэше, ни на сайте: у всех страниц в sitemap сегодняшняя дата. После следующей сборки это пройдёт само.");
  }
}

// llms.txt — краткая справка о магазине для AI-ассистентов (ChatGPT, Perplexity,
// Алиса и т. п.). Базовый текст лежит в public/llms.txt, при сборке к нему
// добавляется актуальный перечень разделов каталога с ценами «от»: сайт
// пересобирается после каждого сохранения в CRM, так что цифры свежие.
async function writeLlms(dist, SITE, cat) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { catOf, slugRu } = await import("./prerender.js");
  let base = "";
  try { base = await readFile(path.join(root, "public", "llms.txt"), "utf8"); } catch { return 0; }
  const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n).replace(/\u00a0|\u202f/g, " ") + " ₽";
  const vis = (cat.products || []).filter((p) => !p.hidden);
  const byCat = new Map();
  for (const p of vis) { const c = catOf(p); if (!byCat.has(c)) byCat.set(c, new Map()); const m = byCat.get(c); if (!m.has(p.series)) m.set(p.series, []); m.get(p.series).push(p); }
  const lines = ["", "## Каталог и цены (обновляется при каждой сборке сайта)"];
  for (const [c, series] of byCat) {
    lines.push("", `### [${c}](${SITE}/catalog/${slugRu(c)}/)`);
    for (const [s, list] of series) {
      const pr = list.filter((p) => Number(p.priceCash) > 0).map((p) => Number(p.priceCash));
      const inStock = list.some((p) => p.status === "in_stock");
      // Ссылки в формате Markdown [название](адрес): так их читают AI-ассистенты
      // и проверка llms.txt в Lighthouse (голые адреса она ссылками не считает).
      lines.push(`- [${s}](${SITE}/catalog/${slugRu(c)}/${slugRu(s)}/): ${pr.length ? "от " + fmt(Math.min(...pr)) : "цена по запросу"}, ${inStock ? "есть в наличии" : "под заказ"}`);
    }
  }
  const out = base.trimEnd() + "\n" + lines.join("\n") + "\n";
  await writeFile(path.join(dist, "llms.txt"), out);
  await writeFile(path.join(dist, "llm.txt"), out);
  return vis.length;
}

// Статический каталог на главной для роботов без JavaScript.
// Каталог главной рисует app.js, а в исходном HTML блок #grid пустой. Поисковые
// роботы обычно выполняют JS, но позже и не всегда, а AI-краулеры (ChatGPT,
// Perplexity, Claude) JS не выполняют вовсе: для них на главной не было ни
// одного товара и ни одной цены. Теперь при сборке в #grid кладётся список
// разделов и моделей с ценой «от» и ссылками на страницы моделей. app.js при
// загрузке заменяет его своим каталогом, посетитель разницы не видит.
async function writeStaticHomeCatalog(dist, cat) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { catOf, slugRu } = await import("./prerender.js");
  const file = path.join(dist, "index.html");
  let html;
  try { html = await readFile(file, "utf8"); } catch { return 0; }
  const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n).replace(/\u00a0|\u202f/g, " ") + " ₽";
  const byCat = new Map();
  for (const p of (cat.products || []).filter((x) => !x.hidden)) {
    const c = catOf(p);
    if (!byCat.has(c)) byCat.set(c, new Map());
    const m = byCat.get(c);
    if (!m.has(p.series)) m.set(p.series, []);
    m.get(p.series).push(p);
  }
  let n = 0;
  const blocks = [...byCat].map(([c, series]) => {
    const items = [...series].map(([s, list]) => {
      const pr = list.filter((p) => Number(p.priceCash) > 0).map((p) => Number(p.priceCash));
      n++;
      return `<li><a href="/catalog/${slugRu(c)}/${slugRu(s)}/" class="hover:text-brand">${esc(s)}</a>${pr.length ? ` <span class="text-ink-mute">от ${fmt(Math.min(...pr))}</span>` : ""}</li>`;
    }).join("");
    return `<div class="rounded-3xl bg-cloud-card shadow-card p-5"><h3 class="font-semibold text-lg"><a href="/catalog/${slugRu(c)}/" class="hover:text-brand">${esc(c)}</a></h3><ul class="mt-2 space-y-1 text-sm">${items}</ul></div>`;
  }).join("");
  const re = /(<div id="grid"[^>]*>)(\s*)(<\/div>)/;
  if (!re.test(html)) return 0;
  html = html.replace(re, `$1${blocks}$3`);
  await writeFile(file, html);
  return n;
}

// Сжатие скриптов сайта (dist/js/*.js) перед публикацией.
//
// Исходники в src/js остаются читаемыми, сжимается только то, что уходит на
// сайт: убираются пробелы и комментарии, сокращаются имена ВНУТРИ функций.
// Скрипты подключаются обычными <script> и общаются через глобальные имена
// (CONFIG, Store, SmartSearch…), поэтому имена верхнего уровня esbuild не
// трогает: без format/bundle он их не переименовывает. Lighthouse насчитал на
// этом около 455 КБ экономии. Если esbuild не установлен, шаг пропускается.
async function minifyJs(dir) {
  const { readFile, writeFile, readdir } = await import("node:fs/promises");
  let esbuild;
  try { esbuild = await import("esbuild"); } catch { console.warn("⚠ esbuild не установлен: скрипты не сжаты"); return; }
  const jsDir = path.join(dir, "js");
  let before = 0, after = 0, n = 0;
  for (const name of await readdir(jsDir)) {
    if (!name.endsWith(".js")) continue;
    const f = path.join(jsDir, name);
    const src = await readFile(f, "utf8");
    const out = await esbuild.transform(src, { minify: true, legalComments: "none", charset: "utf8" });
    await writeFile(f, out.code);
    before += Buffer.byteLength(src); after += Buffer.byteLength(out.code); n++;
  }
  console.log(`✓ скрипты сжаты: ${n} файлов, ${Math.round(before / 1024)} → ${Math.round(after / 1024)} КБ`);
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

// JPG-копии фотографий товаров для площадок, которые не принимают WebP.
// ВКонтакте при импорте товаров берёт только JPG, PNG и GIF и молча пропускает
// товар без подходящей картинки — из-за этого импорт фида заканчивался
// сообщением «В файле нет товаров». Копии делаются при сборке, в репозиторий
// не кладутся: новое фото в WebP получит свой JPG само.
// Минимум ВК — 400×400, поэтому мелкие картинки увеличиваются до этого размера.
async function writeJpegCopies(dist) {
  const { readdir, stat } = await import("node:fs/promises");
  let sharp;
  try { sharp = (await import("sharp")).default; }
  catch { console.warn("⚠ sharp не установлен — JPG-копии фото не созданы, фид ВК останется без картинок (npm install)"); return -1; }
  const base = path.join(dist, "assets", "products");
  const files = [];
  async function walk(d) {
    let list = [];
    try { list = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.webp$/i.test(e.name)) files.push(full);
    }
  }
  await walk(base);
  let n = 0;
  for (const f of files) {
    const out = f.replace(/\.webp$/i, ".jpg");
    try { await stat(out); continue; } catch {}
    try {
      // Всегда квадрат на белом фоне, сторона от 400 до 1200 пикселей.
      const meta = await sharp(f).metadata();
      const side = Math.min(1200, Math.max(400, meta.width || 0, meta.height || 0));
      await sharp(f)
        .flatten({ background: "#ffffff" })
        .resize({ width: side, height: side, fit: "contain", background: "#ffffff" })
        .jpeg({ quality: 86, mozjpeg: true })
        .toFile(out);
      n++;
    } catch (e) { console.warn(`  jpg: ${path.relative(dist, f)} — ${e.message}`); }
  }
  return n;
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
    //
    // Порядок источников:
    //   1) API воркера (самое свежее);
    //   2) снимок src/data/catalog.live.json — его коммитит сам воркер после
    //      каждого сохранения в CRM. Нужен, потому что Cloudflare может не
    //      пускать сборщик GitHub к api.appleitochka.ru;
    //   3) src/data/products.js — старый файл, только если нет ничего лучше.
    const localVisible = (cat.products || []).filter((p) => !p.hidden).length;
    const sane = (live) => {
      const n = Array.isArray(live && live.products) ? live.products.length : 0;
      // Защита от пустого/битого ответа: не пересобираем сайт на обрывке.
      if (n < Math.max(20, Math.floor(localVisible * 0.5))) {
        throw new Error(`в ответе ${n} товаров при ${localVisible} в файле — похоже на сбой`);
      }
      return n;
    };
    const merge = (live) => ({ ...cat, ...live, categories: live.categories || cat.categories, meta: { ...(cat.meta || {}), ...(live.meta || {}) } });
    let catSource = "file";
    let apiError = "";
    if (process.env.CATALOG_SOURCE !== "local") {
      const am = cfgSrc.match(/apiBase:\s*"([^"]+)"/);
      const api = (process.env.CATALOG_API || (am ? am[1] : "")).replace(/\/$/, "");
      if (api) {
        try {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 15000);
          const r = await fetch(`${api}/api/products`, { signal: ac.signal, headers: { "Cache-Control": "no-cache" } });
          clearTimeout(t);
          if (!r.ok) throw new Error("HTTP " + r.status + (r.headers.get("cf-mitigated") ? " (проверка Cloudflare)" : ""));
          const text = await r.text();
          let live;
          try { live = JSON.parse(text); } catch { throw new Error("ответ не JSON: " + text.slice(0, 80).replace(/\s+/g, " ")); }
          const n = sane(live);
          cat = merge(live);
          catSource = "api";
          console.log(`✓ каталог из воркера: ${n} товаров (${api})`);
        } catch (e) {
          apiError = String(e.message || e).replace(/\n/g, " ");
          console.warn(`⚠ каталог из воркера недоступен (${apiError}) — пробую снимок src/data/catalog.live.json`);
        }
      }
      if (catSource === "file") {
        const snapPath = path.join(root, "src/data/catalog.live.json");
        if (existsSync(snapPath)) {
          try {
            const live = JSON.parse(await readFile(snapPath, "utf8"));
            const n = sane(live);
            cat = merge(live);
            catSource = "snapshot";
            console.log(`✓ каталог из снимка CRM: ${n} товаров (обновлён ${(live.meta && live.meta.updatedAt) || "?"})`);
            if (process.env.GITHUB_ACTIONS && apiError) {
              console.log(`::notice title=Каталог из снимка CRM::API при сборке недоступно (${apiError}), цены взяты из src/data/catalog.live.json, который воркер коммитит после каждого сохранения в CRM.`);
            }
          } catch (e) {
            console.warn(`⚠ снимок каталога не прочитан (${e.message})`);
          }
        }
      }
      if (catSource === "file") {
        console.warn("⚠ собираю из src/data/products.js (цены могут быть старыми)");
        // В GitHub Actions выводим ещё и аннотацию: она видна прямо на странице
        // запуска. Без неё сайт месяцами собирался из старого файла с ценами
        // от 5 октября, а заметить это можно было только в логе.
        if (process.env.GITHUB_ACTIONS) {
          console.log(`::warning title=Цены из старого файла::API каталога недоступно при сборке (${apiError || "не задан адрес"}), снимка src/data/catalog.live.json нет. Страницы, фиды и sitemap собраны из src/data/products.js, а не из актуальной базы. Задайте воркеру секрет GH_DISPATCH_TOKEN и сохраните что-нибудь в CRM.`);
        }
      }
    } else {
      console.log("• CATALOG_SOURCE=local — каталог из src/data/products.js");
    }

    // Встроенный каталог страниц (dist/data/products.js) — тоже актуальный.
    // Это первое, что видит покупатель до ответа API: при медленном
    // мобильном интернете ответ может идти секундами, и всё это время на
    // экране были бы цены из старого файла. CRM же нужен ПОЛНЫЙ файл со
    // скрытыми позициями (резерв на случай пустого KV), поэтому для неё
    // оригинал сохраняется как products.full.js.
    //
    // С 0.66.0 характеристики во встроенном каталоге не повторяются. У 320
    // позиций всего ~90 разных наборов (у всех цветов и объёмов одной модели
    // они одинаковые), а раньше каждый набор из ~60 полей копировался в каждую
    // позицию: две трети файла были повторами, и телефон разбирал их на каждой
    // странице. Теперь наборы лежат один раз в таблице, а у позиции только
    // номер набора; маленький код в конце файла раскладывает их обратно в
    // p.specs до запуска остальных скриптов, так что сравнение, поиск и
    // карточка работают как раньше. Делается всегда, а не только при свежих
    // ценах: из старого файла скрытые позиции тоже не должны попадать на сайт.
    try {
      await cp(path.join(dist, "data/products.js"), path.join(dist, "data/products.full.js"));
      const adminPath = path.join(dist, "admin.html");
      if (existsSync(adminPath)) {
        const a = await readFile(adminPath, "utf8");
        await writeFile(adminPath, a.replace('src="./data/products.js"', 'src="./data/products.full.js"'));
      }
      const specsTable = [];
      const specsIdx = new Map();
      const products = (cat.products || []).filter((p) => !p.hidden).map(({ specs, ...p }) => {
        if (!specs || !Object.keys(specs).length) return p;
        const key = JSON.stringify(specs);
        if (!specsIdx.has(key)) { specsIdx.set(key, specsTable.length); specsTable.push(specs); }
        return { ...p, sk: specsIdx.get(key) };
      });
      const embed = { ...cat, products, specsTable, meta: { ...(cat.meta || {}), builtAt: Date.now(), source: catSource } };
      const expand = "(function(c){var t=c&&c.specsTable;if(!t)return;c.products.forEach(function(p){if(p.sk!=null){p.specs=t[p.sk];delete p.sk;}});delete c.specsTable;})(window.__CATALOG__);";
      await writeFile(path.join(dist, "data/products.js"),
        "// Собрано scripts/build.js из актуального каталога (" + catSource + ").\nwindow.__CATALOG__ = " + JSON.stringify(embed) + ";\n" + expand + "\n");
      console.log(`✓ встроенный каталог страниц (${catSource}): ${products.length} позиций, наборов характеристик ${specsTable.length}; CRM получает products.full.js`);
      // Сам снимок на сайте не нужен: его данные уже во встроенном каталоге.
      await rm(path.join(dist, "data/catalog.live.json"), { force: true });
      // products.json — исходник генератора каталога (scripts/gen-catalog.mjs),
      // сайт его не читает. Раньше он публиковался как есть: 700 КБ старых
      // данных вместе со скрытыми позициями.
      await rm(path.join(dist, "data/products.json"), { force: true });
    } catch (e) {
      console.warn("embedded catalog skipped:", e.message);
    }

    // 4a0) JPG-копии фото — до пререндера: превью ссылок (og:image) на
    // карточках и посадочных ссылаются на .jpg, только если копии сделаны.
    try {
      const nj = await writeJpegCopies(dist);
      if (nj > 0) console.log(`✓ JPG-копии фото для ВКонтакте и превью ссылок: ${nj}`);
      if (nj >= 0) process.env.OG_JPG = "1";
    } catch (e) {
      console.warn("jpeg copies skipped:", e.message);
    }

    // 4a) Пререндер статических страниц товаров dist/p/<id>/index.html
    let dupIds = new Map();
    try {
      const { prerender } = await import("./prerender.js");
      const r = await prerender(dist, root, SITE, cat);
      dupIds = r.dups;
      console.log(`✓ пререндер карточек: ${r.n} страниц (/p/<id>/)`);
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

    // 4a-4) Статический каталог на главной (для роботов без JS)
    try {
      const nh = await writeStaticHomeCatalog(dist, cat);
      if (nh) console.log(`✓ главная: статический каталог для роботов, ${nh} моделей`);
    } catch (e) {
      console.warn("home catalog skipped:", e.message);
    }

    // 4b0) llms.txt с актуальным каталогом
    try {
      const nl = await writeLlms(dist, SITE, cat);
      if (nl) console.log(`✓ llms.txt: справка для AI-ассистентов, ${nl} позиций в сводке`);
    } catch (e) {
      console.warn("llms.txt skipped:", e.message);
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
    // Дубли (одинаковый заголовок) в карту не кладём: у них canonical на
    // основную карточку и noindex.
    (cat.products || [])
      .filter((p) => !p.hidden && !dupIds.has(p.id))
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

    // 4d) Сжатие скриптов, потом версионирование: хэш в ?v= считается
    // от того файла, который реально уходит на сайт.
    await minifyJs(dist);
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
