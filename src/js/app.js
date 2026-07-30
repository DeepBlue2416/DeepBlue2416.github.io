// app.js — Основная логика витрины «Apple и точка»
// classic script: CONFIG, Store, SmartSearch, Compare, TradeIn берутся из
// глобальной области (соответствующие файлы подключаются раньше в HTML).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

const state = {
  all: [],
  categories: [],
  currency: CONFIG.currency,
  // Иерархический каталог: 1 — категории, 2 — серии/модели, 3 — модификации
  level: 1,
  category: "",   // выбранная категория (L2/L3)
  series: "",     // выбранная серия (L3)
  filters: { series: "", storage: "", watchSize: "", color: "", sim: "" },
  sort: "new",    // new | cheap | expensive
  favOnly: false,
  searchIndex: null,
};

// ------------------------------------------------------------------
// Загрузка каталога: приоритет — Worker/KV (реальное время), fallback — локальный JSON
// ------------------------------------------------------------------
async function loadProducts() {
  const embedded = window.__CATALOG__ || { products: [], categories: [] };
  try {
    if (CONFIG.apiBase) {
      const r = await fetch(`${CONFIG.apiBase}/api/products`, { cache: "no-cache" });
      if (r.ok) {
        const data = await r.json();
        if (data && Array.isArray(data.products)) return data;
      }
    }
  } catch (e) {
    console.warn("Worker недоступен, использую встроенный каталог:", e);
  }
  return embedded;
}

// ------------------------------------------------------------------
// Иерархический каталог: L1 категории → L2 серии → L3 модификации
// ------------------------------------------------------------------
function categoryPool() {
  return state.category ? state.all.filter((p) => p.category === state.category) : state.all;
}
function uniq(pool, field) {
  return Array.from(new Set(pool.map((p) => p[field]).filter((v) => v && v !== "—")));
}
function storageRank(s) {
  const m = String(s).match(/([\d.]+)\s*(ТБ|GB|ГБ|TB)/i);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (/Т|T/i.test(m[2])) n *= 1024;
  return n;
}
function uniqStorages(pool) {
  return uniq(pool, "storage").sort((a, b) => storageRank(a) - storageRank(b));
}
function uniqWatchSizes(pool) {
  return Array.from(new Set(pool.map((p) => p.watchSize).filter(Boolean)))
    .sort((a, b) => parseInt(a) - parseInt(b));
}

// Серии категории — строго хронологически (новые сверху)
function seriesOfCategory(cat) {
  const map = new Map();
  state.all.filter((p) => p.category === cat).forEach((p) => {
    if (!map.has(p.series)) map.set(p.series, { series: p.series, order: p.seriesOrder || 0, items: [] });
    map.get(p.series).items.push(p);
  });
  return [...map.values()].sort((a, b) => b.order - a.order);
}

function applyFilters(list) {
  const f = state.filters;
  if (f.series) list = list.filter((p) => p.series === f.series);
  if (f.storage) list = list.filter((p) => p.storage === f.storage);
  if (f.watchSize) list = list.filter((p) => p.watchSize === f.watchSize);
  if (f.color) list = list.filter((p) => p.color === f.color);
  if (f.sim) list = list.filter((p) => p.sim === f.sim);
  if (state.favOnly) {
    const favs = Store.getFavorites();
    list = list.filter((p) => favs.includes(p.id));
  }
  return list;
}
function sortList(list) {
  const arr = list.slice();
  if (state.sort === "cheap") arr.sort((a, b) => a.priceCash - b.priceCash);
  else if (state.sort === "expensive") arr.sort((a, b) => b.priceCash - a.priceCash);
  else arr.sort((a, b) => (b.seriesOrder || 0) - (a.seriesOrder || 0) || a.priceCash - b.priceCash);
  return arr;
}

