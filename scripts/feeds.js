// scripts/feeds.js — товарные фиды с ценами для поисковиков/маркетплейсов.
// Генерируются на сборке из каталога:
//   • dist/feed-yandex.yml  — YML (Yandex Market Language): для Яндекс Вебмастера
//     («Товары и цены»), Яндекс Бизнеса и Яндекс Маркета.
//   • dist/feed-google.xml  — RSS 2.0 с namespace g: для Google Merchant Center
//     (бесплатные карточки товаров и Google Shopping).
// Это ОСНОВНОЙ, «прямой» способ отдать Google/Яндексу структурированные цену и наличие —
// в дополнение к on-page разметке JSON-LD (которая влияет на органическую выдачу).

import { writeFile } from "node:fs/promises";
import path from "node:path";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CDATA = (s) => `<![CDATA[${String(s ?? "").replace(/]]>/g, "]]&gt;")}]]>`;

function offersOf(catalog) {
  // Только товары с положительной ценой (иначе фид невалиден).
  return (catalog.products || []).filter((p) => Number(p.priceCash) > 0);
}

function pica(p, SITE) {
  const rel = Array.isArray(p.images) && p.images[0] ? String(p.images[0]).replace(/^\//, "") : "apple-touch-icon.png";
  return `${SITE}/${rel}`;
}
const purl = (p, SITE) => `${SITE}/p/${encodeURIComponent(p.id)}/`;
const fullName = (p) => `${p.series}${p.storage && p.storage !== "—" ? " " + p.storage : ""}${p.color ? " " + p.color : ""}${p.sim && p.sim !== "—" ? " " + p.sim : ""}`.trim();
const descOf = (p) => `${fullName(p)}. ${p.status === "in_stock" ? "В наличии" : "Под заказ 1–2 дня"}. Оригинал, гарантия магазина, Trade-In, рассрочка. Apple и точка.`;

// ---- Yandex YML ----
function buildYML(catalog, SITE, brand, today) {
  const offers = offersOf(catalog);
  const cats = catalog.categories || [];
  const catId = new Map(cats.map((c, i) => [c.key, i + 1]));
  const catXml = cats.map((c, i) => `<category id="${i + 1}">${esc(c.title || c.key)}</category>`).join("\n      ");
  const offXml = offers.map((p) => {
    const params = [];
    if (p.storage && p.storage !== "—") params.push(`<param name="Память">${esc(p.storage)}</param>`);
    if (p.watchSize) params.push(`<param name="Размер корпуса">${esc(p.watchSize)}</param>`);
    if (p.color) params.push(`<param name="Цвет">${esc(p.color)}</param>`);
    if (p.sim && p.sim !== "—") params.push(`<param name="SIM">${esc(p.sim)}</param>`);
    return `    <offer id="${esc(p.id)}" available="${p.status === "in_stock" ? "true" : "false"}">
      <url>${esc(purl(p, SITE))}</url>
      <price>${Math.round(p.priceCash)}</price>
      <currencyId>RUB</currencyId>
      <categoryId>${catId.get(p.category) || 1}</categoryId>
      <picture>${esc(pica(p, SITE))}</picture>
      <vendor>${esc(p.brand || "Apple")}</vendor>
      <name>${esc(fullName(p))}</name>
      <description>${CDATA(descOf(p))}</description>
      ${params.join("\n      ")}
    </offer>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<yml_catalog date="${today}">
  <shop>
    <name>${esc(brand)}</name>
    <company>${esc(brand)}</company>
    <url>${esc(SITE)}/</url>
    <currencies>
      <currency id="RUB" rate="1"/>
    </currencies>
    <categories>
      ${catXml}
    </categories>
    <offers>
${offXml}
    </offers>
  </shop>
</yml_catalog>
`;
}

// ---- Google Merchant RSS ----
function buildGoogle(catalog, SITE, brand) {
  const offers = offersOf(catalog);
  const items = offers.map((p) => {
    const avail = p.status === "in_stock" ? "in_stock" : "preorder";
    return `    <item>
      <g:id>${esc(p.id)}</g:id>
      <g:title>${esc(fullName(p))}</g:title>
      <g:description>${esc(descOf(p))}</g:description>
      <g:link>${esc(purl(p, SITE))}</g:link>
      <g:image_link>${esc(pica(p, SITE))}</g:image_link>
      <g:availability>${avail}</g:availability>
      <g:price>${Math.round(p.priceCash)}.00 RUB</g:price>
      <g:brand>${esc(p.brand || "Apple")}</g:brand>
      <g:condition>new</g:condition>
      <g:identifier_exists>no</g:identifier_exists>
      <g:product_type>${esc(p.category)}</g:product_type>
    </item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${esc(brand)}</title>
    <link>${esc(SITE)}/</link>
    <description>Каталог техники Apple и смежных брендов — цены и наличие.</description>
${items}
  </channel>
</rss>
`;
}

export async function buildFeeds(dist, SITE, catalog, brand) {
  const today = new Date().toISOString().slice(0, 10);
  const nOffers = offersOf(catalog).length;
  await writeFile(path.join(dist, "feed-yandex.yml"), buildYML(catalog, SITE, brand || "Apple и точка", today));
  await writeFile(path.join(dist, "feed-google.xml"), buildGoogle(catalog, SITE, brand || "Apple и точка"));
  return nOffers;
}
