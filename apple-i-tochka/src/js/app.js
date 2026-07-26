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
  activeCategory: "all",
  filters: { generation: "", storage: "", color: "", sim: "" },
  favOnly: false,
  searchIndex: null,
};

// ------------------------------------------------------------------
// Загрузка каталога: приоритет — Worker/KV (реальное время), fallback — локальный JSON
// ------------------------------------------------------------------
async function loadProducts() {
  // Встроенный каталог (data/products.js -> window.__CATALOG__).
  // Работает и без сервера, при открытии index.html напрямую (file://).
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
// Рендер категорий (FR-1.1)
// ------------------------------------------------------------------
function renderCategories() {
  const wrap = $("#categories");
  if (!wrap) return;
  const all = [{ key: "all", title: "Всё" }, ...state.categories];
  wrap.innerHTML = all
    .map(
      (c) =>
        `<button class="btn-pill ${c.key === state.activeCategory ? "is-active" : ""}" data-cat="${c.key}">${c.title}</button>`
    )
    .join("");
  $$("[data-cat]", wrap).forEach((b) =>
    b.addEventListener("click", () => {
      state.activeCategory = b.dataset.cat;
      state.filters = { generation: "", storage: "", color: "", sim: "" };
      renderCategories();
      renderFilters();
      renderProducts();
    })
  );
}

// ------------------------------------------------------------------
// Рендер фильтров (FR-1.2): поколение, память, цвет, SIM
// ------------------------------------------------------------------
function poolFor(field) {
  const list =
    state.activeCategory === "all"
      ? state.all
      : state.all.filter((p) => p.category === state.activeCategory);
  return Array.from(new Set(list.map((p) => p[field]).filter((v) => v && v !== "—"))).sort();
}

function renderFilters() {
  const wrap = $("#filters");
  if (!wrap) return;
  const defs = [
    { key: "generation", label: "Поколение" },
    { key: "storage", label: "Память" },
    { key: "color", label: "Цвет" },
    { key: "sim", label: "SIM" },
  ];
  wrap.innerHTML = defs
    .map((d) => {
      const opts = poolFor(d.key);
      if (!opts.length) return "";
      return `<label class="relative">
        <select class="field appearance-none pr-9 text-sm py-2.5" data-filter="${d.key}">
          <option value="">${d.label}: все</option>
          ${opts
            .map(
              (o) =>
                `<option value="${o}" ${state.filters[d.key] === o ? "selected" : ""}>${o}</option>`
            )
            .join("")}
        </select>
        <svg class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-mute" viewBox="0 0 20 20" fill="currentColor"><path d="M5.5 7.5l4.5 4.5 4.5-4.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
      </label>`;
    })
    .join("");

  const reset = document.createElement("button");
  reset.className = "btn-ghost text-sm";
  reset.textContent = "Сбросить";
  reset.addEventListener("click", () => {
    state.filters = { generation: "", storage: "", color: "", sim: "" };
    state.favOnly = false;
    renderFilters();
    renderProducts();
    syncFavToggle();
  });
  wrap.appendChild(reset);

  $$("[data-filter]", wrap).forEach((sel) =>
    sel.addEventListener("change", () => {
      state.filters[sel.dataset.filter] = sel.value;
      renderProducts();
    })
  );
}

// ------------------------------------------------------------------
// Фильтрация + рендер карточек
// ------------------------------------------------------------------
function currentList() {
  let list = state.all.slice();
  if (state.activeCategory !== "all")
    list = list.filter((p) => p.category === state.activeCategory);
  for (const [k, v] of Object.entries(state.filters)) {
    if (v) list = list.filter((p) => p[k] === v);
  }
  if (state.favOnly) {
    const favs = Store.getFavorites();
    list = list.filter((p) => favs.includes(p.id));
  }
  return list;
}

function statusBadge(status) {
  return status === "in_stock"
    ? `<span class="chip chip-green"><span class="w-1.5 h-1.5 rounded-full bg-apple-green"></span>В наличии</span>`
    : `<span class="chip chip-amber"><span class="w-1.5 h-1.5 rounded-full bg-apple-amber"></span>Под заказ 1 день</span>`;
}

function productCard(p) {
  const fav = Store.isFavorite(p.id);
  const cmp = Store.inCompare(p.id);
  const badge = p.badge
    ? `<span class="absolute left-5 top-5 chip bg-ink text-white">${p.badge}</span>`
    : "";
  return `
  <article class="card animate-fade-up" data-id="${p.id}">
    ${badge}
    <div class="absolute right-4 top-4 flex gap-1.5">
      <button class="grid place-items-center w-9 h-9 rounded-full bg-white/70 hover:bg-white shadow-sm transition" data-fav="${p.id}" title="В избранное" aria-pressed="${fav}">
        ${heartIcon(fav)}
      </button>
      <button class="grid place-items-center w-9 h-9 rounded-full bg-white/70 hover:bg-white shadow-sm transition" data-cmp="${p.id}" title="К сравнению" aria-pressed="${cmp}">
        ${scaleIcon(cmp)}
      </button>
    </div>

    <div class="grid place-items-center h-40 mb-4 mt-2">
      ${deviceGlyph(p, 96)}
    </div>

    <div class="space-y-1">
      <h3 class="font-semibold text-lg leading-tight">${p.name}</h3>
      <p class="text-sm text-ink-mute">${[p.storage, p.color].filter((x) => x && x !== "—").join(" · ")}</p>
    </div>

    <div class="mt-3">${statusBadge(p.status)}</div>

    <div class="mt-4 flex items-end justify-between">
      <div>
        <div class="text-xs text-ink-mute">Наличными</div>
        <div class="text-xl font-semibold tracking-tight">${fmt(p.priceCash)} ${state.currency}</div>
        <div class="text-xs text-ink-mute mt-0.5">Картой / кредит · ${fmt(p.priceCard)} ${state.currency}</div>
      </div>
    </div>

    <button class="btn-primary w-full mt-4" data-buy="${p.id}">Оформить</button>
  </article>`;
}

function renderProducts() {
  const grid = $("#grid");
  const empty = $("#grid-empty");
  if (!grid) return;
  const list = currentList();
  $("#result-count") && ($("#result-count").textContent = `${list.length} товаров`);
  if (!list.length) {
    grid.innerHTML = "";
    empty && empty.classList.remove("hidden");
    return;
  }
  empty && empty.classList.add("hidden");
  grid.innerHTML = list.map(productCard).join("");

  $$("[data-fav]", grid).forEach((b) =>
    b.addEventListener("click", () => {
      Store.toggleFavorite(b.dataset.fav);
      renderProducts();
      updateCounters();
    })
  );
  $$("[data-cmp]", grid).forEach((b) =>
    b.addEventListener("click", () => {
      Store.toggleCompare(b.dataset.cmp);
      renderProducts();
      updateCounters();
    })
  );
  $$("[data-buy]", grid).forEach((b) =>
    b.addEventListener("click", () => openLeadModal(b.dataset.buy))
  );
}

// ------------------------------------------------------------------
// Иконки (inline SVG, без внешних зависимостей)
// ------------------------------------------------------------------
function heartIcon(active) {
  return active
    ? `<svg viewBox="0 0 24 24" class="w-5 h-5 text-apple-red" fill="currentColor"><path d="M12 21s-7.5-4.6-10-9.2C.3 8.4 2 5 5.3 5c2 0 3.3 1.1 4.7 2.7C11.4 6.1 12.7 5 14.7 5 18 5 19.7 8.4 22 11.8 19.5 16.4 12 21 12 21z"/></svg>`
    : `<svg viewBox="0 0 24 24" class="w-5 h-5 text-ink-mute" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 20s-7-4.3-9.3-8.5C1.2 8.6 2.6 6 5.5 6c1.9 0 3.2 1.1 4.5 2.6C11.3 7.1 12.6 6 14.5 6c2.9 0 4.3 2.6 2.8 5.5C19 15.7 12 20 12 20z"/></svg>`;
}
function scaleIcon(active) {
  const c = active ? "text-apple-blue" : "text-ink-mute";
  return `<svg viewBox="0 0 24 24" class="w-5 h-5 ${c}" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v18M5 7h14M7 7l-3 6a3 3 0 006 0L7 7zm10 0l-3 6a3 3 0 006 0l-3-6z"/></svg>`;
}
function deviceGlyph(p, size = 96) {
  const c = p.colorHex || "#c9c9cf";
  const cat = p.category;
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
function setupSearch() {
  const input = $("#search-input");
  const box = $("#search-results");
  if (!input || !box) return;

  const close = () => { box.classList.add("hidden"); box.innerHTML = ""; };

  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (q.length < 2) return close();
    const hits = state.searchIndex.query(q, 8);
    if (!hits.length) {
      box.innerHTML = `<div class="p-4 text-sm text-ink-mute">Ничего не найдено по запросу «${q}»</div>`;
      box.classList.remove("hidden");
      return;
    }
    box.innerHTML = hits
      .map(
        ({ product: p }) => `
      <button class="flex w-full items-center gap-3 p-3 hover:bg-black/[0.04] text-left transition" data-goto="${p.id}">
        <span class="grid place-items-center w-10 h-10 rounded-xl bg-cloud shrink-0">${deviceGlyph(p, 28)}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium text-sm">${p.name}</span>
          <span class="block truncate text-xs text-ink-mute">${[p.storage, p.color].filter((x) => x && x !== "—").join(" · ")}</span>
        </span>
        <span class="text-sm font-semibold whitespace-nowrap">${fmt(p.priceCash)} ${state.currency}</span>
      </button>`
      )
      .join("");
    box.classList.remove("hidden");
    $$("[data-goto]", box).forEach((b) =>
      b.addEventListener("click", () => {
        close();
        input.value = "";
        openLeadModal(b.dataset.goto);
      })
    );
  });

  document.addEventListener("click", (e) => {
    if (!box.contains(e.target) && e.target !== input) close();
  });
  input.addEventListener("keydown", (e) => e.key === "Escape" && close());
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
  const close = () => (root.innerHTML = "");
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
      <button type="submit" class="btn-primary w-full">Отправить заявку</button>
      <p id="lead-status" class="text-sm text-center"></p>
    </form>
    <div class="hairline mt-6 pt-5 flex flex-wrap gap-2 justify-center">
      <a href="${CONFIG.contacts.telegram}" target="_blank" class="btn-soft text-sm">Telegram</a>
      <a href="${CONFIG.contacts.whatsapp}" target="_blank" class="btn-soft text-sm">WhatsApp</a>
      <a href="tel:${CONFIG.contacts.phoneHref}" class="btn-soft text-sm">${CONFIG.contacts.phone}</a>
    </div>`;

  const { close } = openModal(html);
  const form = $("#lead-form");
  const status = $("#lead-status");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.consent) {
      status.textContent = "Необходимо согласие на обработку персональных данных.";
      status.className = "text-sm text-center text-apple-red";
      return;
    }
    if (!data.name || !data.phone) {
      status.textContent = "Заполните имя и телефон.";
      status.className = "text-sm text-center text-apple-red";
      return;
    }
    status.textContent = "Отправляем…";
    status.className = "text-sm text-center text-ink-mute";
    const payload = {
      name: data.name,
      phone: data.phone,
      comment: data.comment || "",
      product: p ? `${p.name} · ${p.storage} · ${p.color}` : "—",
      price: p ? `${fmt(p.priceCash)} ${state.currency}` : "—",
      page: location.href,
    };
    try {
      if (CONFIG.apiBase) {
        const r = await fetch(`${CONFIG.apiBase}/api/lead`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error("bad status " + r.status);
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
      setTimeout(close, 1800);
    } catch (err) {
      console.error(err);
      status.textContent = "Не удалось отправить. Напишите нам в Telegram или WhatsApp.";
      status.className = "text-sm text-center text-apple-red";
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
  // Брендовые подписи
  $$("[data-brand]").forEach((el) => (el.textContent = CONFIG.brand));
  $$("[data-city]").forEach((el) => (el.textContent = CONFIG.city));
  $$("[data-phone]").forEach((el) => {
    el.textContent = CONFIG.contacts.phone;
    if (el.tagName === "A") el.href = `tel:${CONFIG.contacts.phoneHref}`;
  });
  $$("[data-tg]").forEach((el) => (el.href = CONFIG.contacts.telegram));
  $$("[data-wa]").forEach((el) => (el.href = CONFIG.contacts.whatsapp));
  $$("[data-privacy]").forEach((el) => (el.href = CONFIG.legal.privacy));
  $$("[data-offer]").forEach((el) => (el.href = CONFIG.legal.offer));

  const data = await loadProducts();
  state.all = data.products || [];
  state.categories = data.categories || [];
  if (data.meta?.currency) state.currency = data.meta.currency;
  state.searchIndex = SmartSearch.build(state.all);

  renderCategories();
  renderFilters();
  renderProducts();
  setupSearch();
  setupCookieBanner();
  updateCounters();

  // Кнопки в шапке / герое
  $("#open-compare")?.addEventListener("click", openCompareModal);
  $("#open-tradein")?.addEventListener("click", openTradeInModal);
  $$("[data-open-tradein]").forEach((b) => b.addEventListener("click", openTradeInModal));
  $$("[data-open-lead]").forEach((b) => b.addEventListener("click", () => openLeadModal(null)));
  $("#fav-toggle")?.addEventListener("click", () => {
    state.favOnly = !state.favOnly;
    syncFavToggle();
    renderProducts();
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
  toastTimer = setTimeout(() => t.classList.add("opacity-0", "translate-y-2"), 2200);
}

document.addEventListener("DOMContentLoaded", init);