// ---------- Роутер каталога (hash) ----------
function parseHash() {
  const h = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  const cat = h.get("cat") || "";
  const series = h.get("series") || "";
  if (!cat) { state.level = 1; state.category = ""; state.series = ""; }
  else if (!series) { state.level = 2; state.category = cat; state.series = ""; }
  else { state.level = 3; state.category = cat; state.series = series; }
  state.filters = { series: "", storage: "", watchSize: "", color: "", sim: "" };
}
function navigate({ level, category, series }) {
  state.level = level;
  state.category = category || "";
  state.series = series || "";
  state.filters = { series: "", storage: "", watchSize: "", color: "", sim: "" };
  const parts = [];
  if (state.category) parts.push("cat=" + encodeURIComponent(state.category));
  if (state.series) parts.push("series=" + encodeURIComponent(state.series));
  const target = parts.length ? "#" + parts.join("&") : "#catalog";
  history.pushState(null, "", target);
  renderCatalog();
  $("#catalog")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Хлебные крошки ----------
function renderBreadcrumb() {
  const el = $("#breadcrumb");
  if (!el) return;
  const c = [`<button class="hover:text-ink transition ${state.level === 1 ? "text-ink font-semibold" : ""}" data-nav-home>Каталог</button>`];
  if (state.level >= 2) c.push(`<span>/</span>`, `<button class="hover:text-ink transition ${state.level === 2 ? "text-ink font-semibold" : ""}" data-nav-cat>${esc(state.category)}</button>`);
  if (state.level >= 3) c.push(`<span>/</span>`, `<span class="text-ink font-semibold">${esc(state.series)}</span>`);
  el.innerHTML = `<nav class="flex items-center gap-2 text-sm text-ink-mute flex-wrap">${c.join("")}</nav>`;
  $("[data-nav-home]", el)?.addEventListener("click", () => navigate({ level: 1 }));
  $("[data-nav-cat]", el)?.addEventListener("click", () => navigate({ level: 2, category: state.category }));
}

// ---------- Диспетчер ----------
function renderCatalog() {
  renderBreadcrumb();
  const filters = $("#filters");
  if (state.level === 1) {
    filters?.classList.add("hidden");
    renderCategoryTiles();
  } else {
    filters?.classList.remove("hidden");
    renderFilters();
    if (state.level === 2) renderSeriesTiles();
    else renderModifications();
  }
}
// renderProducts — совместимость: перерисовать текущий уровень
function renderProducts() { renderCatalog(); }

// L1 — плашки категорий
function renderCategoryTiles() {
  const grid = $("#grid");
  if (!grid) return;
  $("#grid-empty")?.classList.add("hidden");
  grid.className = "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-5";
  const count = (key) => state.all.filter((p) => p.category === key).length;
  grid.innerHTML = state.categories
    .map(
      (c) => `
    <button class="cat-tile" data-cat-tile="${esc(c.key)}" style="--accent:${c.accent || "#0582F6"}">
      <div class="cat-tile-art">${deviceGlyph({ category: c.glyph || "accessory", colorHex: "#ffffff" }, 88)}</div>
      <div class="mt-3 flex items-end justify-between gap-2">
        <span class="font-semibold text-base sm:text-lg leading-tight">${c.title}</span>
        <span class="text-xs text-ink-mute whitespace-nowrap">${count(c.key)}</span>
      </div>
    </button>`
    )
    .join("");
  if ($("#result-count")) $("#result-count").textContent = `${state.categories.length} категорий`;
  $$("[data-cat-tile]", grid).forEach((b) => b.addEventListener("click", () => navigate({ level: 2, category: b.dataset.catTile })));
}

// L2 — серии/модели категории
function renderSeriesTiles() {
  const grid = $("#grid");
  if (!grid) return;
  grid.className = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5";
  const accent = state.categories.find((c) => c.key === state.category)?.accent || "#0582F6";
  let series = seriesOfCategory(state.category)
    .map((s) => ({ ...s, filtered: applyFilters(s.items), from: Math.min(...applyFilters(s.items).map((p) => p.priceCash)) }))
    .filter((s) => s.filtered.length);
  // Сортировка серий (работает на 2-м уровне)
  if (state.sort === "cheap") series.sort((a, b) => a.from - b.from);
  else if (state.sort === "expensive") series.sort((a, b) => b.from - a.from);
  else series.sort((a, b) => b.order - a.order); // новые
  if (!series.length) {
    grid.innerHTML = "";
    $("#grid-empty")?.classList.remove("hidden");
    if ($("#result-count")) $("#result-count").textContent = "0 моделей";
    return;
  }
  $("#grid-empty")?.classList.add("hidden");
  if ($("#result-count")) $("#result-count").textContent = plural(series.length, "модель", "модели", "моделей");
  grid.innerHTML = series
    .map((s) => {
      const inStock = s.filtered.some((p) => p.status === "in_stock");
      const rep = pickRep(s.filtered);
      const from = s.from;
      return `
    <button class="card text-left" data-series-tile="${esc(s.series)}">
      <div class="series-art h-40 rounded-2xl overflow-hidden grid place-items-center" style="--accent:${accent}">${deviceGlyph(rep, 96)}</div>
      <div class="mt-4 flex items-start justify-between gap-2">
        <div>
          <h3 class="font-semibold text-lg leading-tight">${esc(s.series)}</h3>
          <p class="text-sm text-ink-mute mt-0.5">${plural(s.filtered.length, "товар", "товара", "товаров")}</p>
        </div>
        ${inStock
          ? `<span class="chip chip-green shrink-0"><span class="w-1.5 h-1.5 rounded-full bg-apple-green"></span>В наличии</span>`
          : `<span class="chip chip-amber shrink-0">Под заказ</span>`}
      </div>
      <div class="mt-3 text-sm"><span class="text-ink-mute">от</span> <span class="font-semibold text-base">${fmt(from)} ${state.currency}</span></div>
    </button>`;
    })
    .join("");
  $$("[data-series-tile]", grid).forEach((b) => b.addEventListener("click", () => navigate({ level: 3, category: state.category, series: b.dataset.seriesTile })));
}

// L3 — модификации серии (карточка на каждый цвет)
function renderModifications() {
  const grid = $("#grid");
  if (!grid) return;
  grid.className = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5";
  let list = sortList(applyFilters(state.all.filter((p) => p.series === state.series && p.category === state.category)));
  const byColor = new Map();
  list.forEach((p) => { if (!byColor.has(p.colorHex)) byColor.set(p.colorHex, []); byColor.get(p.colorHex).push(p); });
  const cards = [...byColor.values()].map((vs) => ({ rep: pickRep(vs), variants: vs }));
  if (!cards.length) {
    grid.innerHTML = "";
    $("#grid-empty")?.classList.remove("hidden");
    if ($("#result-count")) $("#result-count").textContent = "0 товаров";
    return;
  }
  $("#grid-empty")?.classList.add("hidden");
  if ($("#result-count")) $("#result-count").textContent = plural(list.length, "вариант", "варианта", "вариантов");
  state.modelVariants = {};
  cards.forEach((c) => (state.modelVariants[c.rep.name] = c.variants));
  grid.innerHTML = cards.map((c) => productCard(c.rep, c.variants)).join("");
  $$("article[data-id]", grid).forEach(wireCard);
}

// ---------- Контекстные фильтры + сортировка ----------
function renderFilters() {
  const wrap = $("#filters");
  if (!wrap) return;
  const pool = categoryPool();
  const isWatch = state.category === "Смарт-часы";
  const defs = [
    { key: "series", label: "Поколение", values: seriesOfCategory(state.category).map((s) => s.series) },
    !isWatch && { key: "storage", label: "Память", values: uniqStorages(pool) },
    isWatch && { key: "watchSize", label: "Размер корпуса", values: uniqWatchSizes(pool) },
    { key: "color", label: "Цвет", values: uniq(pool, "color") },
    { key: "sim", label: "SIM", values: uniq(pool, "sim") },
  ].filter(Boolean).filter((d) => d.values.length);

  const chev = `<svg class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-mute" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5.5 7.5l4.5 4.5 4.5-4.5" stroke-linecap="round"/></svg>`;
  const select = (key, label, values) => `<label class="relative">
      <select class="field appearance-none pr-9 text-sm py-2.5" data-filter="${key}">
        <option value="">${label}: все</option>
        ${values.map((o) => `<option value="${esc(o)}" ${state.filters[key] === o ? "selected" : ""}>${o}</option>`).join("")}
      </select>${chev}</label>`;

  const sortSel = `<label class="relative ml-auto">
      <select class="field appearance-none pr-9 text-sm py-2.5" data-sort>
        <option value="new" ${state.sort === "new" ? "selected" : ""}>Сначала новые</option>
        <option value="cheap" ${state.sort === "cheap" ? "selected" : ""}>Сначала дешевле</option>
        <option value="expensive" ${state.sort === "expensive" ? "selected" : ""}>Сначала дороже</option>
      </select>${chev}</label>`;

  wrap.innerHTML = defs.map((d) => select(d.key, d.label, d.values)).join("") + sortSel;

  const reset = document.createElement("button");
  reset.className = "btn-ghost text-sm";
  reset.textContent = "Сбросить";
  reset.addEventListener("click", () => {
    state.filters = { series: "", storage: "", watchSize: "", color: "", sim: "" };
    state.favOnly = false;
    syncFavToggle();
    renderCatalog();
  });
  wrap.appendChild(reset);

  const rerenderGrid = () => (state.level === 2 ? renderSeriesTiles() : renderModifications());
  $$("[data-filter]", wrap).forEach((sel) =>
    sel.addEventListener("change", () => { state.filters[sel.dataset.filter] = sel.value; rerenderGrid(); })
  );
  $("[data-sort]", wrap)?.addEventListener("change", (e) => { state.sort = e.target.value; rerenderGrid(); });
}

function statusBadge(status) {
  return status === "in_stock"
    ? `<span class="chip chip-green"><span class="w-1.5 h-1.5 rounded-full bg-apple-green"></span>В наличии</span>`
    : `<span class="chip chip-amber"><span class="w-1.5 h-1.5 rounded-full bg-apple-amber"></span>Под заказ 1 день</span>`;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function productLink(p) {
  return `product.html?id=${encodeURIComponent(p.id)}`;
}

// ------------------------------------------------------------------
// Утилиты UX: scroll-lock, маска телефона, скелетоны
// ------------------------------------------------------------------
let _scrollLocks = 0;
function scrollLock(on) {
  if (on) {
    _scrollLocks++;
    document.body.classList.add("overflow-hidden");
  } else {
    _scrollLocks = Math.max(0, _scrollLocks - 1);
    if (_scrollLocks === 0) document.body.classList.remove("overflow-hidden");
  }
}

// Маска телефона +7 (XXX) XXX-XX-XX
function formatPhone(value) {
  let d = String(value).replace(/\D/g, "");
  if (d.startsWith("8")) d = "7" + d.slice(1);
  if (d && !d.startsWith("7")) d = "7" + d;
  d = d.slice(0, 11);
  const p = d.slice(1);
  let out = "+7";
  if (p.length) out += " (" + p.slice(0, 3);
  if (p.length >= 3) out += ") " + p.slice(3, 6);
  if (p.length >= 6) out += "-" + p.slice(6, 8);
  if (p.length >= 8) out += "-" + p.slice(8, 10);
  return out;
}
function phoneComplete(v) {
  return String(v).replace(/\D/g, "").length === 11;
}
function attachPhoneMask(input) {
  if (!input) return;
  input.setAttribute("inputmode", "tel");
  input.placeholder = "+7 (___) ___-__-__";
  input.addEventListener("input", () => { input.value = formatPhone(input.value); });
  input.addEventListener("focus", () => { if (!input.value) input.value = "+7 ("; });
}

// Skeleton-загрузчик карточек каталога
function renderSkeleton(n = 6) {
  const grid = $("#grid");
  if (!grid) return;
  grid.innerHTML = Array.from({ length: n })
    .map(
      () => `
    <div class="card">
      <div class="skeleton h-44 rounded-2xl"></div>
      <div class="skeleton h-5 w-2/3 rounded-lg mt-4"></div>
      <div class="skeleton h-4 w-1/2 rounded-lg mt-2"></div>
      <div class="skeleton h-6 w-1/3 rounded-lg mt-5"></div>
      <div class="skeleton h-11 w-full rounded-full mt-4"></div>
    </div>`
    )
    .join("");
}

function productFrames(p, size = 120) {
  if (Array.isArray(p.images) && p.images.length) {
    return p.images.map(
      (src) => `<img src="${esc(src)}" alt="${esc(p.name)}" class="max-h-[86%] max-w-[86%] object-contain" loading="lazy">`
    );
  }
  const wrap = (t) => `<div class="w-full h-full grid place-items-center" style="transform:${t}">${deviceGlyph(p, size)}</div>`;
  return [
    wrap("none"),
    wrap("rotate(-14deg) scale(.94)"),
    wrap("rotate(14deg) scale(.94)"),
    wrap("scale(1.16)"),
  ];
}

function cardMedia(p) {
  const frames = productFrames(p, 120);
  return `
    <div class="card-media relative block h-44 rounded-2xl overflow-hidden bg-cloud" data-media>
      <div class="relative h-full">
        ${frames
          .map(
            (f, i) =>
              `<div class="absolute inset-0 grid place-items-center transition-opacity duration-150 ${i === 0 ? "opacity-100" : "opacity-0"}" data-frame="${i}">${f}</div>`
          )
          .join("")}
      </div>
      ${
        frames.length > 1
          ? `<div class="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1 opacity-0 [.card-media:hover_&]:opacity-100 transition-opacity">
              ${frames.map((_, i) => `<span class="h-1 w-5 rounded-full transition-colors ${i === 0 ? "bg-ink/60" : "bg-black/15"}" data-bar="${i}"></span>`).join("")}
            </div>`
          : ""
      }
    </div>`;
}

function colorSwatches(rep, variants) {
  const seen = new Set();
  const cols = [];
  for (const v of variants) {
    if (v.colorHex && !seen.has(v.colorHex)) { seen.add(v.colorHex); cols.push(v); }
  }
  if (cols.length < 2) return "";
  return `<div class="flex items-center gap-1.5 mt-3" data-swatches>
    ${cols
      .map(
        (v) =>
          `<button class="swatch ${v.id === rep.id ? "is-active" : ""}" data-swatch="${v.id}" title="${esc(v.color)}" aria-label="${esc(v.color)}" style="--sw:${v.colorHex}"></button>`
      )
      .join("")}
  </div>`;
}

function productCard(p, variants = [p]) {
  const fav = Store.isFavorite(p.id);
  const cmp = Store.inCompare(p.id);
  const badge = p.badge
    ? `<span class="absolute left-4 top-4 z-10 chip bg-ink text-white">${p.badge}</span>`
    : "";
  return `
  <article class="card group animate-fade-up cursor-pointer" data-id="${p.id}" data-model="${esc(p.name)}" tabindex="0" role="link" aria-label="${esc(p.name)}">
    ${badge}
    <div class="absolute right-3 top-3 z-10 flex gap-1.5">
      <button class="grid place-items-center w-9 h-9 rounded-full bg-white/80 hover:bg-white shadow-sm transition" data-fav="${p.id}" title="В избранное" aria-pressed="${fav}">
        ${heartIcon(fav)}
      </button>
      <button class="grid place-items-center w-9 h-9 rounded-full bg-white/80 hover:bg-white shadow-sm transition" data-cmp="${p.id}" title="К сравнению" aria-pressed="${cmp}">
        ${scaleIcon(cmp)}
      </button>
    </div>

    ${cardMedia(p)}

    <div class="mt-4 space-y-1">
      <h3 class="font-semibold text-lg leading-tight" data-title>${p.name}</h3>
      <p class="text-sm text-ink-mute" data-sub>${[p.storage, p.color].filter((x) => x && x !== "—").join(" · ")}</p>
    </div>

    ${colorSwatches(p, variants)}

    <div class="mt-3" data-status>${statusBadge(p.status)}</div>

    <div class="mt-4">
      <div class="text-xs text-ink-mute">Наличными</div>
      <div class="text-xl font-semibold tracking-tight" data-cash>${fmt(p.priceCash)} ${state.currency}</div>
      <div class="text-xs text-ink-mute mt-0.5" data-cardprice>Картой / кредит · ${fmt(p.priceCard)} ${state.currency}</div>
    </div>

    <button class="btn-primary w-full mt-4" data-buy="${p.id}">Оформить</button>
  </article>`;
}

function pickRep(variants) {
  const inStock = variants.filter((v) => v.status === "in_stock");
  const pool = inStock.length ? inStock : variants;
  return pool.slice().sort((a, b) => a.priceCash - b.priceCash)[0];
}

function groupModels(list) {
  const map = new Map();
  for (const p of list) {
    if (!map.has(p.name)) map.set(p.name, []);
    map.get(p.name).push(p);
  }
  return [...map.values()].map((variants) => ({ rep: pickRep(variants), variants }));
}

function plural(n, one = "модель", few = "модели", many = "моделей") {
  const a = Math.abs(n) % 100, b = a % 10;
  let w = many;
  if (a < 11 || a > 14) {
    if (b === 1) w = one;
    else if (b >= 2 && b <= 4) w = few;
  }
  return `${n} ${w}`;
}

function wireCard(article) {
  const byId = (id) => state.all.find((x) => x.id === id);
  const variants = state.modelVariants[article.dataset.model] || [];

  article.querySelector("[data-fav]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    Store.toggleFavorite(article.dataset.id);
    refreshCardActions(article);
    updateCounters();
    if (state.favOnly) renderProducts();
  });
  article.querySelector("[data-cmp]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    Store.toggleCompare(article.dataset.id);
    refreshCardActions(article);
    updateCounters();
  });
  article.querySelector("[data-buy]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openLeadModal(article.dataset.id);
  });
  article.querySelectorAll("[data-swatch]").forEach((sw) =>
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = byId(sw.dataset.swatch);
      if (v) setCardVariant(article, v, variants);
    })
  );

  setupScrubber(article.querySelector("[data-media]"));

  const goto = () => (location.href = productLink(byId(article.dataset.id) || { id: article.dataset.id }));
  article.addEventListener("click", (e) => {
    if (e.target.closest("[data-fav],[data-cmp],[data-buy],[data-swatch]")) return;
    goto();
  });
  article.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goto(); }
  });
}

