// admin.js — Мини-CRM «Apple и точка» (FR-4.2)
// Полное управление каталогом: товары (CRUD + фото), категории (CRUD + порядок),
// обратимость (Undo/Redo + серверная история версий).
// classic script — CONFIG (config.js) и window.__CATALOG__ (data/products.js) подключены раньше.
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const fmt = (n) => new Intl.NumberFormat("ru-RU").format(Math.round(Number(n) || 0));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  // Цена картой всегда = наличными + 10% (округление до 10 ₽)
  const cardPrice = (cash) => Math.round(((Number(cash) || 0) * 1.1) / 10) * 10;

  // ---------- Иконки (инлайн SVG, не зависят от icons.js) ----------
  const P = {
    package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
    more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    star: '<path d="M11.5 2.6a.5.5 0 0 1 .9 0l2.3 4.7 5.2.8a.5.5 0 0 1 .3.9l-3.8 3.7.9 5.2a.5.5 0 0 1-.7.5L12 16.7l-4.7 2.4a.5.5 0 0 1-.7-.5l.9-5.2L3.6 9.7a.5.5 0 0 1 .3-.9l5.2-.8Z"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    warn: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    dot: '<circle cx="12" cy="12" r="9"/>',
  };
  function svg(name, cls) {
    return `<svg xmlns="http://www.w3.org/2000/svg" class="${cls || "w-5 h-5"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[name] || ""}</svg>`;
  }

  const STATUS = [
    { v: "in_stock", t: "В наличии" },
    { v: "on_order", t: "Под заказ 1–2 дня" },
  ];
  const SIM_BASE = ["eSIM", "2 eSIM", "SIM + eSIM", "Physical SIM", "Dual SIM", "—"];
  // Список SIM собираем из реальных значений каталога + базовый набор + текущее
  // значение товара — чтобы «2 eSIM», «SIM + eSIM» и т.п. не терялись при правке.
  function simOptions(current) {
    const out = [];
    const push = (v) => { if (v != null && v !== "" && !out.includes(v)) out.push(v); };
    (state.catalog && state.catalog.products || []).forEach((p) => push(p.sim));
    SIM_BASE.forEach(push);
    push(current);
    return out;
  }
  const statusText = (v) => (STATUS.find((s) => s.v === v) || {}).t || v || "—";

  // Пресеты памяти и размера часов: реальные значения каталога + базовый набор +
  // текущее значение. Показываем в выпадающем списке (datalist), но можно ввести своё.
  const STORAGE_BASE = ["64 ГБ", "128 ГБ", "256 ГБ", "512 ГБ", "1 ТБ", "2 ТБ"];
  const WATCH_BASE = ["40 мм", "42 мм", "44 мм", "46 мм", "49 мм"];
  function presetList(field, base, current) {
    const out = [];
    const push = (v) => { if (v != null && v !== "" && v !== "—" && !out.includes(v)) out.push(v); };
    (state.catalog && state.catalog.products || []).forEach((p) => push(p[field]));
    base.forEach(push);
    push(current);
    // сортировка по объёму (ГБ/ТБ) или по мм
    const rank = (s) => { const m = String(s).match(/([\d.]+)\s*(ТБ|TB|ГБ|GB|мм|mm)/i); if (!m) return 1e9; let n = parseFloat(m[1]); if (/Т|T/i.test(m[2])) n *= 1024; return n; };
    return out.sort((a, b) => rank(a) - rank(b));
  }

  // ---------- Состояние ----------
  const state = {
    token: "",
    api: CONFIG.apiBase || "",
    catalog: null, // { meta, categories, products }
    undo: [],
    redo: [],
    tab: "products",
    query: "",
    filterCat: "all",
    openGroups: new Set(), // раскрытые группы-модели (ключ = category||name)
    editingId: null, // id редактируемого товара, "__new__" — новый, null — черновик формы
    draft: null, // рабочая копия товара в редакторе
  };

  // ---------- Тост ----------
  let toastT = null;
  function toast(msg) {
    const box = $("#toast");
    box.firstElementChild.textContent = msg;
    box.classList.remove("hidden");
    clearTimeout(toastT);
    toastT = setTimeout(() => box.classList.add("hidden"), 2200);
  }

  // ---------- История изменений (клиентская, обратимость) ----------
  function pushUndo() {
    state.undo.push(clone(state.catalog));
    if (state.undo.length > 60) state.undo.shift();
    state.redo.length = 0;
    markDirty();
  }
  function markDirty() {
    const has = state.undo.length > 0;
    $("#dirty-badge").classList.toggle("hidden", !has);
    $("#btn-save").disabled = !has;
    $("#btn-undo").disabled = state.undo.length === 0;
    $("#btn-redo").disabled = state.redo.length === 0;
  }
  function doUndo() {
    if (!state.undo.length) return;
    state.redo.push(clone(state.catalog));
    state.catalog = state.undo.pop();
    markDirty();
    renderActive();
    toast("Изменение отменено");
  }
  function doRedo() {
    if (!state.redo.length) return;
    state.undo.push(clone(state.catalog));
    state.catalog = state.redo.pop();
    markDirty();
    renderActive();
    toast("Изменение возвращено");
  }

  // ---------- API ----------
  async function api(path, opts = {}) {
    const r = await fetch(`${state.api}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
        ...(opts.headers || {}),
      },
    });
    if (r.status === 401) throw new Error("Неверный токен доступа (401).");
    if (!r.ok) {
      let d = "";
      try { d = (await r.json()).error || ""; } catch {}
      throw new Error(`Ошибка ${r.status}${d ? " · " + d : ""}`);
    }
    return r.json().catch(() => ({}));
  }

  async function loadCatalog() {
    let data;
    if (state.api) {
      try {
        data = await api("/api/products");
      } catch (e) {
        // Каталог ещё не залит в KV — берём встроенный, чтобы было с чем работать.
        if (/404/.test(e.message) && window.__CATALOG__) {
          data = clone(window.__CATALOG__);
          toast("KV пуст — загружен встроенный каталог. Нажмите «Сохранить», чтобы залить его.");
        } else throw e;
      }
    } else {
      data = clone(window.__CATALOG__ || { meta: {}, categories: [], products: [] });
    }
    if (!data.categories) data.categories = [];
    if (!data.products) data.products = [];
    if (!data.meta) data.meta = {};
    if (!data.meta.covers) data.meta.covers = {}; // обложки моделей: "category||name" → цвет
    state.catalog = data;
    state.undo.length = 0;
    state.redo.length = 0;
    markDirty();
  }

  async function save() {
    if (!state.undo.length) return;
    if (!state.api) {
      exportCatalog();
      toast("Демо-режим: каталог скачан файлом (products.js).");
      return;
    }
    $("#btn-save").disabled = true;
    toast("Сохраняю в Cloudflare KV…");
    try {
      const note = `правок: ${state.undo.length}`;
      await api("/api/admin/save", {
        method: "POST",
        body: JSON.stringify({ catalog: state.catalog, note }),
      });
      state.undo.length = 0;
      state.redo.length = 0;
      markDirty();
      toast("Сохранено в KV. Резервная копия создана.");
    } catch (e) {
      $("#btn-save").disabled = false;
      toast(e.message);
    }
  }

  function exportCatalog() {
    const body = "// Автосгенерировано CRM-панелью админа.\nwindow.__CATALOG__ = " +
      JSON.stringify(state.catalog) + ";\n";
    download("products.js", body, "text/javascript");
  }
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  // Залить в KV ВСТРОЕННЫЙ каталог (data/products.js) — им синхронизируем KV
  // с актуальной версией сайта, перезаписав устаревший сид.
  async function seedKV() {
    if (!state.api) return toast("Демо-режим: KV недоступен без URL воркера.");
    const embedded = window.__CATALOG__;
    if (!embedded || !Array.isArray(embedded.products)) return toast("Встроенный каталог не найден (data/products.js).");
    if (!confirm(`Залить ВСТРОЕННЫЙ каталог (${embedded.products.length} товаров) в KV? Текущие данные в KV будут перезаписаны (с резервной копией).`)) return;
    try {
      const r = await api("/api/admin/save", {
        method: "POST",
        body: JSON.stringify({ catalog: embedded, note: "синхронизация KV со встроенным каталогом" }),
      });
      state.catalog = clone(embedded);
      if (!state.catalog.categories) state.catalog.categories = [];
      if (!state.catalog.products) state.catalog.products = [];
      state.undo.length = 0; state.redo.length = 0; markDirty();
      fillCatFilter();
      renderActive();
      toast(`KV синхронизирован со встроенным каталогом: ${r.count} товаров.`);
    } catch (e) { toast(e.message); }
  }

  // ---------- Утилиты каталога ----------
  function translit(s) {
    const m = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"c",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
    return String(s || "").toLowerCase().replace(/[а-яё]/g, (c) => m[c] ?? c);
  }
  function slug(s) {
    return translit(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
  }
  function newId(p) {
    const base = ["item", p.category, p.name, p.color, p.storage || p.watchSize, p.sim].map(slug).join("-");
    return `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  function catByKey(k) { return state.catalog.categories.find((c) => c.key === k); }
  function productsIn(k) { return state.catalog.products.filter((p) => p.category === k); }

  // ---------- Рендер: активная вкладка ----------
  function renderActive() {
    if (state.tab === "products") renderProducts();
    else if (state.tab === "categories") renderCategories();
    else if (state.tab === "history") loadHistory();
    // фильтр категорий в шапке товаров держим актуальным
    fillCatFilter();
  }

  function switchTab(tab) {
    state.tab = tab;
    $$(".adm-tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === tab));
    $("#tab-products").classList.toggle("hidden", tab !== "products");
    $("#tab-categories").classList.toggle("hidden", tab !== "categories");
    $("#tab-history").classList.toggle("hidden", tab !== "history");
    if (tab === "history") loadHistory();
    renderActive();
  }

  // ---------- Товары ----------
  function fillCatFilter() {
    const sel = $("#p-catfilter");
    const cur = state.filterCat;
    sel.innerHTML =
      `<option value="all">Все категории (${state.catalog.products.length})</option>` +
      state.catalog.categories
        .map((c) => `<option value="${esc(c.key)}">${esc(c.title)} (${productsIn(c.key).length})</option>`)
        .join("");
    sel.value = cur;
    if (sel.value !== cur) { state.filterCat = "all"; sel.value = "all"; }
  }

  function filteredProducts() {
    const q = state.query.trim().toLowerCase();
    return state.catalog.products.filter((p) => {
      if (state.filterCat !== "all" && p.category !== state.filterCat) return false;
      if (!q) return true;
      const hay = [p.name, p.color, p.storage, p.watchSize, p.sim, p.id, p.category].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  function pThumb(p) {
    const src = (Array.isArray(p.thumbs) && p.thumbs[0]) || (Array.isArray(p.images) && p.images[0]);
    if (src) {
      return `<div class="adm-thumb"><img src="${esc(src)}" alt="" class="w-full h-full object-contain" loading="lazy" onerror="this.style.display='none'"/></div>`;
    }
    return `<div class="adm-thumb text-ink-mute">${svg("image", "w-6 h-6")}</div>`;
  }

  // Фото у Apple — по ЦВЕТУ, а не по памяти/SIM. Поэтому изменённые в редакторе
  // снимки применяем ко ВСЕМ вариантам той же модели и того же цвета.
  function propagateColorImages(d) {
    const imgs = Array.isArray(d.images) ? clone(d.images) : [];
    d.thumbs = clone(imgs); // админ-загруженные фото используем и как превью
    let n = 0;
    state.catalog.products.forEach((p) => {
      if (p !== d && p.category === d.category && p.name === d.name && p.color === d.color) {
        p.images = clone(imgs);
        p.thumbs = clone(imgs);
        n++;
      }
    });
    return n;
  }

  // Группировка товаров по модели (категория + название), чтобы оператор
  // видел ~40 моделей, а не 250 строк. Внутри модели — компактные варианты.
  function groupProducts(items) {
    const map = new Map();
    for (const p of items) {
      const key = p.category + "||" + p.name;
      if (!map.has(key)) map.set(key, { key, category: p.category, name: p.name, rep: p, list: [] });
      map.get(key).list.push(p);
    }
    return [...map.values()];
  }
  function variantLabel(p) {
    return [p.color, p.storage, p.watchSize, p.sim].filter((x) => x && x !== "—").join(" · ") || "вариант";
  }
  function coverKey(p) { return p.category + "||" + p.name; }
  function coverColorOf(g) {
    const covers = (state.catalog.meta && state.catalog.meta.covers) || {};
    return covers[g.key];
  }
  // Представитель модели для миниатюры — как на сайте: обложка → цвет с фото → первый с фото → rep
  function groupRep(g) {
    const hasImg = (v) => (Array.isArray(v.thumbs) && v.thumbs.length) || (Array.isArray(v.images) && v.images.length);
    const cc = coverColorOf(g);
    if (cc) {
      const byColor = g.list.filter((v) => v.color === cc);
      const withImg = byColor.filter(hasImg);
      if (withImg.length) return withImg[0];
      if (byColor.length) return byColor[0];
    }
    return g.list.find(hasImg) || g.rep;
  }
  function setCover(key, color) {
    if (!state.catalog.meta) state.catalog.meta = {};
    if (!state.catalog.meta.covers) state.catalog.meta.covers = {};
    pushUndo();
    if (state.catalog.meta.covers[key] === color) delete state.catalog.meta.covers[key];
    else state.catalog.meta.covers[key] = color;
    renderProducts();
    toast(state.catalog.meta.covers[key] ? `Обложка модели: ${color}` : "Обложка сброшена");
  }

  function renderProducts() {
    const list = $("#p-list");
    const items = filteredProducts();
    const groups = groupProducts(items);
    const searching = state.query.trim().length > 0;
    $("#p-count").textContent =
      `${groups.length} моделей · ${items.length} вариантов из ${state.catalog.products.length}` +
      (state.filterCat !== "all" ? ` · ${state.filterCat}` : "");
    if (!items.length) {
      list.innerHTML = `<div class="text-center text-ink-mute py-16">Ничего не найдено. Измените запрос или добавьте товар.</div>`;
      return;
    }

    list.innerHTML = groups
      .map((g) => {
        const open = searching || state.openGroups.has(g.key);
        const minCash = Math.min(...g.list.map((p) => Number(p.priceCash) || Infinity));
        const anyStock = g.list.some((p) => p.status === "in_stock");
        const header = `
          <div class="flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none" data-ghead="${esc(g.key)}">
            <span class="adm-icbtn shrink-0 pointer-events-none">${svg(open ? "up" : "down")}</span>
            ${pThumb(groupRep(g))}
            <div class="min-w-0 flex-1">
              <div class="font-medium truncate">${esc(g.name)}</div>
              <div class="text-xs text-ink-mute truncate">${esc(g.category)} · ${g.list.length} ${plural(g.list.length)}${coverColorOf(g) ? ` · обложка: ${esc(coverColorOf(g))}` : ""}</div>
            </div>
            <div class="hidden sm:block text-right shrink-0">
              <div class="text-sm font-semibold">от ${fmt(minCash)} ₽</div>
            </div>
            <span class="chip ${anyStock ? "chip-green" : "chip-amber"} shrink-0">${anyStock ? "В наличии" : "Под заказ"}</span>
            <button class="adm-icbtn shrink-0" data-gadd="${esc(g.key)}" title="Добавить вариант">${svg("plus")}</button>
          </div>`;

        const rows = !open ? "" : `<div class="border-t border-black/[0.06] divide-y divide-black/[0.04]">${g.list
          .map((p) => `
            <div class="flex items-center gap-2 px-3 py-2" data-id="${esc(p.id)}">
              <span class="w-4 h-4 rounded-full shrink-0 border border-black/10" style="background:${esc(/^#[0-9a-f]{6}$/i.test(p.colorHex) ? p.colorHex : "#ccc")}" title="${esc(p.color)}"></span>
              <div class="min-w-0 flex-1 text-sm truncate" title="${esc(p.id)}">${esc(variantLabel(p))}</div>
              <label class="hidden sm:flex items-center gap-1 shrink-0 text-[11px] text-ink-mute">нал.
                <input type="number" min="0" step="500" value="${Number(p.priceCash) || 0}" data-inline="priceCash" class="adm-input w-24 py-1 text-right"/></label>
              <label class="hidden md:flex items-center gap-1 shrink-0 text-[11px] text-ink-mute">карт.
                <input type="number" value="${cardPrice(p.priceCash)}" readonly tabindex="-1" title="Автоматически: наличными +10%" class="adm-input w-24 py-1 text-right bg-black/[0.03] text-ink-mute"/></label>
              <select data-inline="status" class="adm-input w-auto py-1 text-sm shrink-0">
                ${STATUS.map((s) => `<option value="${s.v}" ${s.v === p.status ? "selected" : ""}>${s.t}</option>`).join("")}
              </select>
              <button class="adm-icbtn shrink-0 ${coverColorOf(g) === p.color ? "text-brand" : ""}" data-act="cover" title="Сделать обложкой модели">${svg("star", "w-4 h-4")}</button>
              <button class="adm-icbtn shrink-0" data-act="dup" title="Дублировать">${svg("copy", "w-4 h-4")}</button>
              <button class="adm-icbtn shrink-0" data-act="edit" title="Редактировать">${svg("edit", "w-4 h-4")}</button>
              <button class="adm-icbtn text-apple-red shrink-0" data-act="del" title="Удалить">${svg("trash", "w-4 h-4")}</button>
            </div>`)
          .join("")}</div>`;

        return `<div class="bg-cloud-card rounded-2xl border border-black/[0.06] shadow-sm overflow-hidden">${header}${rows}</div>`;
      })
      .join("");

    // Раскрытие/сворачивание групп
    $$("[data-ghead]", list).forEach((h) => {
      h.onclick = (e) => {
        if (e.target.closest("[data-gadd]")) return;
        const k = h.dataset.ghead;
        if (state.openGroups.has(k)) state.openGroups.delete(k);
        else state.openGroups.add(k);
        renderProducts();
      };
    });
    $$("[data-gadd]", list).forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); addVariant(b.dataset.gadd); };
    });

    // Варианты: инлайн-правки + действия
    $$("[data-id]", list).forEach((row) => {
      const id = row.dataset.id;
      const p = state.catalog.products.find((x) => x.id === id);
      if (!p) return;
      $$("[data-inline]", row).forEach((el) => {
        el.addEventListener("focus", () => (el._old = el.value), { once: false });
        el.addEventListener("change", () => {
          const f = el.dataset.inline;
          const nv = f === "status" ? el.value : Number(el.value) || 0;
          if (p[f] === nv) return;
          pushUndo();
          p[f] = nv;
          if (f === "priceCash") p.priceCard = cardPrice(nv); // карта = +10% авто
          renderProducts();
          toast("Изменение внесено · Ctrl+Z отменит");
        });
      });
      row.querySelector('[data-act="cover"]').onclick = () => setCover(coverKey(p), p.color);
      row.querySelector('[data-act="edit"]').onclick = () => openEditor(id);
      row.querySelector('[data-act="dup"]').onclick = () => duplicateProduct(id);
      row.querySelector('[data-act="del"]').onclick = () => deleteProduct(id);
    });
  }

  function plural(n) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return "вариантов";
    if (b > 1 && b < 5) return "варианта";
    if (b === 1) return "вариант";
    return "вариантов";
  }

  // Добавить вариант к существующей модели (префилл категории/названия/бренда)
  function addVariant(key) {
    const g = groupProducts(state.catalog.products).find((x) => x.key === key);
    const rep = g ? g.rep : null;
    const d = blankProduct();
    if (rep) {
      d.category = rep.category; d.brand = rep.brand; d.name = rep.name;
      d.series = rep.series; d.seriesOrder = rep.seriesOrder;
      d.storage = rep.storage; d.watchSize = rep.watchSize; d.sim = rep.sim;
      d.specs = clone(rep.specs || {});
    }
    state.editingId = "__new__";
    state.draft = d;
    $("#drawer-title").textContent = "Новый вариант";
    $("#drawer-delete").classList.add("hidden");
    renderEditor();
    $("#drawer").classList.add("is-open");
    $("#drawer-scrim").classList.add("is-open");
    if (rep) state.openGroups.add(key);
  }

  function duplicateProduct(id) {
    const p = state.catalog.products.find((x) => x.id === id);
    if (!p) return;
    pushUndo();
    const copy = clone(p);
    copy.id = newId(copy);
    copy.badge = "";
    const i = state.catalog.products.indexOf(p);
    state.catalog.products.splice(i + 1, 0, copy);
    renderProducts();
    toast("Товар продублирован");
    openEditor(copy.id);
  }

  function deleteProduct(id) {
    const p = state.catalog.products.find((x) => x.id === id);
    if (!p) return;
    if (!confirm(`Удалить «${p.name} · ${[p.color, p.storage].filter(Boolean).join(" ")}»?\nМожно вернуть через «Отменить» (Ctrl+Z).`)) return;
    pushUndo();
    state.catalog.products = state.catalog.products.filter((x) => x.id !== id);
    renderProducts();
    fillCatFilter();
    toast("Товар удалён · Ctrl+Z вернёт");
  }

  // ---------- Редактор товара (боковая панель) ----------
  function blankProduct() {
    const cat = state.catalog.categories[0] || { key: "iPhone", brand: "Apple" };
    return {
      id: "__new__",
      category: cat.key,
      brand: cat.brand || "Apple",
      series: "",
      seriesOrder: 0,
      name: "",
      color: "",
      colorHex: "#888888",
      storage: "",
      watchSize: null,
      sim: "eSIM",
      images: [],
      priceCash: 0,
      priceCard: 0,
      status: "in_stock",
      badge: "",
      specs: {},
    };
  }

  function openEditor(id) {
    let src;
    if (id === "__new__") {
      src = blankProduct();
      state.editingId = "__new__";
    } else {
      src = state.catalog.products.find((x) => x.id === id);
      if (!src) return;
      state.editingId = id;
    }
    state.draft = clone(src);
    $("#drawer-title").textContent = id === "__new__" ? "Новый товар" : "Редактирование товара";
    $("#drawer-delete").classList.toggle("hidden", id === "__new__");
    renderEditor();
    $("#drawer").classList.add("is-open");
    $("#drawer-scrim").classList.add("is-open");
  }
  function closeEditor() {
    $("#drawer").classList.remove("is-open");
    $("#drawer-scrim").classList.remove("is-open");
    state.editingId = null;
    state.draft = null;
  }

  function field(label, html) {
    return `<label class="block mb-3"><span class="adm-label">${label}</span>${html}</label>`;
  }
  function renderEditor() {
    const d = state.draft;
    const catOpts = state.catalog.categories
      .map((c) => `<option value="${esc(c.key)}" ${c.key === d.category ? "selected" : ""}>${esc(c.title)}</option>`)
      .join("");
    const simOpts = simOptions(d.sim).map((s) => `<option ${s === d.sim ? "selected" : ""}>${esc(s)}</option>`).join("");
    const stOpts = STATUS.map((s) => `<option value="${s.v}" ${s.v === d.status ? "selected" : ""}>${s.t}</option>`).join("");

    const specRows = Object.entries(d.specs || {})
      .map(([k, v], i) => specRow(k, v, i))
      .join("");

    $("#drawer-body").innerHTML = `
      ${field("Категория", `<select class="adm-input" data-f="category">${catOpts}</select>`)}
      <div class="grid grid-cols-2 gap-3">
        ${field("Модель (название)", `<input class="adm-input" data-f="name" value="${esc(d.name)}" placeholder="iPhone 16 Pro"/>`)}
        ${field("Бренд", `<input class="adm-input" data-f="brand" value="${esc(d.brand)}" placeholder="Apple"/>`)}
      </div>
      <div class="grid grid-cols-2 gap-3">
        ${field("Цвет", `<input class="adm-input" data-f="color" value="${esc(d.color)}" placeholder="Титановый"/>`)}
        ${field("Образец цвета", `<input type="color" class="adm-input h-10 p-1" data-f="colorHex" value="${/^#[0-9a-f]{6}$/i.test(d.colorHex) ? d.colorHex : "#888888"}"/>`)}
      </div>
      <div class="grid grid-cols-2 gap-3">
        ${field("Память", `<input class="adm-input" data-f="storage" list="preset-storage" value="${esc(d.storage || "")}" placeholder="256 ГБ" autocomplete="off"/>
          <datalist id="preset-storage">${presetList("storage", STORAGE_BASE, d.storage).map((s) => `<option value="${esc(s)}"></option>`).join("")}</datalist>`)}
        ${field("Размер (часы, мм)", `<input class="adm-input" data-f="watchSize" list="preset-watch" value="${esc(d.watchSize || "")}" placeholder="напр. 45 мм" autocomplete="off"/>
          <datalist id="preset-watch">${presetList("watchSize", WATCH_BASE, d.watchSize).map((s) => `<option value="${esc(s)}"></option>`).join("")}</datalist>`)}
      </div>
      ${field("SIM", `<select class="adm-input" data-f="sim">${simOpts}</select>`)}
      <div class="grid grid-cols-2 gap-3">
        ${field("Цена наличными, ₽", `<input type="number" min="0" step="500" class="adm-input" data-f="priceCash" value="${Number(d.priceCash) || 0}"/>`)}
        ${field("Цена картой (авто +10%)", `<input type="number" class="adm-input bg-black/[0.03] text-ink-mute" data-card-auto readonly tabindex="-1" value="${cardPrice(d.priceCash)}"/>`)}
      </div>
      <div class="grid grid-cols-2 gap-3">
        ${field("Наличие", `<select class="adm-input" data-f="status">${stOpts}</select>`)}
        ${field("Бейдж (необязательно)", `<input class="adm-input" data-f="badge" value="${esc(d.badge || "")}" placeholder="Новинка / Хит"/>`)}
      </div>

      <div class="hairline my-4"></div>
      <div class="flex items-center justify-between mb-2">
        <span class="text-sm font-semibold">Фотографии</span>
        <span class="text-[11px] text-ink-mute">первая — главная</span>
      </div>
      <div id="img-list" class="space-y-2 mb-2"></div>
      <div class="flex gap-2 mb-2">
        <input id="img-url" class="adm-input flex-1" placeholder="Путь или URL: assets/products/…/фото.webp"/>
        <button id="img-add" class="btn-soft text-sm shrink-0">${svg("plus", "w-4 h-4")}Добавить</button>
      </div>
      <label class="btn-pill text-sm cursor-pointer inline-flex">
        ${svg("image", "w-4 h-4")} Загрузить файл(ы)
        <input id="img-file" type="file" accept="image/*" multiple class="hidden"/>
      </label>
      <p class="text-[11px] text-ink-mute mt-1">Загрузка файла встраивает картинку в каталог (data-URL). Для лёгкости сайта лучше указывать путь к файлу в <code>assets/products/…</code>.</p>

      <div class="hairline my-4"></div>
      <div class="flex items-center justify-between mb-2">
        <span class="text-sm font-semibold">Характеристики</span>
        <button id="spec-add" class="btn-soft text-sm">${svg("plus", "w-4 h-4")}Строка</button>
      </div>
      <div id="spec-list" class="space-y-2">${specRows}</div>
    `;

    // Привязки простых полей
    $$("[data-f]", $("#drawer-body")).forEach((el) => {
      el.addEventListener("input", () => {
        const f = el.dataset.f;
        let v = el.value;
        if (f === "priceCash" || f === "priceCard") v = Number(v) || 0;
        if (f === "watchSize") v = v.trim() || null;
        state.draft[f] = v;
        if (f === "priceCash") {
          state.draft.priceCard = cardPrice(v);
          const auto = $("[data-card-auto]", $("#drawer-body"));
          if (auto) auto.value = state.draft.priceCard; // карта = +10% авто
        }
      });
    });

    renderImages();
    bindEditorButtons();
  }

  function specRow(k, v, i) {
    return `<div class="flex gap-2 spec-row" data-i="${i}">
      <input class="adm-input flex-1" data-sk value="${esc(k)}" placeholder="Экран"/>
      <input class="adm-input flex-[1.4]" data-sv value="${esc(v)}" placeholder="OLED 120 Гц"/>
      <button class="adm-icbtn text-apple-red shrink-0" data-sdel title="Удалить">${svg("x", "w-4 h-4")}</button>
    </div>`;
  }

  function renderImages() {
    const box = $("#img-list");
    const imgs = state.draft.images || [];
    if (!imgs.length) {
      box.innerHTML = `<div class="text-xs text-ink-mute">Фото не добавлены — на сайте покажется векторный глиф.</div>`;
      return;
    }
    box.innerHTML = imgs
      .map((src, i) => {
        const isData = /^data:/.test(src);
        const pathField = isData
          ? `<div class="min-w-0 flex-1 text-[11px] text-ink-mute">Встроенное фото (data-URL). Лучше заменить на путь к файлу в <code>assets/products/…</code></div>`
          : `<input class="adm-input flex-1 text-[11px] py-1.5" data-im-path value="${esc(src)}" spellcheck="false" title="${esc(src)}" placeholder="assets/products/…/фото.webp"/>`;
        return `<div class="rounded-xl border border-black/[0.06] p-2 ${i === 0 ? "bg-brand/[0.04]" : ""}" data-img="${i}">
          <div class="flex items-center gap-2">
            <div class="adm-thumb w-11 h-11 shrink-0"><img src="${esc(src)}" class="w-full h-full object-contain" onerror="this.style.display='none'"/></div>
            ${pathField}
          </div>
          <div class="flex items-center gap-1 mt-1.5">
            <span class="mr-auto text-[11px] px-1 ${i === 0 ? "text-brand font-medium" : "text-ink-mute"}">${i === 0 ? "★ Главная" : "фото " + (i + 1)}</span>
            <button class="adm-icbtn" data-im="main" title="Сделать главной" ${i === 0 ? "disabled" : ""}>${svg("star", "w-4 h-4")}</button>
            <button class="adm-icbtn" data-im="up" title="Выше" ${i === 0 ? "disabled" : ""}>${svg("up", "w-4 h-4")}</button>
            <button class="adm-icbtn" data-im="down" title="Ниже" ${i === imgs.length - 1 ? "disabled" : ""}>${svg("down", "w-4 h-4")}</button>
            <button class="adm-icbtn text-apple-red" data-im="del" title="Убрать">${svg("trash", "w-4 h-4")}</button>
          </div>
        </div>`;
      })
      .join("");
    $$("[data-img]", box).forEach((row) => {
      const i = Number(row.dataset.img);
      const imgs = state.draft.images;
      const pathInput = row.querySelector("[data-im-path]");
      if (pathInput) {
        pathInput.addEventListener("input", () => { imgs[i] = pathInput.value; });
        pathInput.addEventListener("change", () => { const t = row.querySelector("img"); if (t) { t.style.display = ""; t.src = pathInput.value; } });
      }
      row.querySelector('[data-im="main"]').onclick = () => { imgs.unshift(imgs.splice(i, 1)[0]); renderImages(); };
      row.querySelector('[data-im="up"]').onclick = () => { if (i > 0) { [imgs[i - 1], imgs[i]] = [imgs[i], imgs[i - 1]]; renderImages(); } };
      row.querySelector('[data-im="down"]').onclick = () => { if (i < imgs.length - 1) { [imgs[i + 1], imgs[i]] = [imgs[i], imgs[i + 1]]; renderImages(); } };
      row.querySelector('[data-im="del"]').onclick = () => { imgs.splice(i, 1); renderImages(); };
    });
  }

  function bindEditorButtons() {
    $("#img-add").onclick = () => {
      const inp = $("#img-url");
      const v = inp.value.trim();
      if (!v) return;
      state.draft.images = state.draft.images || [];
      state.draft.images.push(v);
      inp.value = "";
      renderImages();
    };
    $("#img-file").onchange = (e) => {
      const files = Array.from(e.target.files || []);
      let pending = files.length;
      if (!pending) return;
      files.forEach((file) => {
        const rd = new FileReader();
        rd.onload = () => {
          state.draft.images = state.draft.images || [];
          state.draft.images.push(rd.result);
          if (--pending === 0) renderImages();
        };
        rd.readAsDataURL(file);
      });
      e.target.value = "";
    };
    $("#spec-add").onclick = () => {
      const list = $("#spec-list");
      const i = list.children.length;
      list.insertAdjacentHTML("beforeend", specRow("", "", i));
      bindSpecRows();
    };
    bindSpecRows();
  }
  function bindSpecRows() {
    $$(".spec-row", $("#spec-list")).forEach((row) => {
      row.querySelector("[data-sdel]").onclick = () => { row.remove(); };
    });
  }

  function collectDraft() {
    const d = state.draft;
    // характеристики
    const specs = {};
    $$(".spec-row", $("#spec-list")).forEach((row) => {
      const k = row.querySelector("[data-sk]").value.trim();
      const v = row.querySelector("[data-sv]").value.trim();
      if (k) specs[k] = v;
    });
    d.specs = specs;
    if (!d.series) d.series = d.name;
    if (!d.watchSize) d.watchSize = null;
    d.priceCard = cardPrice(d.priceCash); // карта всегда = наличными +10%
    return d;
  }

  function applyEditor() {
    const d = collectDraft();
    if (!d.name.trim()) { toast("Укажите название модели"); return; }
    pushUndo();
    let propagated = 0;
    if (state.editingId === "__new__") {
      d.id = newId(d);
      // порядок сортировки: рядом с такой же серией, иначе в начало категории
      const sameSeries = state.catalog.products.find((p) => p.category === d.category && p.name === d.name);
      d.seriesOrder = sameSeries ? sameSeries.seriesOrder : 0;
      state.catalog.products.unshift(d);
      propagated = propagateColorImages(d);
      toast("Товар добавлен");
    } else {
      const idx = state.catalog.products.findIndex((p) => p.id === state.editingId);
      if (idx >= 0) state.catalog.products[idx] = d;
      propagated = propagateColorImages(d);
      toast(propagated ? `Изменения применены · фото применено к ${propagated} вар. этого цвета` : "Изменения применены");
    }
    closeEditor();
    fillCatFilter();
    renderProducts();
  }

  function deleteFromEditor() {
    if (state.editingId === "__new__") return;
    const id = state.editingId;
    if (!confirm("Удалить этот товар? Можно вернуть через «Отменить» (Ctrl+Z).")) return;
    pushUndo();
    state.catalog.products = state.catalog.products.filter((p) => p.id !== id);
    closeEditor();
    fillCatFilter();
    renderProducts();
    toast("Товар удалён · Ctrl+Z вернёт");
  }

  // ---------- Категории ----------
  function renderCategories() {
    const list = $("#c-list");
    const cats = state.catalog.categories;
    list.innerHTML = cats
      .map((c, i) => {
        const n = productsIn(c.key).length;
        return `<div class="adm-row" data-key="${esc(c.key)}">
          <span class="w-8 h-8 rounded-lg grid place-items-center text-white shrink-0" style="background:${esc(c.accent || "#0582F6")}">${svg("dot", "w-4 h-4")}</span>
          <div class="min-w-0 flex-1">
            <input class="adm-input font-medium" data-ct value="${esc(c.title)}"/>
          </div>
          <input type="color" class="adm-input w-12 h-9 p-1 shrink-0" data-cc value="${/^#[0-9a-f]{6}$/i.test(c.accent) ? c.accent : "#0582F6"}" title="Цвет категории"/>
          <span class="chip ${n ? "chip-green" : "chip-amber"} shrink-0">${n} тов.</span>
          <div class="flex items-center gap-1 shrink-0">
            <button class="adm-icbtn" data-cm="up" title="Выше" ${i === 0 ? "disabled" : ""}>${svg("up", "w-4 h-4")}</button>
            <button class="adm-icbtn" data-cm="down" title="Ниже" ${i === cats.length - 1 ? "disabled" : ""}>${svg("down", "w-4 h-4")}</button>
            <button class="adm-icbtn text-apple-red" data-cm="del" title="Удалить">${svg("trash", "w-4 h-4")}</button>
          </div>
        </div>`;
      })
      .join("");

    $$(".adm-row", list).forEach((row) => {
      const key = row.dataset.key;
      const c = catByKey(key);
      row.querySelector("[data-ct]").addEventListener("change", (e) => renameCategory(key, e.target.value.trim()));
      row.querySelector("[data-cc]").addEventListener("change", (e) => { pushUndo(); c.accent = e.target.value; });
      row.querySelector('[data-cm="up"]').onclick = () => moveCategory(key, -1);
      row.querySelector('[data-cm="down"]').onclick = () => moveCategory(key, 1);
      row.querySelector('[data-cm="del"]').onclick = () => deleteCategory(key);
    });
  }

  function addCategory() {
    const title = prompt("Название новой категории (например, «Приставки»):", "");
    if (!title || !title.trim()) return;
    const t = title.trim();
    let key = t;
    if (state.catalog.categories.some((c) => c.key === key)) key = t + " " + Math.random().toString(36).slice(2, 5);
    pushUndo();
    state.catalog.categories.push({ key, title: t, brand: "Apple", accent: "#0582F6", glyph: "accessory" });
    renderCategories();
    fillCatFilter();
    toast("Категория добавлена");
  }

  function renameCategory(key, title) {
    if (!title) { renderCategories(); return; }
    const c = catByKey(key);
    if (!c || c.title === title) return;
    pushUndo();
    c.title = title;
    // ключ храним стабильным (на него ссылаются товары), меняем только отображаемое имя
    toast("Категория переименована");
    fillCatFilter();
  }

  function moveCategory(key, dir) {
    const cats = state.catalog.categories;
    const i = cats.findIndex((c) => c.key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cats.length) return;
    pushUndo();
    [cats[i], cats[j]] = [cats[j], cats[i]];
    renderCategories();
  }

  function deleteCategory(key) {
    const c = catByKey(key);
    if (!c) return;
    const n = productsIn(key).length;
    const msg = n
      ? `В категории «${c.title}» ${n} товаров. Удалить категорию ВМЕСТЕ с товарами?\nМожно вернуть через «Отменить» (Ctrl+Z).`
      : `Удалить пустую категорию «${c.title}»?`;
    if (!confirm(msg)) return;
    pushUndo();
    state.catalog.categories = state.catalog.categories.filter((x) => x.key !== key);
    state.catalog.products = state.catalog.products.filter((p) => p.category !== key);
    renderCategories();
    fillCatFilter();
    toast(n ? `Категория и ${n} тов. удалены · Ctrl+Z вернёт` : "Категория удалена");
  }

  // ---------- История версий (сервер) ----------
  async function loadHistory() {
    const list = $("#h-list");
    if (!state.api) {
      list.innerHTML = `<div class="glass rounded-2xl p-4 text-sm text-ink-mute">Серверная история доступна только с подключённым воркером (URL API). В демо-режиме используйте «Отменить/Повторить» (Ctrl+Z / Ctrl+Y) и «Скачать каталог».</div>`;
      return;
    }
    list.innerHTML = `<div class="text-sm text-ink-mute py-6 text-center">Загружаю историю…</div>`;
    try {
      const r = await api("/api/admin/history");
      const versions = r.versions || [];
      if (!versions.length) {
        list.innerHTML = `<div class="glass rounded-2xl p-4 text-sm text-ink-mute">Пока нет сохранённых версий. Они создаются автоматически при каждом сохранении.</div>`;
        return;
      }
      list.innerHTML = versions
        .map((v) => {
          const dt = new Date(v.ts);
          const when = dt.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
          return `<div class="adm-row" data-ts="${v.ts}">
            <span class="adm-icbtn text-ink-mute pointer-events-none">${svg("clock")}</span>
            <div class="min-w-0 flex-1">
              <div class="font-medium">${when}</div>
              <div class="text-xs text-ink-mute truncate">${v.count} товаров${v.note ? " · " + esc(v.note) : ""}</div>
            </div>
            <button class="btn-pill text-sm shrink-0" data-restore>Восстановить</button>
          </div>`;
        })
        .join("");
      $$("[data-ts]", list).forEach((row) => {
        row.querySelector("[data-restore]").onclick = () => restore(Number(row.dataset.ts));
      });
    } catch (e) {
      list.innerHTML = `<div class="glass rounded-2xl p-4 text-sm text-apple-red">${esc(e.message)}</div>`;
    }
  }

  async function restore(ts) {
    if (!confirm("Восстановить эту версию каталога? Текущая версия будет сохранена в резервную копию.")) return;
    toast("Восстанавливаю версию…");
    try {
      const r = await api("/api/admin/restore", { method: "POST", body: JSON.stringify({ ts }) });
      if (r.catalog) {
        state.catalog = r.catalog;
        if (!state.catalog.categories) state.catalog.categories = [];
        if (!state.catalog.products) state.catalog.products = [];
      }
      state.undo.length = 0; state.redo.length = 0; markDirty();
      switchTab("products");
      toast("Версия восстановлена");
      loadHistory();
    } catch (e) { toast(e.message); }
  }

  // ---------- esc ----------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---------- Вход ----------
  async function onLogin(e) {
    e.preventDefault();
    state.token = $("#token").value.trim();
    const custom = $("#api").value.trim();
    state.api = custom ? custom.replace(/\/$/, "") : "";
    const st = $("#login-status");
    if (!state.api && !confirm("URL воркера не задан. Открыть в ДЕМО-режиме (все правки локально, сохранение — файлом)?")) return;
    st.textContent = "Проверяю доступ…";
    st.className = "text-sm text-ink-mute";
    try {
      // Проверяем токен на защищённом эндпоинте — иначе ошибка всплывёт только
      // при сохранении (как раз тот самый 401 на /api/admin/save).
      if (state.api) {
        if (!state.token) { st.textContent = "Введите токен доступа (ADMIN_TOKEN воркера)."; st.className = "text-sm text-apple-red"; return; }
        try {
          await api("/api/admin/history");
        } catch (err) {
          if (/401/.test(err.message)) {
            st.innerHTML = "Неверный токен (401). Он должен совпадать с секретом <b>ADMIN_TOKEN</b> воркера (<code>wrangler secret put ADMIN_TOKEN</code>).";
            st.className = "text-sm text-apple-red";
            return;
          }
          if (/404/.test(err.message)) {
            st.innerHTML = "Воркер без новых эндпоинтов. Обновите деплой: <code>wrangler deploy</code>.";
            st.className = "text-sm text-apple-red";
            return;
          }
          throw err;
        }
      }
      await loadCatalog();
      $("#login").classList.add("hidden");
      $("#app").classList.remove("hidden");
      fillCatFilter();
      renderActive();
      toast(state.api ? "Подключено к воркеру" : "Демо-режим (без сервера)");
    } catch (err) {
      st.textContent = err.message;
      st.className = "text-sm text-apple-red";
    }
  }

  function logout() {
    if (state.undo.length && !confirm("Есть несохранённые изменения. Выйти без сохранения?")) return;
    state.token = "";
    state.catalog = null;
    state.undo.length = 0; state.redo.length = 0;
    $("#app").classList.add("hidden");
    $("#login").classList.remove("hidden");
    $("#token").value = "";
  }

  // ---------- Инициализация ----------
  function init() {
    $$("[data-brand]").forEach((el) => (el.textContent = CONFIG.brand));
    $("#api").value = CONFIG.apiBase || "";
    $("#login-logo").innerHTML = svg("package", "w-5 h-5");
    $("#top-logo").innerHTML = svg("package", "w-5 h-5");

    // иконки в статичной разметке
    $$("[data-ic]").forEach((el) => (el.innerHTML = svg(el.dataset.ic, "w-4 h-4")));
    $("#btn-undo").innerHTML = svg("undo");
    $("#btn-redo").innerHTML = svg("redo");
    $("#btn-more").innerHTML = svg("more");
    $("#drawer-close").innerHTML = svg("x");

    $("#login-form").addEventListener("submit", onLogin);
    $("#btn-save").onclick = save;
    $("#btn-undo").onclick = doUndo;
    $("#btn-redo").onclick = doRedo;
    $("#p-add").onclick = () => openEditor("__new__");
    $("#c-add").onclick = addCategory;
    $("#h-reload").onclick = loadHistory;

    $("#p-search").addEventListener("input", (e) => { state.query = e.target.value; renderProducts(); });
    $("#p-catfilter").addEventListener("change", (e) => { state.filterCat = e.target.value; renderProducts(); });

    $$(".adm-tab").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

    // Меню «Ещё»
    const menu = $("#more-menu");
    $("#btn-more").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
    document.addEventListener("click", () => menu.classList.add("hidden"));
    menu.addEventListener("click", (e) => e.stopPropagation());
    $$("[data-more]", menu).forEach((b) => {
      b.onclick = () => {
        menu.classList.add("hidden");
        const a = b.dataset.more;
        if (a === "seed") seedKV();
        else if (a === "export") exportCatalog();
        else if (a === "reload") loadCatalog().then(() => { fillCatFilter(); renderActive(); toast("Каталог перезагружен"); }).catch((e) => toast(e.message));
        else if (a === "logout") logout();
      };
    });

    // Редактор
    $("#drawer-close").onclick = closeEditor;
    $("#drawer-cancel").onclick = closeEditor;
    $("#drawer-scrim").onclick = closeEditor;
    $("#drawer-apply").onclick = applyEditor;
    $("#drawer-delete").onclick = deleteFromEditor;

    // Горячие клавиши
    document.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "s") { e.preventDefault(); save(); }
      else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && k === "z") { e.preventDefault(); doUndo(); }
      else if ((e.metaKey || e.ctrlKey) && (k === "y" || (e.shiftKey && k === "z"))) { e.preventDefault(); doRedo(); }
      else if (k === "escape" && state.editingId !== null) closeEditor();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
