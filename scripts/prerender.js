// scripts/prerender.js — build-time пререндер карточек товаров для SEO.
// Из каталога генерирует статические страницы dist/p/<id>/index.html:
//   • бот (Googlebot/YandexBot) читает готовый HTML — H1, цена, наличие, описание,
//     характеристики, JSON-LD, canonical — БЕЗ выполнения JS;
//   • пользователь получает тот же контент мгновенно, затем product.js «оживляет»
//     страницу в интерактивную карточку (гидратация: render() заменяет #product-root).
// Чистая генерация на Node (без браузера) — ложится в обычный `npm run build`.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const escA = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const esc = escA;
export const money = (n, cur) => new Intl.NumberFormat("ru-RU").format(Math.round(n || 0)) + " " + (cur || "₽");
const statusText = (s) => (s === "in_stock" ? "В наличии" : "Под заказ 1–2 дня");

// Срок гарантии магазина. Он не единый: на технику — 12 месяцев, на наушники
// и на бывшие в употреблении устройства — 3 месяца. Раньше во всех текстах
// стояло «12 месяцев» без оговорок — это обещание, которое магазин не давал.
// По аксессуарам гарантия не заявляется вовсе: warrantyPhrase возвращает
// пустую строку, и блоки про гарантию на таких страницах не выводятся.
export function warrantyMonths(p) {
  const cond = String((p && (p.condition || p.state)) || "");
  if (/б\s*\/?\s*у|used|demo|витрин|уценк/i.test(cond)) return 3;
  const cat = (p && p.category) || "";
  if (cat === "Наушники") return 3;
  if (cat === "Аксессуары") return 0;
  return 12;
}

export function warrantyPhrase(p) {
  const m = warrantyMonths(p);
  if (!m) return "";
  return `гарантия магазина ${m} ${m === 3 ? "месяца" : "месяцев"}`;
}
// Первая буква заглавная — для начала предложения.
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

// Раздел каталога, в который попадает товар. Б/у и витринные отделены от
// новых: в самом товаре категория остаётся прежней (она нужна фидам и
// характеристикам), а каталог, посадочные страницы и хлебные крошки
// раскладывают позиции по этой функции. Те же правила, что в config.js на
// витрине — иначе адреса страниц и разделы на сайте разъедутся.
// Как раздел называют в поиске. Название категории в CRM («Смарт-часы»,
// «Наушники») для заголовка страницы не годится: получалось «Купить Смарт-часы
// в Таганроге» — и с заглавной посреди фразы, и мимо запроса. Формулировки
// взяты из запросов, по которым конкурент стоит в выдаче Яндекса по Таганрогу
// (выгрузка Букварикса): «купить часы таганрог», «ноутбуки таганрог»,
// «планшет купить в таганроге», «айфоны таганрог», «смартфоны таганрог».
// Раздела нет в карте — работает общий шаблон «Купить <категория>».
export const CAT_SEO = {
  "iPhone": { title: "Айфоны в Таганроге — все модели iPhone и цены", h1: "Айфоны (iPhone) в Таганроге", noun: "айфоны" },
  "Смарт-часы": { title: "Купить часы Apple Watch и смарт-часы в Таганроге", h1: "Часы Apple Watch и смарт-часы в Таганроге", noun: "смарт-часы" },
  "MacBook": { title: "Ноутбуки MacBook в Таганроге — купить Макбук", h1: "Ноутбуки MacBook в Таганроге", noun: "ноутбуки MacBook" },
  "iPad": { title: "Купить планшет iPad в Таганроге", h1: "Планшеты iPad в Таганроге", noun: "планшеты iPad" },
  "Наушники": { title: "Наушники AirPods в Таганроге — купить Аирподс", h1: "Наушники AirPods в Таганроге", noun: "наушники" },
  "Samsung": { title: "Смартфоны Samsung Galaxy в Таганроге", h1: "Смартфоны Samsung Galaxy в Таганроге", noun: "смартфоны Samsung" },
  "Аксессуары": { title: "Аксессуары для iPhone в Таганроге: зарядки и чехлы", h1: "Аксессуары для iPhone в Таганроге", noun: "аксессуары" },
};

export const USED_CAT = "Б/у";
export const USED_CAT_TITLE = "Б/у и витрина";
export function catOf(p) {
  return p && p.condition ? USED_CAT : (p && p.category) || "";
}

// Пометка состояния. Новые позиции поля condition не имеют — у них пусто.
const COND_TITLE = { used: "б/у", demo: "витринный" };
export function condLabel(p) {
  return COND_TITLE[p && p.condition] || "";
}
// Суффикс для заголовков и названий: «iPhone 15 Pro 256 ГБ Титановый, б/у».
export function condSuffix(p) {
  const t = condLabel(p);
  return t ? `, ${t}` : "";
}

// Ссылки на страницы услуг. Живут одним списком, потому что их вставляют
// и посадочные страницы, и карточки товара, и сами страницы услуг между собой:
// поисковику нужен связный граф ссылок, иначе новые адреса он обходит месяцами.
export const SERVICE_LINKS = [
  ["/trade-in/", "Trade-In"],
  ["/kredit/", "Кредит от банка"],
  ["/garantiya/", "Гарантия"],
  ["/dostavka/", "Доставка и оплата"],
  ["/kontakty/", "Контакты"],
];