function setCardVariant(article, v, variants) {
  const wrap = document.createElement("div");
  wrap.innerHTML = productCard(v, variants);
  const next = wrap.firstElementChild;
  article.replaceWith(next);
  wireCard(next);
}

function refreshCardActions(article) {
  const id = article.dataset.id;
  const fav = article.querySelector("[data-fav]");
  const cmp = article.querySelector("[data-cmp]");
  if (fav) { fav.innerHTML = heartIcon(Store.isFavorite(id)); fav.setAttribute("aria-pressed", Store.isFavorite(id)); }
  if (cmp) { cmp.innerHTML = scaleIcon(Store.inCompare(id)); cmp.setAttribute("aria-pressed", Store.inCompare(id)); }
}

// Скраббер на Pointer Events (мышь + тач). touch-action: pan-y — вертикальный скролл сохраняется.
function setupScrubber(media) {
  if (!media) return;
  media.style.touchAction = "pan-y";
  const frames = media.querySelectorAll("[data-frame]");
  const bars = media.querySelectorAll("[data-bar]");
  const n = frames.length;
  if (n <= 1) return;
  const show = (i) => {
    frames.forEach((f, k) => (f.style.opacity = k === i ? "1" : "0"));
    bars.forEach((b, k) => {
      b.classList.toggle("bg-ink/60", k === i);
      b.classList.toggle("bg-black/15", k !== i);
    });
  };
  const at = (clientX) => {
    const r = media.getBoundingClientRect();
    let i = Math.floor(((clientX - r.left) / r.width) * n);
    return Math.max(0, Math.min(n - 1, i));
  };
  let active = false;
  media.addEventListener("pointerdown", (e) => { active = true; show(at(e.clientX)); });
  media.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse" || active) show(at(e.clientX));
  });
  const reset = () => { active = false; show(0); };
  media.addEventListener("pointerup", () => { active = false; });
  media.addEventListener("pointerleave", reset);
  media.addEventListener("pointercancel", reset);
}

