// worker/tg-feeds.js — товарные фиды для ВК, 2ГИС и Яндекс.Карт, генерируемые
// НА ЛЕТУ из KV.
//
// ЗАЧЕМ ИЗ ВОРКЕРА, А НЕ ИЗ СБОРКИ: scripts/build.js берёт цены из статического
// src/data/products.js. Если цену применили в KV (через CRM или предложения из
// прайса), витрина её покажет — app.js дозапрашивает /api/products, — но фиды в
// dist/ останутся старыми до следующей пересборки. Площадки читают фид по ссылке
// раз в сутки, и получали бы устаревшие цены. Воркер отдаёт фид из того же KV,
// что и витрина, поэтому цена всегда одна и та же во всех каналах.
//
// Ограничения площадок учтены (проверено по их докам):
//   ВК:    YML по ссылке, файл ≤8 МБ, ≤15 000 товаров, НЕ БОЛЕЕ 4 свойств
//          (<param>) у товара — поэтому для ВК набор параметров урезан.
//   2ГИС:  YML или CSV по ссылке; робот обходит раз в сутки (до 3 суток на
//          появление). Отдаём оба формата, CSV — для ручной загрузки.
//   Карты: YML, формат как в существующем feed-yandex-maps.yml.

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Полное имя товара. Регион обязателен в имени: у региональных версий
// совпадают модель+память+цвет+SIM, и без него площадка получит несколько
// товаров с одинаковым названием и склеит или отклонит их.
function fullName(p) {
  return [
    p.series || p.name,
    p.storage && p.storage !== "—" ? p.storage : "",
    p.watchSize || "",
    p.color || "",
    p.sim && p.sim !== "—" ? p.sim : "",
    p.region ? `(${p.region})` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const inStock = (p) => p.status !== "on_order";
// Позиции без цены в фиды не отдаём: площадки либо отклонят оффер, либо
// покажут «0 ₽». Черновики в каталоге бывают — это нормально, их просто нет в фиде.
// Скрытые (hidden) и без цены в фиды не попадают: площадка иначе поведёт
// покупателя на страницу, которой нет.
const sellable = (p) => !p.hidden && Number(p.priceCash) > 0;

function absUrl(base, rel) {
  if (!rel) return "";
  if (/^https?:\/\//.test(rel)) return rel;
  return base.replace(/\/$/, "") + "/" + String(rel).replace(/^\//, "");
}

// ---------------------------------------------------------------------------
// ВК: ≤4 <param> на товар
// ---------------------------------------------------------------------------
// Выбраны самые значимые для покупателя: память, цвет, SIM, регион. Экран/чип
// намеренно не отдаём — лимит 4 свойства, и при превышении ВК отклоняет импорт.
function vkParams(p) {
  const out = [];
  if (p.storage && p.storage !== "—") out.push(["Память", p.storage]);
  if (p.watchSize) out.push(["Размер", p.watchSize]);
  if (p.color) out.push(["Цвет", p.color]);
  if (p.sim && p.sim !== "—") out.push(["SIM", p.sim]);
  if (p.region) out.push(["Регион", p.region]);
  return out.slice(0, 4);
}

function buildYml(catalog, opts) {
  const { shopName, siteUrl, platform } = opts;
  const products = (catalog.products || []).filter(sellable);
  const cats = catalog.categories || [];
  const date = new Date().toISOString().slice(0, 19).replace("T", " ");

  const catLines = cats
    .map((c, i) => `      <category id="${i + 1}">${esc(c.title || c.key)}</category>`)
    .join("\n");
  const catId = (key) => {
    const i = cats.findIndex((c) => c.key === key);
    return i >= 0 ? i + 1 : 1;
  };

  const offers = products
    .map((p) => {
      const url = `${siteUrl.replace(/\/$/, "")}/p/${p.id}/`;
      const pics = (p.images || [])
        .slice(0, 10)
        .map((im) => `        <picture>${esc(absUrl(siteUrl, im))}</picture>`)
        .join("\n");

      // Для ВК режем параметры до 4; для 2ГИС/Карт отдаём полный набор.
      const params =
        platform === "vk"
          ? vkParams(p)
          : [
              ...vkParams(p),
              ...Object.entries(p.specs || {}).map(([k, v]) => [k, v]),
            ].slice(0, 20); // лимита у 2ГИС нет, но 60+ свойств только раздувают фид

      const paramLines = params
        .filter(([k, v]) => k && v)
        .map(([k, v]) => `        <param name="${esc(k)}">${esc(v)}</param>`)
        .join("\n");

      return [
        `      <offer id="${esc(p.id)}" available="${inStock(p) ? "true" : "false"}">`,
        `        <name>${esc(fullName(p))}</name>`,
        `        <url>${esc(url)}</url>`,
        `        <price>${Math.round(p.priceCash)}</price>`,
        `        <currencyId>RUR</currencyId>`,
        `        <categoryId>${catId(p.category)}</categoryId>`,
        pics,
        p.brand ? `        <vendor>${esc(p.brand)}</vendor>` : "",
        paramLines,
        `      </offer>`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<yml_catalog date="${date}">
  <shop>
    <name>${esc(shopName)}</name>
    <company>${esc(shopName)}</company>
    <url>${esc(siteUrl)}</url>
    <currencies>
      <currency id="RUR" rate="1"/>
    </currencies>
    <categories>
${catLines}
    </categories>
    <offers>
${offers}
    </offers>
  </shop>
</yml_catalog>
`;
}

// ---------------------------------------------------------------------------
// 2ГИС: CSV для ручной загрузки
// ---------------------------------------------------------------------------
// Разделитель — точка с запятой, BOM в начале: без него Excel на Windows
// ломает кириллицу, а прайс обычно проверяют именно в Excel.
function buildCsv(catalog, opts) {
  const { siteUrl } = opts;
  const rows = [["Название", "Цена", "Валюта", "Категория", "Бренд", "Наличие", "Ссылка", "Фото"]];
  for (const p of (catalog.products || []).filter(sellable)) {
    rows.push([
      fullName(p),
      Math.round(p.priceCash),
      "RUB",
      p.category || "",
      p.brand || "",
      inStock(p) ? "в наличии" : "под заказ",
      `${siteUrl.replace(/\/$/, "")}/p/${p.id}/`,
      absUrl(siteUrl, (p.images || [])[0]),
    ]);
  }
  const cell = (v) => {
    const s = String(v ?? "");
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "\uFEFF" + rows.map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Роутинг фидов
// ---------------------------------------------------------------------------
// Кэш на 10 минут: площадки опрашивают раз в сутки, но ссылку могут дёргать
// и вручную при отладке — незачем каждый раз перечитывать KV и пересобирать XML.
const FEED_CACHE = "public, max-age=600";

async function handleFeed(url, env, KV_KEY) {
  const m = url.pathname.match(/^\/feed\/(vk|2gis|yandex-maps)\.(yml|csv)$/);
  if (!m) return null;
  const [, platform, ext] = m;

  const raw = await env.PRODUCTS.get(KV_KEY);
  if (!raw) {
    return new Response("catalog_not_seeded", { status: 503 });
  }
  const catalog = JSON.parse(raw);

  const opts = {
    shopName: env.SHOP_NAME || "Apple и точка",
    siteUrl: env.SITE_URL || "https://appleitochka.ru",
    platform,
  };

  if (ext === "csv") {
    return new Response(buildCsv(catalog, opts), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${platform}-price.csv"`,
        "Cache-Control": FEED_CACHE,
      },
    });
  }

  return new Response(buildYml(catalog, opts), {
    status: 200,
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": FEED_CACHE },
  });
}

export { handleFeed, buildYml, buildCsv, fullName, vkParams };
