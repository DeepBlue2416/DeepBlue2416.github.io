// scripts/prerender.js — build-time пререндер карточек товаров для SEO.
// Из каталога генерирует статические страницы dist/p/<id>/index.html:
//   • бот (Googlebot/YandexBot) читает готовый HTML — H1, цена, наличие, описание,
//     характеристики, JSON-LD, canonical — БЕЗ выполнения JS;
//   • пользователь получает тот же контент мгновенно, затем product.js «оживляет»
//     страницу в интерактивную карточку (гидратация: render() заменяет #product-root).
// Чистая генерация на Node (без браузера) — ложится в обычный `npm run build`.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const escA = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const esc = escA;
const money = (n, cur) => new Intl.NumberFormat("ru-RU").format(Math.round(n || 0)) + " " + (cur || "₽");
const statusText = (s) => (s === "in_stock" ? "В наличии" : "Под заказ 1–2 дня");

// Абсолютизируем пути шаблона под глубину /p/<id>/ (2 уровня от корня).
function absolutizePaths(html) {
  return html
    .replace(/(href|src)="\.\//g, '$1="/')
    .replace(/href="favicon\.svg"/g, 'href="/favicon.svg"')
    .replace(/href="favicon\.ico"/g, 'href="/favicon.ico"')
    .replace(/href="apple-touch-icon\.png"/g, 'href="/apple-touch-icon.png"')
    .replace(/href="index\.html#catalog"/g, 'href="/#catalog"')
    .replace(/href="index\.html"/g, 'href="/"');
}

function seriesVariants(all, name) { return all.filter((x) => x.name === name); }

function staticBody(p, all, SITE, cur, city) {
  const img = (Array.isArray(p.images) && p.images[0]) ? "/" + String(p.images[0]).replace(/^\//, "") : "/apple-touch-icon.png";
  const sub = [p.storage && p.storage !== "—" ? p.storage : p.watchSize, p.color].filter(Boolean).join(" · ");
  const specBase = [
    ["Бренд", p.brand], ["Категория", p.category], ["Модель", p.series],
    p.storage && p.storage !== "—" ? ["Память", p.storage] : null,
    p.watchSize ? ["Размер корпуса", p.watchSize] : null,
    ["Цвет", p.color], p.sim && p.sim !== "—" ? ["SIM", p.sim] : null,
    p.region ? ["Регион", p.region] : null,
  ].filter(Boolean);
  const rows = specBase.concat(p.specs ? Object.entries(p.specs) : []).slice(0, 16);
  const specTrs = rows.map(([k, v], i) =>
    `<tr class="${i ? "border-t border-black/[0.06]" : ""}"><td class="p-4 text-ink-mute w-1/2 sm:w-1/3 align-top">${esc(k)}</td><td class="p-4 text-ink-soft font-medium">${esc(v)}</td></tr>`
  ).join("");
  const badge = p.status === "in_stock"
    ? `<span class="chip chip-green"><span class="w-1.5 h-1.5 rounded-full bg-apple-green"></span>В наличии</span>`
    : `<span class="chip chip-amber">Под заказ 1–2 дня</span>`;
  return `
      <nav class="text-sm text-ink-mute mb-6 flex items-center gap-1.5 flex-wrap">
        <a href="/" class="hover:text-ink">Главная</a><span>/</span>
        <a href="/#cat=${encodeURIComponent(p.category)}" class="hover:text-ink">${esc(p.category)}</a><span>/</span>
        <span class="text-ink">${esc(p.series)}</span>
      </nav>
      <div class="grid lg:grid-cols-2 gap-8 lg:gap-12">
        <div class="card-media relative block aspect-square rounded-3xl overflow-hidden media-plate shadow-card grid place-items-center">
          <img src="${escA(img)}" alt="${escA(p.series + " " + (p.color || ""))}" class="max-h-[86%] max-w-[86%] object-contain" loading="eager" decoding="async">
        </div>
        <div>
          <h1 class="text-3xl sm:text-4xl font-semibold tracking-tight">${esc(p.series)}</h1>
          <p class="text-ink-mute mt-1">${esc(sub)}</p>
          <div class="mt-4">${badge}</div>
          <div class="mt-6 rounded-3xl bg-cloud-card shadow-card p-5">
            <div class="flex items-end justify-between gap-4 flex-wrap">
              <div><div class="text-xs text-ink-mute">Наличными</div><div class="text-3xl font-semibold tracking-tight">${Number(p.priceCash) > 0 ? money(p.priceCash, cur) : "Уточняйте у менеджера"}</div></div>
              ${Number(p.priceCash) > 0 ? `<div class="text-right"><div class="text-xs text-ink-mute">Картой / в кредит</div><div class="text-lg font-medium text-ink-soft">${money(p.priceCard, cur)}</div></div>` : ""}
            </div>
            <a href="#" class="btn-primary w-full mt-5" data-buy>Оформить заявку</a>
          </div>
          <ul class="mt-6 space-y-2 text-sm text-ink-soft">
            <li class="flex gap-2"><span class="text-brand">✓</span> Оригинальная техника, гарантия магазина</li>
            <li class="flex gap-2"><span class="text-brand">✓</span> Доставка по городу и самовывоз</li>
            <li class="flex gap-2"><span class="text-brand">✓</span> Trade-In и рассрочка 0-0-12</li>
          </ul>
        </div>
      </div>
      <div class="mt-12 prose-sm max-w-none text-ink-soft leading-relaxed space-y-3">
        <h2 class="text-xl font-semibold tracking-tight mb-4 text-ink">Описание</h2>
        <div class="space-y-3">
          ${productCopy(p, cur, city)}
        </div>
      </div>
      <div class="mt-12">
        <h2 class="text-xl font-semibold tracking-tight mb-4">Характеристики</h2>
        <div class="rounded-3xl bg-cloud-card shadow-card overflow-hidden">
          <table class="w-full text-sm"><tbody>${specTrs}</tbody></table>
        </div>
      </div>`;
}


// Связный текст для карточки товара.
//
// Зачем: раньше на странице были только характеристики — те же, что у всех
// конкурентов, слово в слово от производителя. Для поиска это слабое место:
// уникального текста на странице нет, ранжировать нечем. Здесь текст
// собирается из полей самого товара, поэтому у каждой из 292 карточек он
// свой — отличается моделью, памятью, цветом, комплектацией SIM и регионом.
//
// Текст намеренно без рекламных превосходных степеней: они не помогают в
// выдаче и создают риск по недостоверной рекламе.
function productCopy(p, cur, city) {
  const name = p.series || p.name;
  const cat = p.category || "";
  const st = p.storage && p.storage !== "—" ? p.storage : "";
  const color = p.color || "";
  const hasPrice = Number(p.priceCash) > 0;

  // Первый абзац: что это, в какой комплектации, почём.
  const what = [
    `${name}${st ? ` на ${st}` : ""}${color ? ` в цвете «${color}»` : ""} — ` +
      `${p.status === "in_stock" ? "в наличии" : "под заказ"} в магазине «Apple и точка» в ${city}.`,
    hasPrice
      ? `Цена за наличные — ${money(p.priceCash, cur)}, по карте — ${money(p.priceCard, cur)}.`
      : `Актуальную цену уточняйте у менеджера — она зависит от курса и партии поставки.`,
  ].join(" ");

  // Второй абзац: то, чего нет у конкурентов — комплектация SIM и регион.
  const details = [];
  if (p.sim && p.sim !== "—") {
    const simText = {
      "2 eSIM": "две eSIM без физического лотка",
      "SIM + eSIM": "один слот под физическую nano-SIM плюс eSIM",
      "2 SIM": "два физических слота nano-SIM",
      "2 SIM + eSIM": "два физических слота nano-SIM плюс eSIM",
      eSIM: "только eSIM",
    }[p.sim];
    if (simText) details.push(`Комплектация SIM: ${simText}.`);
  }
  if (p.region) {
    details.push(`Регион поставки — ${p.region}: от этого зависит комплектация SIM, на работу в России это не влияет.`);
  }
  if (p.specs && p.specs["Код модели"]) {
    details.push(`Код модели — ${p.specs["Код модели"]}.`);
  }

  // Третий абзац: условия покупки, одинаковые для всех.
  const how = `Проверяем устройство при вас перед покупкой. Принимаем старую технику в зачёт по Trade-In, ` +
    `оформляем кредит через банк-партнёр. Доставим по городу или заберёте сами в ТЦ «Мармелад» на площади Мира, 7. ` +
    `Гарантия магазина — 12 месяцев.`;

  return [what, details.join(" "), how].filter(Boolean)
    .map((t) => `<p>${t.replace(/\s+/g, " ").trim()}</p>`).join("\n          ");
}

function seoHead(p, SITE, cur, city) {
  const purl = `${SITE}/p/${encodeURIComponent(p.id)}/`;
  const img = (Array.isArray(p.images) && p.images[0]) ? `${SITE}/` + String(p.images[0]).replace(/^\//, "") : `${SITE}/apple-touch-icon.png`;
  // Заголовок строим под то, как ищут: «купить <модель> <память> в <городе>».
  // Цена в title заметно поднимает кликабельность в выдаче, а у нас она
  // отличается по каждой модификации — значит заголовки уникальны.
  const titleBits = [
    p.series,
    p.storage !== "—" ? p.storage : p.watchSize,
    p.color,
    p.sim && p.sim !== "—" ? p.sim : null,
    // Регион добавляем последним: у региональных версий совпадают модель,
    // объём, цвет и SIM, и без него заголовки дублируются.
    p.region || null,
  ].filter(Boolean);
  const title = `Купить ${titleBits.join(" ")} в ${city}` +
    (Number(p.priceCash) > 0 ? ` — ${money(p.priceCash, cur)}` : " — цена по запросу") +
    ` | Apple и точка`;
  const desc = `${p.series} ${p.color || ""} ${p.storage !== "—" ? p.storage : ""} ${Number(p.priceCash) > 0 ? "— цена от " + money(p.priceCash, cur) : "— уточняйте цену у менеджера"}. ${statusText(p.status)}. Trade-In, кредит, гарантия магазина «Apple и точка».`.replace(/\s+/g, " ").trim();
  const product = {
    "@context": "https://schema.org", "@type": "Product",
    name: `${p.series}${p.storage && p.storage !== "—" ? " " + p.storage : ""}${p.color ? " " + p.color : ""}`,
    image: [img], description: (p.specs && p.specs["Тип"]) ? `${p.series} — ${p.specs["Тип"]}` : p.series,
    brand: { "@type": "Brand", name: p.brand || "Apple" }, category: p.category, sku: p.id,
    // Offer выводим только когда цена известна. Раньше при её отсутствии
    // уходил price: 0 — а это утверждение «товар бесплатный», поисковики
    // читают его буквально и показывают нулевую цену в выдаче.
    ...(Number(p.priceCash) > 0
      ? { offers: { "@type": "Offer", url: purl, priceCurrency: "RUB", price: p.priceCash,
          availability: p.status === "in_stock" ? "https://schema.org/InStock" : "https://schema.org/PreOrder",
          itemCondition: "https://schema.org/NewCondition", seller: { "@type": "Organization", name: "Apple и точка" } } }
      : {}),
  };
  const crumbs = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Главная", item: SITE + "/" },
      { "@type": "ListItem", position: 2, name: p.category, item: `${SITE}/#cat=${encodeURIComponent(p.category)}` },
      { "@type": "ListItem", position: 3, name: p.series, item: purl },
    ],
  };
  return { title, desc, purl, img,
    tags:
      `<meta property="og:title" content="${escA(title)}" />\n` +
      `<meta property="og:description" content="${escA(desc)}" />\n` +
      `<meta property="og:type" content="product" />\n` +
      `<meta property="og:url" content="${escA(purl)}" />\n` +
      `<meta property="og:image" content="${escA(img)}" />\n` +
      `<meta property="og:site_name" content="Apple и точка" />\n` +
      `<meta property="og:locale" content="ru_RU" />\n` +
      `<meta name="twitter:card" content="summary_large_image" />\n` +
      `<script type="application/ld+json">${JSON.stringify(product)}</script>\n` +
      `<script type="application/ld+json">${JSON.stringify(crumbs)}</script>` };
}

export async function prerender(dist, root, SITE, catalog) {
  const cur = (catalog.meta && catalog.meta.currency) || "₽";
  const city = "Таганроге";
  let tpl = await readFile(path.join(root, "src/product.html"), "utf8");
  tpl = absolutizePaths(tpl);
  // Страница лежит на /p/<id>/ (2 уровня). Клиентский product.js при гидратации
  // подставляет ОТНОСИТЕЛЬНЫЕ пути картинок (assets/...), которые иначе резолвятся от
  // /p/<id>/ и 404-ятся. <base href="/"> заставляет все относительные пути считаться от корня.
  tpl = tpl.replace(/<head>/, '<head>\n  <base href="/">');
  let n = 0;
  for (const p of catalog.products) {
    // Скрытую позицию не пререндерим: страница /p/<id>/ просто не создаётся,
    // поэтому не попадёт ни в индекс, ни в выдачу.
    if (p.hidden) continue;
    const { title, desc, purl, tags } = seoHead(p, SITE, cur, city);
    let html = tpl
      // Общая картинка сайта из шаблона убирается: иначе Telegram/VK показывают
      // в превью две картинки (баннер магазина + фото), и баннер режется пополам.
      .replace(/\s*<meta property="og:image(?::width|:height)?" content="[^"]*" \/>/g, "")
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${escA(title)}</title>`)
      .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escA(desc)}" />`)
      .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${escA(purl)}" />`)
      .replace(/<\/head>/, tags + "\n</head>")
      .replace(
        /<div id="product-root"[^>]*>[\s\S]*?<\/div>\s*<\/main>/,
        `<div id="product-root" class="min-h-[80vh]">${staticBody(p, catalog.products, SITE, cur, city)}</div>\n  </main>`
      );
    const dir = path.join(dist, "p", p.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), html);
    n++;
  }
  return n;
}