// ------------------------------------------------------------------
// Иконки (inline SVG, без внешних зависимостей)
// ------------------------------------------------------------------
function heartIcon(active) {
  return active
    ? `<svg viewBox="0 0 24 24" class="w-5 h-5 text-apple-red" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round">${window.ICONS.heart}</svg>`
    : lucideSVG("heart", "w-5 h-5 text-ink-mute");
}
function scaleIcon(active) {
  return lucideSVG("git-compare", "w-5 h-5 " + (active ? "text-brand" : "text-ink-mute"));
}
function deviceGlyph(p, size = 96) {
  const c = p.colorHex || "#c9c9cf";
  let cat = p.category;
  // телефоны других брендов рисуем как смартфон
  if (["Samsung", "Xiaomi", "Nothing Phone"].includes(cat)) cat = "iPhone";
  if (cat === "Наушники") cat = "AirPods";
  if (cat === "Смарт-часы") cat = "Watch";
  const common = `width="${size}" height="${size}" viewBox="0 0 96 96" fill="none"`;
  if (cat === "iPhone")
    return `<svg ${common}><rect x="30" y="12" width="36" height="72" rx="9" fill="${c}" stroke="rgba(0,0,0,.12)"/><rect x="41" y="16" width="14" height="4" rx="2" fill="rgba(0,0,0,.18)"/></svg>`;
  if (cat === "Mac")
    return `<svg ${common}><rect x="20" y="22" width="56" height="36" rx="4" fill="${c}" stroke="rgba(0,0,0,.12)"/><rect x="14" y="58" width="68" height="6" rx="3" fill="#c9c9cf"/></svg>`;
  if (cat === "iPad")
    return `<svg ${common}><rect x="26" y="14" width="44" height="68" rx="6" fill="${c}" stroke="rgba(0,0,0,.12)"/></svg>`;
  if (cat === "Watch")
    return `<svg ${common}><rect x="34" y="30" width="28" height="36" rx="8" fill="${c}" stroke="rgba(0,0,0,.12)"/><rect x="40" y="14" width="16" height="18" rx="4" fill="#b7b2a8"/><rect x="40" y="64" width="16" height="18" rx="4" fill="#b7b2a8"/></svg>`;
  if (cat === "AirPods")
    return `<svg ${common}><rect x="36" y="20" width="10" height="40" rx="5" fill="${c}" stroke="rgba(0,0,0,.12)"/><rect x="50" y="20" width="10" height="40" rx="5" fill="${c}" stroke="rgba(0,0,0,.12)"/></svg>`;
  return `<svg ${common}><circle cx="48" cy="48" r="26" fill="${c}" stroke="rgba(0,0,0,.12)"/></svg>`;
}