export function serviceNav(current = "") {
  const items = SERVICE_LINKS.filter(([h]) => h !== current)
    .map(([h, t]) => `<a href="${h}" class="chip bg-cloud-card shadow-card hover:text-brand">${esc(t)}</a>`)
    .join("");
  return `<nav class="mt-10 flex flex-wrap gap-2" aria-label="Покупателям">${items}</nav>`;
}

// Абсолютизируем пути шаблона под глубину /p/<id>/ (2 уровня от корня).
export function absolutizePaths(html) {
  return html
    .replace(/(href|src)="\.\//g, '$1="/')
    .replace(/href="favicon\.svg"/g, 'href="/favicon.svg"')
    .replace(/href="favicon\.ico"/g, 'href="/favicon.ico"')
    .replace(/href="apple-touch-icon\.png"/g, 'href="/apple-touch-icon.png"')
    .replace(/href="index\.html#catalog"/g, 'href="/#catalog"')
    .replace(/href="index\.html"/g, 'href="/"');
}

function seriesVariants(all, name) { return all.filter((x) => x.name === name); }

// Та же формула, что window.cardPrice на сайте: наличные × 1.15, до 10 ₽.
function cardPrice(p) {
  const cash = Number(p.priceCash) || 0;
  if (cash <= 0) return 0;
  const card = Number(p.priceCard) || 0;
  return card > cash ? card : Math.round((cash * 1.15) / 10) * 10;
}

function staticBody(p, all, SITE, cur, city) {
  const img = (Array.isArray(p.images) && p.images[0]) ? "/" + String(p.images[0]).replace(/^\//, "") : "/apple-touch-icon.png";
  const sub = [p.storage && p.storage !== "—" ? p.storage : p.watchSize, p.color].filter(Boolean).join(" · ");
  const specBase = [
    ["Бренд", p.brand], ["Категория", p.category], ["Модель", p.series],
    p.storage && p.storage !== "—" ? ["Память", p.storage] : null,
    p.watchSize ? ["Размер корпуса", p.watchSize] : null,
    ["Цвет", p.color], p.sim && p.sim !== "—" ? ["SIM", p.sim] : null,
    p.region ? ["Регион", p.region] : null,
    p.condition ? ["Состояние", condLabel(p) === "б/у" ? "Б/у" : "Витринный образец"] : null,
  ].filter(Boolean);
  // Строку «Гарантия» из каталога не показываем: там у всех «12 мес.», включая
  // наушники (3 месяца) и аксессуары (гарантии нет). Считаем по правилам.
  const specsClean = Object.entries(p.specs || {}).filter(([k]) => !/гаран/i.test(k));
  const wm = warrantyPhrase(p).match(/(\d+)\s*месяц/);
  const rows = specBase.concat(wm ? [["Гарантия", wm[1] + " мес."]] : []).concat(specsClean).slice(0, 16);
  const specTrs = rows.map(([k, v], i) =>
    `<tr class="${i ? "border-t border-black/[0.06]" : ""}"><td class="p-4 text-ink-mute w-1/2 sm:w-1/3 align-top">${esc(k)}</td><td class="p-4 text-ink-soft font-medium">${esc(v)}</td></tr>`
  ).join("");
  const badge = p.status === "in_stock"
    ? `<span class="chip chip-green"><span class="w-1.5 h-1.5 rounded-full bg-apple-green"></span>В наличии</span>`
    : `<span class="chip chip-amber">Под заказ 1–2 дня</span>`;
  return `
      <nav class="text-sm text-ink-mute mb-6 flex items-center gap-1.5 flex-wrap">
        <a href="/" class="hover:text-ink">Главная</a><span>/</span>
        <a href="/catalog/${slugRu(catOf(p))}/" class="hover:text-ink">${esc(catOf(p))}</a><span>/</span>
        <a href="/catalog/${slugRu(catOf(p))}/${slugRu(p.series)}/" class="hover:text-ink">${esc(p.series)}</a><span>/</span>
        <span class="text-ink">${esc([p.storage !== "—" ? p.storage : p.watchSize, p.color].filter(Boolean).join(" · "))}</span>
      </nav>
      <div class="grid lg:grid-cols-2 gap-8 lg:gap-12">
        <div class="card-media relative block aspect-square rounded-3xl overflow-hidden media-plate shadow-card grid place-items-center">
          <img src="${escA(img)}" alt="${escA(p.series + " " + (p.color || ""))}" class="max-h-[86%] max-w-[86%] object-contain" loading="eager" decoding="async">
        </div>
        <div>
          <h1 class="text-3xl sm:text-4xl font-semibold tracking-tight">${esc(p.series)}${condLabel(p) ? `, ${esc(condLabel(p))}` : ""}</h1>
          <p class="text-ink-mute mt-1">${esc(sub)}</p>
          <div class="mt-4 flex flex-wrap items-center gap-1.5">${badge}${condLabel(p) ? `<span class="chip bg-ink/[0.06] text-ink-soft">${esc(condLabel(p).charAt(0).toUpperCase() + condLabel(p).slice(1))}</span>` : ""}</div>
          <div class="mt-6 rounded-3xl bg-cloud-card shadow-card p-5">
            <div class="flex items-end justify-between gap-4 flex-wrap">
              <div><div class="text-xs text-ink-mute">Наличными</div><div class="text-3xl font-semibold tracking-tight">${Number(p.priceCash) > 0 ? money(p.priceCash, cur) : "Уточняйте у менеджера"}</div></div>
              ${Number(p.priceCash) > 0 ? `<div class="text-right"><div class="text-xs text-ink-mute">Картой / в кредит</div><div class="text-lg font-medium text-ink-soft">${money(cardPrice(p), cur)}</div></div>` : ""}
            </div>
            ${p.priceEstimated ? `<p class="text-xs text-ink-mute mt-2">Цена ориентировочная — уточните у <a href="/#contacts" class="underline">менеджера</a>.</p>` : ""}
            <a href="#" class="btn-primary w-full mt-5" data-buy>Оформить заявку</a>
          </div>
          <ul class="mt-6 space-y-2 text-sm text-ink-soft">
            <li class="flex gap-2"><span class="text-brand">✓</span> Проверка при покупке${warrantyPhrase(p) ? ", " + esc(warrantyPhrase(p)) : ""}</li>
            <li class="flex gap-2"><span class="text-brand">✓</span> Доставка по городу и самовывоз</li>
            <li class="flex gap-2"><span class="text-brand">✓</span> Trade-In и кредит от банка-партнёра</li>
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
      </div>
      ${faqBlock(productFaq(p, cur, city))}
      <p class="mt-8 text-sm"><a href="/catalog/${slugRu(catOf(p))}/${slugRu(p.series)}/" class="text-brand hover:underline">Все модификации ${esc(p.series)} и цены →</a></p>
      ${serviceNav()}`;
}

// Вопросы-ответы для карточки. Собираются из полей товара, поэтому у каждой
// страницы они свои — это и блок для посетителя, и разметка FAQPage, по
// которой поиск иногда показывает раскрывающиеся ответы прямо в выдаче.
// У конкурентов такой разметки нет ни на одной странице — место свободно.
function productFaq(p, cur, city) {
  const name = [p.series, p.storage !== "—" ? p.storage : p.watchSize, p.color].filter(Boolean).join(" ");
  const has = Number(p.priceCash) > 0;
  const out = [];
  out.push([
    `Сколько стоит ${name} в ${city}?`,
    has
      ? `${money(p.priceCash, cur)} за наличные, ${money(cardPrice(p), cur)} картой или в кредит.` +
        (p.priceEstimated ? " Цена ориентировочная: партия ещё не пришла, точную назовёт менеджер." : "")
      : `Цена зависит от партии поставки — актуальную назовёт менеджер.`,
  ]);
  out.push([
    `Можно ли забрать ${p.series} сегодня?`,
    p.status === "in_stock"
      ? `Да, эта модификация в наличии. Магазин в ТЦ «Мармелад», площадь Мира 7, ${city} — заберёте в день обращения.`
      : `Эта модификация идёт под заказ, обычно 1–2 дня. Позвоните — скажем точный срок по вашей комплектации.`,
  ]);
  if (p.sim && p.sim !== "—") {
    const simText = {
      "2 eSIM": "две eSIM, физического лотка нет",
      "SIM + eSIM": "один слот под физическую nano-SIM и eSIM",
      "2 SIM": "два физических слота nano-SIM",
      "2 SIM + eSIM": "два физических слота nano-SIM и eSIM",
      eSIM: "только eSIM",
    }[p.sim] || p.sim;
    out.push([`Какая комплектация SIM у этой версии?`, `${p.sim}: ${simText}. В России работает со всеми операторами.`]);
  }
  if (warrantyPhrase(p)) {
    out.push([`Какая гарантия на ${p.series}?`,
      `${cap(warrantyPhrase(p))}. Устройство распаковываем и проверяем при вас перед оплатой.`]);
  }
  out.push([`Можно сдать старый телефон в зачёт?`, `Да, работает Trade-In: оценим ваше устройство и вычтем стоимость из цены нового. Оценка бесплатная.`]);
  return out;
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
    `${name}${st ? ` на ${st}` : ""}${color ? ` в цвете «${color}»` : ""}` +
      `${p.condition === "used" ? ", бывший в употреблении" : p.condition === "demo" ? ", витринный образец" : ""} — ` +
      `${p.status === "in_stock" ? "в наличии" : "под заказ"} в магазине «Apple и точка» в ${city}.`,
    hasPrice
      ? `Цена за наличные — ${money(p.priceCash, cur)}, по карте — ${money(cardPrice(p), cur)}.`
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
    `${warrantyPhrase(p) ? cap(warrantyPhrase(p)) + "." : ""}`;

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
  const title = `Купить ${titleBits.join(" ")}${condSuffix(p)} в ${city}` +
    (Number(p.priceCash) > 0 ? ` — ${money(p.priceCash, cur)}` : " — цена по запросу") +
    ` | Apple и точка`;
  const desc = `${p.series} ${p.color || ""} ${p.storage !== "—" ? p.storage : ""} ${Number(p.priceCash) > 0 ? "— цена от " + money(p.priceCash, cur) : "— уточняйте цену у менеджера"}. ${statusText(p.status)}. Trade-In и кредит от банка${warrantyPhrase(p) ? ", " + warrantyPhrase(p) : ""}. Магазин «Apple и точка».`.replace(/\s+/g, " ").trim();
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
          // Состояние обязано совпадать с тем, что написано на странице: за
          // расхождение разметки и контента Google снимает расширенный сниппет.
          // Витринный тоже отдаём как UsedCondition: отдельного значения под
          // него в schema.org нет, а NewCondition было бы неправдой.
          itemCondition: (p.condition === "used" || p.condition === "demo")
            ? "https://schema.org/UsedCondition"
            : "https://schema.org/NewCondition",
          seller: { "@type": "Organization", name: "Apple и точка" } } }
      : {}),
  };
  const crumbs = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Главная", item: SITE + "/" },
      { "@type": "ListItem", position: 2, name: catOf(p), item: `${SITE}/catalog/${slugRu(catOf(p))}/` },
      { "@type": "ListItem", position: 3, name: p.series, item: `${SITE}/catalog/${slugRu(catOf(p))}/${slugRu(p.series)}/` },
      { "@type": "ListItem", position: 4, name: [p.storage !== "—" ? p.storage : p.watchSize, p.color].filter(Boolean).join(" "), item: purl },
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
      `<script type="application/ld+json">${JSON.stringify(crumbs)}</script>\n` +
      faqLd(productFaq(p, cur, city)) };
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