// ------------------------------------------------------------------
// Умный поиск (FR-2.*): живой дропдаун от 2 символов
// ------------------------------------------------------------------
// Подсказки для пустого поиска (популярные запросы + категории)
function searchSuggestions() {
  const popular = ["iPhone 16 Pro", "MacBook M4", "AirPods Pro", "iPhone 15", "iPad Air", "Apple Watch"];
  const cats = (state.categories || []).map((c) => c.title);
  return `
    <div class="p-3">
      <div class="text-[11px] uppercase tracking-wide text-ink-mute px-1 mb-2">Популярное</div>
      <div class="flex flex-wrap gap-2">
        ${popular.map((q) => `<button class="btn-pill text-sm" data-suggest="${esc(q)}">${q}</button>`).join("")}
      </div>
      ${
        cats.length
          ? `<div class="text-[11px] uppercase tracking-wide text-ink-mute px-1 mt-4 mb-2">Категории</div>
             <div class="flex flex-wrap gap-2">
               ${cats.map((c) => `<button class="btn-pill text-sm" data-suggest="${esc(c)}">${c}</button>`).join("")}
             </div>`
          : ""
      }
    </div>`;
}

function setupSearch() {
  const overlay = $("#search-overlay");
  const openBtn = $("#search-open");
  if (!overlay || !openBtn) return;
  const input = $("#search-input", overlay);
  const box = $("#search-results", overlay);
  const closeBtn = $("#search-close", overlay);

  const bindSuggest = () =>
    $$("[data-suggest]", box).forEach((b) =>
      b.addEventListener("click", () => { input.value = b.dataset.suggest; render(); input.focus(); })
    );

  const render = () => {
    const q = input.value.trim();
    if (q.length < 2) { box.innerHTML = searchSuggestions(); bindSuggest(); return; }
    const hits = state.searchIndex ? state.searchIndex.query(q, 8) : [];
    if (!hits.length) {
      box.innerHTML = `<div class="p-8 text-center text-sm text-ink-mute">Ничего не найдено по «${esc(q)}»</div>`;
      return;
    }
    box.innerHTML = hits
      .map(
        ({ product: p }) => `
      <a class="flex w-full items-center gap-3 p-3 rounded-2xl hover:bg-black/[0.04] transition" href="${productLink(p)}">
        <span class="grid place-items-center w-11 h-11 rounded-xl bg-cloud shrink-0">${deviceGlyph(p, 30)}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium text-sm">${p.name}</span>
          <span class="block truncate text-xs text-ink-mute">${[p.storage, p.color].filter((x) => x && x !== "—").join(" · ")}</span>
        </span>
        <span class="text-sm font-semibold whitespace-nowrap">${fmt(p.priceCash)} ${state.currency}</span>
      </a>`
      )
      .join("");
  };

  const open = () => {
    overlay.classList.remove("hidden");
    scrollLock(true);
    render();
    setTimeout(() => input.focus(), 30);
  };
  const close = () => {
    overlay.classList.add("hidden");
    scrollLock(false);
    input.value = "";
    box.innerHTML = "";
  };

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  $("[data-search-bg]", overlay).addEventListener("click", close);
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  window.__openSearch = open;
}