// ---------------------------------------------------------------------------
// Посадочные страницы категорий и моделей: /catalog/<категория>/ и
// /catalog/<категория>/<модель>/
// ---------------------------------------------------------------------------
// Зачем: каталог на сайте живёт в одном URL с хэшем (#cat=iPhone), а поисковик
// такие адреса отдельными страницами не считает. У конкурентов под каждую
// модель и цвет свой адрес — отсюда и позиции по запросам «купить айфон 17 про
// в таганроге». Эти страницы закрывают тот же класс запросов: у каждой свой
// заголовок, текст, перечень модификаций с ценами и ссылки на карточки.
export const slugRu = (s) => {
  const map = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
  return String(s).toLowerCase().replace(/[а-яё]/g, (c) => map[c] ?? "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
};

function landingHead(SITE, url, title, desc, extra = "") {
  return (
    `<meta property="og:title" content="${escA(title)}" />\n` +
    `<meta property="og:description" content="${escA(desc)}" />\n` +
    `<meta property="og:type" content="website" />\n` +
    `<meta property="og:url" content="${escA(url)}" />\n` +
    `<meta property="og:site_name" content="Apple и точка" />\n` +
    `<meta property="og:locale" content="ru_RU" />\n` + extra
  );
}

export function crumbsLd(SITE, items) {
  return `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: it.url })),
  })}</script>`;
}

export function faqLd(pairs) {
  pairs = (pairs || []).filter(Boolean);
  return `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: pairs.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  })}</script>`;
}

export function faqBlock(pairs) {
  // null-элементы допустимы: часть вопросов условна (например, про гарантию —
  // её нет для аксессуаров), и вызывающий код просто подставляет null.
  pairs = (pairs || []).filter(Boolean);
  return `<section class="mt-12"><h2 class="text-2xl font-semibold tracking-tight mb-4">Частые вопросы</h2>
    <div class="space-y-3">${pairs.map(([q, a]) => `<details class="rounded-2xl bg-cloud-card shadow-card p-4"><summary class="font-medium cursor-pointer">${esc(q)}</summary><p class="mt-2 text-ink-soft text-sm">${esc(a)}</p></details>`).join("")}</div></section>`;
}

const priceNote = `<p class="text-xs text-ink-mute mt-1">Цена ориентировочная — уточните у <a href="/#contacts" class="underline">менеджера</a>.</p>`;

// Текст страницы цвета.
//
// Зачем отдельная функция: страниц цветов больше сотни, и если на всех стоит
// один и тот же абзац с подставленным названием цвета, поиск считает их
// копиями друг друга и не индексирует («Страница является копией»). Здесь
// текст собирается из состава самой страницы — объёмы, комплектации SIM,
// наличие, разброс цен, — поэтому у каждого цвета он получается свой.
function colorCopy(series, col, list, min, cur, city) {
  const st = [...new Set(list.map((p) => p.storage).filter((x) => x && x !== "—"))];
  const sims = [...new Set(list.map((p) => p.sim).filter((x) => x && x !== "—"))];
  const inStock = list.filter((p) => p.status === "in_stock").length;
  const priced = list.filter((p) => Number(p.priceCash) > 0).map((p) => p.priceCash);
  const max = priced.length ? Math.max(...priced) : 0;

  const p1 = `${series} в цвете «${col}»${st.length ? ` — ${st.length === 1 ? "объём " + st[0] : "объёмы " + st.join(", ")}` : ""}` +
    `${sims.length ? `, комплектации SIM: ${sims.join(", ")}` : ""}. ` +
    (min ? (max && max !== min ? `Цены от ${money(min, cur)} до ${money(max, cur)} за наличные.` : `Цена ${money(min, cur)} за наличные.`) : "Цену уточняйте у менеджера.");

  const p2 = inStock
    ? `Из этого цвета ${inStock === list.length ? "все модификации" : `${inStock} из ${list.length} модификаций`} есть в наличии — можно забрать в день обращения в ТЦ «Мармелад», площадь Мира 7, ${city}.`
    : `Этот цвет сейчас под заказ: привозим обычно за 1–2 дня, забрать можно в ТЦ «Мармелад», площадь Мира 7, ${city}.`;

  const p3 = `Цвет корпуса на характеристики не влияет — процессор, камеры, экран и автономность у всех версий ${series} одинаковые, ` +
    `отличается только отделка. Устройство распаковываем и проверяем при вас, работает Trade-In и кредит от банка-партнёра.`;

  return [p1, p2, p3].map((t) => `<p class="mt-3 text-ink-soft max-w-2xl">${esc(t)}</p>`).join("\n          ");
}

function colorFaq(series, col, list, min, cur, city) {
  const inStock = list.filter((p) => p.status === "in_stock").length;
  const st = [...new Set(list.map((p) => p.storage).filter((x) => x && x !== "—"))];
  return [
    [`Сколько стоит ${series} ${col.toLowerCase()} в ${city}?`,
      min ? `От ${money(min, cur)} за наличные — зависит от объёма памяти. Точную цену на нужную модификацию назовёт менеджер.` : `Цену уточняйте у менеджера: она зависит от партии поставки.`],
    [`Есть ли ${series} ${col.toLowerCase()} в наличии?`,
      inStock ? `Да, ${inStock} ${inStock === 1 ? "модификация" : "модификаций"} этого цвета в наличии в магазине на площади Мира 7.` : `Сейчас этот цвет под заказ — привозим за 1–2 дня. Позвоните, назовём точный срок.`],
    st.length > 1 ? [`Какие объёмы памяти бывают в этом цвете?`, `${st.join(", ")}. Если нужного объёма нет на складе, привезём под заказ.`] : null,
    [`Отличается ли ${col.toLowerCase()} от других цветов по характеристикам?`,
      `Нет. Отличается только цвет корпуса, начинка у всех версий ${series} одна и та же.`],
  ].filter(Boolean);
}

export async function buildLandings(dist, root, SITE, catalog, city = "Таганроге") {
  const cur = (catalog.meta && catalog.meta.currency) || "₽";
  let tpl = await readFile(path.join(root, "src/product.html"), "utf8");
  tpl = absolutizePaths(tpl)
    .replace(/<head>/, '<head>\n  <base href="/">')
    // product.js ждёт /p/<id>/ и на этих страницах только мешает
    .replace(/\s*<script src="\/js\/product\.js"><\/script>/, "");

  const visible = (catalog.products || []).filter((p) => !p.hidden);
  const byCat = new Map();
  for (const p of visible) {
    const ck = catOf(p);
    if (!byCat.has(ck)) byCat.set(ck, []);
    byCat.get(ck).push(p);
  }

  const page = async (dirParts, title, desc, bodyHtml, headExtra) => {
    const url = `${SITE}/${dirParts.join("/")}/`;
    const html = tpl
      .replace(/\s*<meta property="og:image(?::width|:height)?" content="[^"]*" \/>/g, "")
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${escA(title)}</title>`)
      .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escA(desc)}" />`)
      .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${escA(url)}" />`)
      .replace(/<\/head>/, landingHead(SITE, url, title, desc, headExtra) + "\n</head>")
      .replace(
        /<div id="product-root"[^>]*>[\s\S]*?<\/div>\s*<\/main>/,
        `<div id="product-root" class="min-h-[70vh]">${bodyHtml}</div>\n  </main>`
      );
    const dir = path.join(dist, ...dirParts);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), html);
    return url;
  };

  const urls = [];
  for (const [cat, items] of byCat) {
    const catSlug = slugRu(cat);
    const series = [...new Set(items.map((p) => p.series))];
    const priced = items.filter((p) => Number(p.priceCash) > 0);
    const from = priced.length ? Math.min(...priced.map((p) => p.priceCash)) : 0;

    // Раздел б/у — не «купить Б/у в Таганроге»: у него свой заголовок и свой
    // текст, иначе получается косноязычно и мимо запроса.
    const isUsed = cat === USED_CAT;

    // ---- страница категории ----
    const catTitle = isUsed
      ? `Купить б/у айфон в ${city} — ${USED_CAT_TITLE} | Apple и точка`
      : CAT_SEO[cat] ? `${CAT_SEO[cat].title} | Apple и точка` : `Купить ${cat} в ${city} — цены и наличие | Apple и точка`;
    const catDesc = isUsed
      ? `Б/у и витринные iPhone, iPad, Apple Watch и MacBook в ${city}. ${priced.length ? "Цены от " + money(from, cur) + ". " : ""}Каждое устройство проверяем при вас, гарантия магазина 3 месяца. ТЦ «Мармелад», площадь Мира 7.`
      : `${CAT_SEO[cat] ? CAT_SEO[cat].h1 : cat + " в " + city}: ${series.slice(0, 6).join(", ")}. ${priced.length ? "Цены от " + money(from, cur) + ". " : ""}Проверка при покупке, кредит от банка, Trade-In. ТЦ «Мармелад», площадь Мира 7.`;
    const tiles = series.map((s) => {
      const list = items.filter((p) => p.series === s);
      const pr = list.filter((p) => Number(p.priceCash) > 0);
      const min = pr.length ? Math.min(...pr.map((p) => p.priceCash)) : 0;
      return `<a href="/catalog/${catSlug}/${slugRu(s)}/" class="block rounded-2xl bg-cloud-card shadow-card p-4 hover:shadow-lg transition">
        <div class="font-semibold">${esc(s)}</div>
        <div class="text-sm text-ink-mute mt-0.5">${list.length} ${list.length % 10 === 1 && list.length % 100 !== 11 ? "модификация" : "модификаций"}</div>
        <div class="mt-2 text-sm">${min ? `<span class="text-ink-mute">от</span> <span class="font-semibold">${money(min, cur)}</span>` : "Уточняйте у менеджера"}</div>
      </a>`;
    }).join("");
    const catBody = `
      <nav class="text-sm text-ink-mute mb-6 flex items-center gap-1.5 flex-wrap">
        <a href="/" class="hover:text-ink">Главная</a><span>/</span><span class="text-ink">${esc(cat)}</span>
      </nav>
      <h1 class="text-3xl sm:text-4xl font-semibold tracking-tight">${isUsed ? `Б/у айфоны и техника Apple в ${city}` : CAT_SEO[cat] ? esc(CAT_SEO[cat].h1) : `Купить ${esc(cat)} в ${city}`}</h1>
      <p class="mt-3 text-ink-soft max-w-2xl">${isUsed
        ? `Устройства, бывшие в употреблении, и витринные образцы — в магазине «Apple и точка», ТЦ «Мармелад», площадь Мира 7. ${priced.length ? "Цены начинаются от " + money(from, cur) + ". " : ""}Каждое устройство проверяем вместе с вами перед покупкой и даём гарантию магазина 3 месяца. Позиции единичные: то, что есть сегодня, завтра может разойтись — уточняйте наличие.`
        : `${CAT_SEO[cat] ? esc(CAT_SEO[cat].noun.charAt(0).toUpperCase() + CAT_SEO[cat].noun.slice(1)) : esc(cat)} в магазине «Apple и точка» — ТЦ «Мармелад», площадь Мира 7. ${priced.length ? "Цены начинаются от " + money(from, cur) + ". " : ""}Всю технику можно посмотреть и проверить при покупке, есть кредит от банка-партнёра и Trade-In: старое устройство принимаем в зачёт нового.`}</p>
      <div class="mt-8 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">${tiles}</div>
      ${faqBlock(isUsed ? [
        ["В каком состоянии техника?", "У каждой позиции состояние указано в карточке: «Б/у» — устройство было в использовании, «Витринный» — стояло в зале как образец. Осмотреть можно до покупки, ничего не торопим."],
        ["Какая гарантия на б/у?", "Гарантия магазина 3 месяца с даты покупки."],
        ["Почему так мало вариантов?", "Б/у появляется от обмена по Trade-In, поэтому позиции единичные и разбираются быстро. Скажите, что ищете, — сообщим, когда появится."],
        ["Можно проверить перед покупкой?", `Да, обязательно: включаем устройство при вас, смотрим экран, корпус, камеры, ёмкость аккумулятора. Магазин в ТЦ «Мармелад», площадь Мира 7, ${city}.`],
      ] : [
        [`Можно ли посмотреть ${cat} перед покупкой?`, `Да. Магазин находится в ТЦ «Мармелад» на площади Мира 7 в ${city}. Устройство распакуют и проверят при вас.`],
        ["Техника новая?", "Да, новая и оригинальная. Состояние и комплектацию проверяем вместе с покупателем при продаже."],
        ["Есть ли кредит и Trade-In?", "Да. Кредит оформляем через банк-партнёр, старое устройство принимаем в зачёт нового — стоимость выкупа назовёт менеджер."],
      ])}
      ${serviceNav()}`;
    urls.push(await page(["catalog", catSlug], catTitle, catDesc, catBody,
      crumbsLd(SITE, [{ name: "Главная", url: SITE + "/" }, { name: cat, url: `${SITE}/catalog/${catSlug}/` }]) +
      faqLd([[isUsed ? "Какая гарантия на б/у технику?" : `Можно ли посмотреть ${cat} перед покупкой?`, isUsed ? "Гарантия магазина 3 месяца с даты покупки." : `Да, магазин в ТЦ «Мармелад», площадь Мира 7.`]])));

    // ---- страницы моделей ----
    for (const s of series) {
      const list = items.filter((p) => p.series === s);
      const pr = list.filter((p) => Number(p.priceCash) > 0);
      const min = pr.length ? Math.min(...pr.map((p) => p.priceCash)) : 0;
      const colors = [...new Set(list.map((p) => p.color).filter(Boolean))];
      const storages = [...new Set(list.map((p) => p.storage).filter((x) => x && x !== "—"))];
      const sims = [...new Set(list.map((p) => p.sim).filter((x) => x && x !== "—"))];
      const url = `${SITE}/catalog/${catSlug}/${slugRu(s)}/`;
      const sName = isUsed ? `${s} б/у` : s;
      const title = `Купить ${sName} в ${city}${min ? " — от " + money(min, cur) : ""} | Apple и точка`;
      const desc = `${sName} в ${city}: ${storages.length ? storages.join(", ") + ". " : ""}${colors.length ? "Цвета: " + colors.slice(0, 5).join(", ") + ". " : ""}${min ? "Цена от " + money(min, cur) + ". " : ""}Проверка при покупке, кредит, Trade-In. ТЦ «Мармелад», площадь Мира 7.`;
      const rows = list
        .slice()
        .sort((a, b) => (a.priceCash || 1e9) - (b.priceCash || 1e9))
        .map((p) => `<tr class="border-t border-black/[0.06]">
          <td class="p-3"><a class="hover:text-brand" href="/p/${encodeURIComponent(p.id)}/">${esc([p.storage !== "—" ? p.storage : p.watchSize, p.color].filter(Boolean).join(" · "))}</a>${condLabel(p) ? `<span class="ml-1.5 chip bg-ink/[0.06] text-ink-soft text-[11px] py-0 px-1.5">${esc(condLabel(p))}</span>` : ""}</td>
          <td class="p-3 text-ink-mute">${esc(p.sim && p.sim !== "—" ? p.sim : "")}</td>
          <td class="p-3 text-ink-mute">${statusText(p.status)}</td>
          <td class="p-3 font-medium whitespace-nowrap">${Number(p.priceCash) > 0 ? money(p.priceCash, cur) + (p.priceEstimated ? " ≈" : "") : "Уточняйте у менеджера"}</td>
        </tr>`).join("");
      const est = list.some((p) => p.priceEstimated);
      const body = `
        <nav class="text-sm text-ink-mute mb-6 flex items-center gap-1.5 flex-wrap">
          <a href="/" class="hover:text-ink">Главная</a><span>/</span>
          <a href="/catalog/${catSlug}/" class="hover:text-ink">${esc(cat)}</a><span>/</span>
          <span class="text-ink">${esc(s)}</span>
        </nav>
        <h1 class="text-3xl sm:text-4xl font-semibold tracking-tight">Купить ${esc(sName)} в ${city}</h1>
        <p class="mt-3 text-ink-soft max-w-2xl">${esc(s)} ${storages.length ? "в объёмах " + storages.join(", ") + ". " : ""}${colors.length ? "Цвета: " + colors.join(", ") + ". " : ""}${sims.length ? "Комплектации SIM: " + sims.join(", ") + ". " : ""}Магазин «Apple и точка» в ТЦ «Мармелад», площадь Мира 7 — устройство проверяем при вас, есть кредит от банка-партнёра и Trade-In.</p>
        ${est ? priceNote : ""}
        ${colors.length > 1 ? `<div class="mt-6 flex flex-wrap gap-2">${colors.map((c) => `<a href="/catalog/${catSlug}/${slugRu(s)}/${slugRu(c)}/" class="chip bg-cloud-card shadow-card hover:text-brand">${esc(c)}</a>`).join("")}</div>` : ""}
        <div class="mt-6 overflow-x-auto rounded-2xl bg-cloud-card shadow-card">
          <table class="w-full text-sm"><thead><tr class="text-left text-ink-mute"><th class="p-3 font-medium">Модификация</th><th class="p-3 font-medium">SIM</th><th class="p-3 font-medium">Наличие</th><th class="p-3 font-medium">Цена</th></tr></thead><tbody>${rows}</tbody></table>
        </div>
        <p class="mt-4 text-sm"><a href="/#cat=${encodeURIComponent(cat)}&series=${encodeURIComponent(s)}" class="text-brand hover:underline">Открыть ${esc(s)} в каталоге с фото и фильтрами →</a></p>
        ${(() => {
          // Ссылки на соседние модели той же категории. Без них страницы
          // моделей висят листьями: робот доходит до них только с категории,
          // и вес по сайту не перетекает.
          const sib = series.filter((x) => x !== s).slice(0, 10);
          if (!sib.length) return "";
          return `<section class="mt-10"><h2 class="text-xl font-semibold tracking-tight mb-3">Другие модели ${esc(cat)}</h2>
          <div class="flex flex-wrap gap-2">${sib.map((x) => `<a href="/catalog/${catSlug}/${slugRu(x)}/" class="chip bg-cloud-card shadow-card hover:text-brand">${esc(x)}</a>`).join("")}</div></section>`;
        })()}
        ${serviceNav()}
        ${faqBlock([
          [`Сколько стоит ${sName} в ${city}?`, min ? `Цены начинаются от ${money(min, cur)} за наличные. Точную цену на нужную комплектацию уточняйте у менеджера — она зависит от поставки.` : `Цену уточняйте у менеджера: она зависит от поставки.`],
          [`Можно ли забрать ${s} сегодня?`, `Позиции со статусом «В наличии» можно забрать сразу в ТЦ «Мармелад». Остальные привозим под заказ, обычно за 1–2 дня.`],
          warrantyPhrase(list[0])
            ? [`Какая гарантия на ${s}?`, `${cap(warrantyPhrase(list[0]))} с даты покупки. Что она покрывает — на странице «Гарантия».`]
            : null,
        ])}`;
      // ---- страницы цветов ----
      // Запросы вида «айфон 17 про синий купить» ищут отдельно, и у конкурентов
      // под каждый цвет свой адрес. Делаем так же: страница цвета показывает
      // только его модификации.
      for (const col of colors) {
        const clist = list.filter((p) => p.color === col);
        const cpr = clist.filter((p) => Number(p.priceCash) > 0);
        const cmin = cpr.length ? Math.min(...cpr.map((p) => p.priceCash)) : 0;
        const curl = `${SITE}/catalog/${catSlug}/${slugRu(s)}/${slugRu(col)}/`;
        const ctitle = `Купить ${sName} ${col.toLowerCase()} в ${city}${cmin ? " — от " + money(cmin, cur) : ""} | Apple и точка`;
        const cdesc = `${s} в цвете «${col}» в ${city}. ${[...new Set(clist.map((p) => p.storage).filter((x) => x && x !== "—"))].join(", ")}. ${cmin ? "Цена от " + money(cmin, cur) + ". " : ""}Проверка при покупке, кредит, Trade-In. ТЦ «Мармелад», площадь Мира 7.`;
        const crows = clist
          .slice()
          .sort((a, b) => (a.priceCash || 1e9) - (b.priceCash || 1e9))
          .map((p) => `<tr class="border-t border-black/[0.06]">
            <td class="p-3"><a class="hover:text-brand" href="/p/${encodeURIComponent(p.id)}/">${esc([p.storage !== "—" ? p.storage : p.watchSize, p.sim && p.sim !== "—" ? p.sim : ""].filter(Boolean).join(" · "))}</a>${condLabel(p) ? `<span class="ml-1.5 chip bg-ink/[0.06] text-ink-soft text-[11px] py-0 px-1.5">${esc(condLabel(p))}</span>` : ""}</td>
            <td class="p-3 text-ink-mute">${statusText(p.status)}</td>
            <td class="p-3 font-medium whitespace-nowrap">${Number(p.priceCash) > 0 ? money(p.priceCash, cur) + (p.priceEstimated ? " ≈" : "") : "Уточняйте у менеджера"}</td>
          </tr>`).join("");
        const cbody = `
          <nav class="text-sm text-ink-mute mb-6 flex items-center gap-1.5 flex-wrap">
            <a href="/" class="hover:text-ink">Главная</a><span>/</span>
            <a href="/catalog/${catSlug}/" class="hover:text-ink">${esc(cat)}</a><span>/</span>
            <a href="/catalog/${catSlug}/${slugRu(s)}/" class="hover:text-ink">${esc(s)}</a><span>/</span>
            <span class="text-ink">${esc(col)}</span>
          </nav>
          <h1 class="text-3xl sm:text-4xl font-semibold tracking-tight">Купить ${esc(sName)} ${esc(col.toLowerCase())} в ${city}</h1>
          ${colorCopy(s, col, clist, cmin, cur, city)}
          ${clist.some((p) => p.priceEstimated) ? priceNote : ""}
          <div class="mt-6 overflow-x-auto rounded-2xl bg-cloud-card shadow-card">
            <table class="w-full text-sm"><thead><tr class="text-left text-ink-mute"><th class="p-3 font-medium">Модификация</th><th class="p-3 font-medium">Наличие</th><th class="p-3 font-medium">Цена</th></tr></thead><tbody>${crows}</tbody></table>
          </div>
          ${colors.length > 1 ? `<div class="mt-6"><div class="text-sm text-ink-mute mb-2">Другие цвета ${esc(s)}:</div><div class="flex flex-wrap gap-2">${colors.filter((c) => c !== col).map((c) => `<a href="/catalog/${catSlug}/${slugRu(s)}/${slugRu(c)}/" class="chip bg-cloud-card shadow-card hover:text-brand">${esc(c)}</a>`).join("")}</div></div>` : ""}
          <p class="mt-4 text-sm"><a href="/catalog/${catSlug}/${slugRu(s)}/" class="text-brand hover:underline">Все модификации ${esc(s)} с ценами →</a></p>
          ${faqBlock(colorFaq(s, col, clist, cmin, cur, city))}
          ${serviceNav()}`;
        urls.push(await page(["catalog", catSlug, slugRu(s), slugRu(col)], ctitle, cdesc, cbody,
          crumbsLd(SITE, [
            { name: "Главная", url: SITE + "/" },
            { name: cat, url: `${SITE}/catalog/${catSlug}/` },
            { name: s, url },
            { name: col, url: curl },
          ]) + faqLd(colorFaq(s, col, clist, cmin, cur, city))));
      }

      urls.push(await page(["catalog", catSlug, slugRu(s)], title, desc, body,
        crumbsLd(SITE, [
          { name: "Главная", url: SITE + "/" },
          { name: cat, url: `${SITE}/catalog/${catSlug}/` },
          { name: s, url },
        ]) +
        `<script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org", "@type": "ItemList",
          itemListElement: list.slice(0, 30).map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/p/${encodeURIComponent(p.id)}/`, name: `${p.series} ${p.storage !== "—" ? p.storage : ""} ${p.color}`.replace(/\s+/g, " ").trim() })),
        })}</script>` +
        faqLd([[`Сколько стоит ${s} в ${city}?`, min ? `От ${money(min, cur)}.` : "Уточняйте у менеджера."]])));
    }
  }
  return urls;
}