// ------------------------------------------------------------------
// Модальные окна
// ------------------------------------------------------------------
function openModal(html, opts = {}) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" data-overlay>
      <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" data-overlay-bg></div>
      <div class="glass relative w-full ${opts.wide ? "sm:max-w-4xl" : "sm:max-w-lg"} max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl shadow-pop animate-scale-in">
        <button class="absolute right-4 top-4 z-10 grid place-items-center w-9 h-9 rounded-full bg-black/5 hover:bg-black/10 transition" data-close>✕</button>
        <div class="p-6 sm:p-8">${html}</div>
      </div>
    </div>`;
  scrollLock(true);
  const close = () => {
    try { opts.onClose && opts.onClose(); } catch (e) {}
    root.innerHTML = "";
    scrollLock(false);
  };
  $("[data-overlay-bg]", root).addEventListener("click", close);
  $("[data-close]", root).addEventListener("click", close);
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });
  return { close, root };
}

// ---- Лид-форма (FR-4.1 + FR-5.1: согласие 152-ФЗ) ----
function openLeadModal(productId, presetText = "") {
  const p = state.all.find((x) => x.id === productId);
  const title = p ? `Заявка: ${p.name}` : "Оставить заявку";
  const sub = p
    ? `${[p.storage, p.color].filter((x) => x && x !== "—").join(" · ")} · ${fmt(p.priceCash)} ${state.currency} наличными`
    : "Мы свяжемся с вами и ответим на вопросы";

  const html = `
    <h2 class="text-2xl font-semibold tracking-tight">${title}</h2>
    <p class="text-ink-mute mt-1">${sub}</p>
    <form id="lead-form" class="mt-6 space-y-4" novalidate>
      <input class="field" name="name" placeholder="Как к вам обращаться" autocomplete="name" required />
      <input class="field" name="phone" placeholder="Телефон" inputmode="tel" autocomplete="tel" required />
      <textarea class="field min-h-[80px]" name="comment" placeholder="Комментарий (необязательно)">${presetText}</textarea>
      <label class="flex items-start gap-3 text-sm text-ink-soft">
        <input type="checkbox" name="consent" class="mt-1 w-4 h-4 accent-apple-blue" required />
        <span>Я согласен на обработку персональных данных в соответствии с
          <a href="${CONFIG.legal.privacy}" class="text-apple-blue hover:underline" target="_blank">Политикой конфиденциальности</a> (152-ФЗ).</span>
      </label>
      
      <!-- Контейнер Cloudflare Turnstile -->
      <div id="turnstile-container" class="my-2 flex justify-center"></div>

      <button type="submit" class="btn-primary w-full">Отправить заявку</button>
      <p id="lead-status" class="text-sm text-center"></p>
    </form>
    <div class="hairline mt-6 pt-5 flex flex-wrap gap-2 justify-center">
      <a href="${CONFIG.contacts.telegram}" target="_blank" class="btn-soft text-sm">Telegram</a>
      <a href="${CONFIG.contacts.whatsapp}" target="_blank" class="btn-soft text-sm">WhatsApp</a>
      <a href="tel:${CONFIG.contacts.phoneHref}" class="btn-soft text-sm">${CONFIG.contacts.phone}</a>
    </div>`;

  let turnstileWidgetId = null;
  const { close, root } = openModal(html, {
    onClose: () => { if (window.turnstile && turnstileWidgetId != null) { try { turnstile.remove(turnstileWidgetId); } catch (e) {} } },
  });
  const form = $("#lead-form", root);
  const status = $("#lead-status", root);
  attachPhoneMask(form.querySelector('[name="phone"]'));

  // Рендерим виджет Turnstile в модальном окне
  if (window.turnstile && CONFIG.turnstileSiteKey) {
    setTimeout(() => {
      const container = $("#turnstile-container", root);
      if (container) {
        try {
          turnstileWidgetId = turnstile.render(container, {
            sitekey: CONFIG.turnstileSiteKey,
          });
        } catch (err) {
          console.warn("Ошибка отрисовки Turnstile:", err);
        }
      }
    }, 50);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.consent) {
      status.textContent = "Необходимо согласие на обработку персональных данных.";
      status.className = "text-sm text-center text-apple-red";
      return;
    }
    if (!data.name || !phoneComplete(data.phone)) {
      status.textContent = "Введите имя и полный номер телефона.";
      status.className = "text-sm text-center text-apple-red";
      return;
    }

    // Извлекаем токен капчи
    const cfToken = form.querySelector('[name="cf-turnstile-response"]')?.value 
      || (window.turnstile ? turnstile.getResponse(turnstileWidgetId) : "");

    status.textContent = "Отправляем…";
    status.className = "text-sm text-center text-ink-mute";

    const payload = {
      name: data.name,
      phone: data.phone,
      comment: data.comment || "",
      product: p ? `${p.name} · ${p.storage} · ${p.color}` : "—",
      price: p ? `${fmt(p.priceCash)} ${state.currency}` : "—",
      page: location.href,
      turnstileToken: cfToken, // <--- Передаем токен воркеру
    };

    try {
      if (CONFIG.apiBase) {
        const r = await fetch(`${CONFIG.apiBase}/api/lead`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const resData = await r.json().catch(() => ({}));

        if (!r.ok || resData.success === false) {
          throw new Error(resData.error || "bad status " + r.status);
        }
      } else {
        // Fallback без бэкенда — открываем Telegram с преднабранным текстом
        const text = encodeURIComponent(
          `Заявка с сайта%0AТовар: ${payload.product}%0AИмя: ${payload.name}%0AТелефон: ${payload.phone}%0A${payload.comment}`
        );
        window.open(`${CONFIG.contacts.telegram}?text=${text}`, "_blank");
      }

      status.textContent = "Заявка отправлена! Мы скоро свяжемся с вами.";
      status.className = "text-sm text-center text-apple-green";
      form.reset();

      // Сбрасываем капчу
      if (window.turnstile) {
        turnstile.reset(turnstileWidgetId);
      }

      setTimeout(close, 1800);
    } catch (err) {
      console.error(" Ошибка отправки заявки:", err);
      status.textContent = "Не удалось отправить. Напишите нам в Telegram или WhatsApp.";
      status.className = "text-sm text-center text-apple-red";

      // В случае ошибки сбрасываем капчу для новой попытки
      if (window.turnstile) {
        turnstile.reset(turnstileWidgetId);
      }
    }
  });
}

// ---- Сравнение (FR-1.3) ----
function openCompareModal() {
  const html = `
    <div class="flex items-center justify-between gap-4">
      <h2 class="text-2xl font-semibold tracking-tight">Сравнение</h2>
      <button class="btn-ghost text-sm" id="cmp-clear">Очистить</button>
    </div>
    <div class="mt-5" id="cmp-body">${Compare.buildTableHTML(state.all, state.currency)}</div>`;
  const { root, close } = openModal(html, { wide: true });
  const rebind = () => {
    $("#cmp-body", root).innerHTML = Compare.buildTableHTML(state.all, state.currency);
    bind();
  };
  const bind = () => {
    $$("[data-cmp-remove]", root).forEach((b) =>
      b.addEventListener("click", () => {
        Store.toggleCompare(b.dataset.cmpRemove);
        updateCounters();
        renderProducts();
        rebind();
      })
    );
  };
  bind();
  $("#cmp-clear", root).addEventListener("click", () => {
    Store.clearCompare();
    updateCounters();
    renderProducts();
    rebind();
  });
}

// ---- Trade-In (FR-3.2, FR-3.3) ----
function openTradeInModal() {
  const modelOpts = TradeIn.MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
  const condOpts = TradeIn.CONDITIONS.map((c) => `<option value="${c.id}">${c.label}</option>`).join("");
  const batOpts = TradeIn.BATTERY.map((b) => `<option value="${b.id}">${b.label}</option>`).join("");
  const html = `
    <h2 class="text-2xl font-semibold tracking-tight">Trade-In · оценка выкупа</h2>
    <p class="text-ink-mute mt-1">Узнайте ориентировочную стоимость вашего устройства.</p>
    <div class="mt-6 grid gap-4">
      <label class="text-sm text-ink-soft">Модель
        <select class="field mt-1" id="ti-model">${modelOpts}</select>
      </label>
      <label class="text-sm text-ink-soft">Память
        <select class="field mt-1" id="ti-storage"></select>
      </label>
      <label class="text-sm text-ink-soft">Состояние корпуса
        <select class="field mt-1" id="ti-cond">${condOpts}</select>
      </label>
      <label class="text-sm text-ink-soft">Ёмкость аккумулятора
        <select class="field mt-1" id="ti-bat">${batOpts}</select>
      </label>
    </div>
    <div class="mt-6 rounded-3xl bg-cloud p-6 text-center">
      <div class="text-xs text-ink-mute">Ориентировочная оценка</div>
      <div class="text-3xl font-semibold tracking-tight mt-1" id="ti-value">—</div>
      <div class="text-sm text-ink-mute mt-1" id="ti-range"></div>
    </div>
    <p class="mt-4 text-xs text-ink-mute leading-relaxed">
      ⚠️ Итоговая сумма выкупа определяется <b>после бесплатной диагностики устройства в магазине</b>.
      Оценка на сайте является предварительной и не является публичной офертой.
    </p>
    <button class="btn-primary w-full mt-5" id="ti-send">Записаться на диагностику</button>`;

  const { root, close } = openModal(html);
  const modelSel = $("#ti-model", root);
  const storageSel = $("#ti-storage", root);
  const condSel = $("#ti-cond", root);
  const batSel = $("#ti-bat", root);
  const valueEl = $("#ti-value", root);
  const rangeEl = $("#ti-range", root);

  const fillStorage = () => {
    storageSel.innerHTML = TradeIn.storagesFor(modelSel.value)
      .map((s) => `<option value="${s}">${s}</option>`)
      .join("");
  };
  const recalc = () => {
    const est = TradeIn.estimate({
      modelId: modelSel.value,
      storage: storageSel.value,
      conditionId: condSel.value,
      batteryId: batSel.value,
    });
    if (!est) { valueEl.textContent = "—"; rangeEl.textContent = ""; return; }
    valueEl.textContent = `${fmt(est.value)} ${state.currency}`;
    rangeEl.textContent = `диапазон ${fmt(est.min)}–${fmt(est.max)} ${state.currency} · уточняется при диагностике`;
  };
  fillStorage();
  recalc();
  [modelSel, storageSel, condSel, batSel].forEach((el) =>
    el.addEventListener("change", () => {
      if (el === modelSel) fillStorage();
      recalc();
    })
  );
  $("#ti-send", root).addEventListener("click", () => {
    close();
    const m = TradeIn.MODELS.find((x) => x.id === modelSel.value)?.label || "";
    openLeadModal(null, `Trade-In: ${m}, ${storageSel.value}. Хочу записаться на диагностику. Оценка на сайте: ${valueEl.textContent}.`);
  });
}

// ---- Заказать звонок (callback) ----
function openCallbackModal() {
  const html = `
    <h2 class="text-2xl font-semibold tracking-tight">Заказать звонок</h2>
    <p class="text-ink-mute mt-1">Оставьте номер — перезвоним в течение нескольких минут.</p>
    <form id="cb-form" class="mt-6 space-y-4" novalidate>
      <input class="field" name="name" placeholder="Как к вам обращаться" autocomplete="name" required />
      <input class="field" name="phone" inputmode="tel" autocomplete="tel" required />
      <label class="flex items-start gap-3 text-sm text-ink-soft">
        <input type="checkbox" name="consent" class="mt-1 w-4 h-4 accent-brand" required />
        <span>Согласен на обработку персональных данных
          (<a href="${CONFIG.legal.privacy}" target="_blank" class="text-brand hover:underline">152-ФЗ</a>).</span>
      </label>
      <div id="turnstile-cb" class="flex justify-center"></div>
      <button type="submit" class="btn-primary w-full">Жду звонка</button>
      <p id="cb-status" class="text-sm text-center"></p>
    </form>`;
  let wid = null;
  const { close, root } = openModal(html, {
    onClose: () => { if (window.turnstile && wid != null) { try { turnstile.remove(wid); } catch (e) {} } },
  });
  const form = $("#cb-form", root);
  const status = $("#cb-status", root);
  attachPhoneMask(form.querySelector('[name="phone"]'));

  if (window.turnstile && CONFIG.turnstileSiteKey) {
    setTimeout(() => { try { wid = turnstile.render($("#turnstile-cb", root), { sitekey: CONFIG.turnstileSiteKey }); } catch (e) {} }, 50);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.consent) { status.textContent = "Нужно согласие на обработку данных."; status.className = "text-sm text-center text-apple-red"; return; }
    if (!data.name || !phoneComplete(data.phone)) { status.textContent = "Введите имя и полный номер телефона."; status.className = "text-sm text-center text-apple-red"; return; }
    const cfToken = form.querySelector('[name="cf-turnstile-response"]')?.value || (window.turnstile ? turnstile.getResponse(wid) : "");
    status.textContent = "Отправляем…"; status.className = "text-sm text-center text-ink-mute";
    const payload = { name: data.name, phone: data.phone, comment: "Заказ обратного звонка", product: "Обратный звонок", price: "—", page: location.href, turnstileToken: cfToken };
    try {
      if (CONFIG.apiBase) {
        const r = await fetch(`${CONFIG.apiBase}/api/lead`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const rd = await r.json().catch(() => ({}));
        if (!r.ok || rd.success === false) throw new Error(rd.error || "status " + r.status);
      } else {
        window.open(`${CONFIG.contacts.telegram}?text=${encodeURIComponent("Обратный звонок%0AИмя: " + data.name + "%0AТелефон: " + data.phone)}`, "_blank");
      }
      status.textContent = "Заявка принята! Скоро перезвоним."; status.className = "text-sm text-center text-apple-green";
      form.reset();
      if (window.turnstile && wid) turnstile.reset(wid);
      setTimeout(close, 1600);
    } catch (err) {
      console.error(err);
      status.textContent = "Не удалось отправить. Напишите нам в Telegram."; status.className = "text-sm text-center text-apple-red";
      if (window.turnstile && wid) turnstile.reset(wid);
    }
  });
}

// ---- Селектор города в шапке ----
function setupCitySelector() {
  const sel = $("#city-selector");
  if (!sel) return;
  const btn = $("#city-btn", sel);
  const menu = $("#city-menu", sel);
  const cities = (CONFIG.cities && CONFIG.cities.length) ? CONFIG.cities : [CONFIG.city];
  let current = localStorage.getItem("ait:city") || CONFIG.city || cities[0];

  const apply = () => {
    $$("[data-city]").forEach((el) => (el.textContent = current));
    $$("[data-city-current]").forEach((el) => (el.textContent = current));
  };
  menu.innerHTML = cities
    .map((c) => `<button class="w-full text-left px-3 py-2 rounded-xl text-sm hover:bg-black/[0.04] transition" data-city-opt="${esc(c)}">${c}</button>`)
    .join("");
  $$("[data-city-opt]", menu).forEach((b) =>
    b.addEventListener("click", () => {
      current = b.dataset.cityOpt;
      localStorage.setItem("ait:city", current);
      apply();
      menu.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    })
  );
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = menu.classList.contains("hidden");
    menu.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", String(willOpen));
  });
  document.addEventListener("click", (e) => {
    if (!sel.contains(e.target)) { menu.classList.add("hidden"); btn.setAttribute("aria-expanded", "false"); }
  });
  apply();
}

// ------------------------------------------------------------------
// Cookie-баннер (FR-5.2)
// ------------------------------------------------------------------
function setupCookieBanner() {
  const el = $("#cookie-banner");
  if (!el) return;
  if (Store.hasCookieConsent()) { el.remove(); return; }
  el.classList.remove("hidden");
  $("#cookie-accept", el)?.addEventListener("click", () => {
    Store.setCookieConsent();
    el.classList.add("opacity-0", "translate-y-4");
    setTimeout(() => el.remove(), 300);
  });
}

// ------------------------------------------------------------------
// Телефон: тап → звонок, долгое зажатие → копирование в буфер + тост
// ------------------------------------------------------------------
function setupPhoneLongPress() {
  const el = $("#phone-longpress");
  if (!el) return;
  el.href = `tel:${CONFIG.contacts.phoneHref}`;
  let timer = null, longFired = false;

  const copy = async () => {
    longFired = true;
    const num = CONFIG.contacts.phone;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(num);
      } else {
        const ta = document.createElement("textarea");
        ta.value = num; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove();
      }
      toast("Номер скопирован");
    } catch { toast("Не удалось скопировать"); }
  };
  const start = () => { longFired = false; timer = setTimeout(copy, 550); };
  const cancel = () => { clearTimeout(timer); };

  // touch
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchmove", cancel);
  // mouse (desktop): ЛКМ удержание
  el.addEventListener("mousedown", (e) => { if (e.button === 0) start(); });
  el.addEventListener("mouseup", cancel);
  el.addEventListener("mouseleave", cancel);
  // клик: если было долгое зажатие — не переходить по tel:
  el.addEventListener("click", (e) => { if (longFired) { e.preventDefault(); longFired = false; } });
  // правый клик тоже копирует
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); copy(); });
}

// ------------------------------------------------------------------
// Speed dial — плавающая кнопка выбора способа связи
// ------------------------------------------------------------------
function setupSpeedDial() {
  const root = $("#speeddial");
  if (!root) return;
  const toggle = $("#sd-toggle", root);
  const actions = $("#sd-actions", root);
  let open = false;
  const set = (v) => {
    open = v;
    root.classList.toggle("is-open", v);
    toggle.setAttribute("aria-expanded", v);
    actions.classList.toggle("pointer-events-none", !v);
  };
  toggle.addEventListener("click", (e) => { e.stopPropagation(); set(!open); });
  document.addEventListener("click", (e) => { if (open && !root.contains(e.target)) set(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
  actions.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => set(false)));
}

// ------------------------------------------------------------------
// Счётчики в шапке (избранное / сравнение)
// ------------------------------------------------------------------
function updateCounters() {
  const f = Store.getFavorites().length;
  const c = Store.getCompare().length;
  const fc = $("#fav-count");
  const cc = $("#cmp-count");
  if (fc) { fc.textContent = f; fc.classList.toggle("hidden", f === 0); }
  if (cc) { cc.textContent = c; cc.classList.toggle("hidden", c === 0); }
}

function syncFavToggle() {
  const t = $("#fav-toggle");
  if (t) t.classList.toggle("is-active", state.favOnly);
}

// ------------------------------------------------------------------
// Инициализация
// ------------------------------------------------------------------
async function init() {
  // Инициализируем Lucide-иконки в статичной разметке
  if (window.lucideInit) window.lucideInit();

  // Брендовые подписи
  $$("[data-brand]").forEach((el) => (el.textContent = CONFIG.brand));
  $$("[data-city]").forEach((el) => (el.textContent = CONFIG.city));
  // Телефон: href на всех [data-phone], текст — только в [data-phone-text]
  $$("[data-phone]").forEach((el) => {
    if (el.tagName === "A") el.href = `tel:${CONFIG.contacts.phoneHref}`;
    if (!el.querySelector("[data-phone-text]") && !el.classList.contains("sd-item")) {
      // элемент без отдельного текстового узла и не speed-dial — можно проставить число,
      // но не затирая вложенные иконки: делаем только если внутри нет тегов
      if (!el.children.length) el.textContent = CONFIG.contacts.phone;
    }
  });
  $$("[data-phone-text]").forEach((el) => (el.textContent = CONFIG.contacts.phone));
  $$("[data-tg]").forEach((el) => (el.href = CONFIG.contacts.telegram));
  $$("[data-wa]").forEach((el) => (el.href = CONFIG.contacts.whatsapp));
  $$("[data-vk]").forEach((el) => (el.href = CONFIG.contacts.vk || "#"));
  $$("[data-max]").forEach((el) => (el.href = CONFIG.contacts.max || "#"));
  $$("[data-privacy]").forEach((el) => (el.href = CONFIG.legal.privacy));
  $$("[data-offer]").forEach((el) => (el.href = CONFIG.legal.offer));

  // Скелетоны на время загрузки каталога
  renderSkeleton(6);

  const data = await loadProducts();
  state.all = data.products || [];
  state.categories = data.categories || [];
  if (data.meta?.currency) state.currency = data.meta.currency;
  state.searchIndex = SmartSearch.build(state.all);

  // Убираем из избранного/сравнения товары, которых больше нет в каталоге
  Store.pruneMissing(state.all.map((p) => p.id));

  // Иерархический каталог (уровень из hash)
  parseHash();
  renderCatalog();
  window.addEventListener("popstate", () => { parseHash(); renderCatalog(); });

  setupSearch();
  setupCitySelector();
  setupPhoneLongPress();
  setupCookieBanner();
  setupSpeedDial();
  updateCounters();

  // Кнопки в шапке / герое
  $("#open-compare")?.addEventListener("click", openCompareModal);
  $("#open-callback")?.addEventListener("click", openCallbackModal);
  $("#open-tradein")?.addEventListener("click", openTradeInModal);
  $$("[data-open-tradein]").forEach((b) => b.addEventListener("click", openTradeInModal));
  $$("[data-open-lead]").forEach((b) => b.addEventListener("click", () => openLeadModal(null)));
  $$("[data-open-callback]").forEach((b) => b.addEventListener("click", openCallbackModal));
  $("#fav-toggle")?.addEventListener("click", () => {
    state.favOnly = !state.favOnly;
    syncFavToggle();
    if (state.level === 1) navigate({ level: 2, category: state.categories[0]?.key });
    else renderCatalog();
  });

  window.addEventListener("compare:limit", () =>
    toast(`Можно сравнить не более ${Store.COMPARE_LIMIT} товаров`)
  );
}

// Мини-тост
let toastTimer;
function toast(msg) {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className =
      "fixed left-1/2 bottom-24 -translate-x-1/2 z-[60] glass-dark text-white text-sm px-4 py-2.5 rounded-full shadow-pop opacity-0 transition-all duration-300";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.remove("opacity-0", "translate-y-2"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("opacity-0", "translate-y-2"), 3000);
}

document.addEventListener("DOMContentLoaded", init);