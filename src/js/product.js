// product.js — Страница товара с матрицей вариантов (Цвет × Память/Размер × SIM).
// Использует глобали из app.js: deviceGlyph, productFrames, statusBadge,
// openLeadModal, openTradeInModal, Store, CONFIG, lucideSVG.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const CAT = window.__CATALOG__ || { products: [] };
  let ALL = CAT.products || []; // может замениться данными из KV (см. loadFromKV)
  const CUR = (CAT.meta && CAT.meta.currency) || (window.CONFIG && CONFIG.currency) || "₽";
  const root = document.getElementById("product-root");

  const money = (n) => new Intl.NumberFormat("ru-RU").format(n) + " " + CUR;
  const getId = () => new URLSearchParams(location.search).get("id");
  const escA = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const rank = (s) => { const m = String(s).match(/([\d.]+)\s*(ТБ|TB|ГБ|GB)/i); if (!m) return 0; let n = parseFloat(m[1]); if (/Т|T/i.test(m[2])) n *= 1024; return n; };
  const uniqBy = (arr, key) => { const s = new Set(), o = []; for (const x of arr) { const k = key(x); if (!s.has(k)) { s.add(k); o.push(x); } } return o; };

  const seriesVariants = (name) => ALL.filter((x) => x.name === name);

  // Точный SKU по комбинации; dims — какие измерения учитываем
  function findSKU(vs, sel, dims) {
    return vs.find((v) => dims.every((d) => (sel[d] == null) || v[d] === sel[d])) || null;
  }
  // Ближайший при отсутствии точного: приоритет — совпадение по dim + наличие
  function closest(vs, dims, priority) {
    // priority — измерение, которое НЕЛЬЗЯ терять (только что выбранное)
    const withPref = vs.filter((v) => v[priority.dim] === priority.val);
    const pool = withPref.length ? withPref : vs;
    return pool.slice().sort((a, b) => (a.status === "in_stock" ? -1 : 1) - (b.status === "in_stock" ? -1 : 1) || a.priceCash - b.priceCash)[0];
  }

  function dimsOf(vs) {
    const dims = ["color"];
    if (vs.some((v) => v.storage && v.storage !== "—")) dims.push("storage");
    if (vs.some((v) => v.watchSize)) dims.push("watchSize");
    if (vs.some((v) => v.sim && v.sim !== "—")) dims.push("sim");
    return dims;
  }

  function notFound() {
    return `<div class="py-24 text-center">
      <div class="text-2xl font-semibold">Товар не найден</div>
      <a href="index.html#catalog" class="btn-primary px-6 py-3 mt-6 inline-flex">Вернуться в каталог</a>
    </div>`;
  }

  // Все фото выбранного ЦВЕТА (память/SIM у одного цвета делят одни снимки).
  // Возвращаем пары {full, thumb}: full — полноразмерное, thumb — лёгкое превью.
  function colorMedia(p, vs) {
    const seen = new Set();
    const out = [];
    (vs || []).forEach((v) => {
      if (v.color !== p.color || !Array.isArray(v.images)) return;
      v.images.forEach((src, i) => {
        if (src && !seen.has(src)) {
          seen.add(src);
          out.push({ full: src, thumb: (Array.isArray(v.thumbs) && v.thumbs[i]) || src });
        }
      });
    });
    if (p.images && p.images[0]) {
      const idx = out.findIndex((o) => o.full === p.images[0]);
      if (idx > 0) out.unshift(out.splice(idx, 1)[0]);
    }
    return out;
  }

  // --- галерея (lazy: полное фото грузится только когда кадр открывают) ---
  function gallery(p, vs) {
    const media = colorMedia(p, vs);
    if (!media.length) {
      const frames = productFrames(p, 220);
      return `
        <div class="lg:sticky lg:top-20">
          <div class="card-media relative block aspect-square rounded-3xl overflow-hidden media-plate shadow-card" data-media>
            <div class="relative h-full">
              ${frames.map((f, i) => `<div class="absolute inset-0 grid place-items-center transition-opacity duration-150 ${i === 0 ? "opacity-100" : "opacity-0"}" data-frame="${i}">${f}</div>`).join("")}
            </div>
          </div>
        </div>`;
    }
    // первый кадр грузим сразу (eager), остальные — только по требованию (data-full)
    const mainImg = (o, i) =>
      `<img ${i === 0 ? `src="${escA(o.full)}"` : `data-full="${escA(o.full)}"`} alt="${escA(p.name)}" class="max-h-[86%] max-w-[86%] object-contain" loading="${i === 0 ? "eager" : "lazy"}" decoding="async">`;
    return `
      <div class="lg:sticky lg:top-20">
        <div class="card-media relative block aspect-square rounded-3xl overflow-hidden media-plate shadow-card" data-media>
          <div class="relative h-full">
            ${media.map((o, i) => `<div class="absolute inset-0 grid place-items-center transition-opacity duration-150 ${i === 0 ? "opacity-100" : "opacity-0"}" data-frame="${i}">${mainImg(o, i)}</div>`).join("")}
          </div>
          ${media.length > 1 ? `<span class="absolute left-4 top-4 chip bg-white/80 text-ink-mute text-xs">Наведите, чтобы рассмотреть</span>` : ""}
        </div>
        ${media.length > 1 ? `<div class="mt-3 flex justify-center gap-2 flex-wrap">
          ${media.map((o, i) => `<button class="thumb w-16 h-16 rounded-2xl media-plate grid place-items-center overflow-hidden ring-2 ${i === 0 ? "ring-brand" : "ring-transparent"} transition" data-thumb="${i}"><img src="${escA(o.thumb)}" alt="" class="max-h-[86%] max-w-[86%] object-contain" loading="lazy" decoding="async"${o.thumb !== o.full ? ` onerror="this.onerror=null;this.src='${escA(o.full)}'"` : ""}></button>`).join("")}
        </div>` : ""}
      </div>`;
  }

  // --- строка выбора цвета (свотчи) ---
  function colorRow(p, vs, dims) {
    const cols = uniqBy(vs.filter((v) => v.colorHex), (v) => v.colorHex);
    if (cols.length < 2) return `<div class="mt-1 text-sm text-ink-mute">Цвет: <b class="text-ink-soft">${p.color}</b></div>`;
    return `
      <div class="mt-5">
        <div class="text-sm text-ink-soft mb-2">Цвет: <b>${p.color}</b></div>
        <div class="flex flex-wrap gap-2">
          ${cols.map((v) => {
            const st = optState(vs, dims, p, "color", v.color);
            return `<button class="swatch w-8 h-8 ${v.color === p.color ? "is-active" : ""} ${st === "na" ? "opacity-40" : ""}" data-pick="color" data-val="${escA(v.color)}" title="${escA(v.color)}${st === "order" ? " · под заказ" : ""}" style="--sw:${v.colorHex}"></button>`;
          }).join("")}
        </div>
      </div>`;
  }

  // --- строка кнопок для storage / watchSize / sim ---
  function btnRow(p, vs, dims, dim, label, values) {
    if (values.length < 2 && !(values.length === 1)) return "";
    if (values.length < 1) return "";
    return `
      <div class="mt-5">
        <div class="text-sm text-ink-soft mb-2">${label}</div>
        <div class="flex flex-wrap gap-2">
          ${values.map((val) => {
            const st = optState(vs, dims, p, dim, val);
            const active = p[dim] === val;
            const dot = st === "order" ? `<span class="w-1.5 h-1.5 rounded-full bg-apple-amber ml-1"></span>` : (st === "na" ? "" : "");
            return `<button class="btn-pill inline-flex items-center ${active ? "is-active" : ""} ${st === "na" ? "opacity-45" : ""}" data-pick="${dim}" data-val="${escA(val)}">${val}${dot}</button>`;
          }).join("")}
        </div>
      </div>`;
  }

  // состояние опции при текущем выборе прочих измерений: in | order | na
  function optState(vs, dims, p, dim, val) {
    const sel = {};
    dims.forEach((d) => (sel[d] = d === dim ? val : p[d]));
    const exact = findSKU(vs, sel, dims);
    if (exact) return exact.status === "in_stock" ? "in" : "order";
    return "na";
  }

  function specsTable(p) {
    const base = [
      ["Бренд", p.brand], ["Категория", p.category], ["Модель", p.series],
      p.storage && p.storage !== "—" ? ["Память", p.storage] : null,
      p.watchSize ? ["Размер корпуса", p.watchSize] : null,
      ["Цвет", p.color], p.sim && p.sim !== "—" ? ["SIM", p.sim] : null,
    ].filter(Boolean);
    const rows = base.concat(p.specs ? Object.entries(p.specs) : []);
    const N = 14; // сколько строк показываем сразу; остальное — под кнопкой
    const trs = rows.map(([k, v], i) =>
      `<tr class="${i ? "border-t border-black/[0.06]" : ""} ${i >= N ? "spec-extra hidden" : ""}"><td class="p-4 text-ink-mute w-1/2 sm:w-1/3 align-top">${k}</td><td class="p-4 text-ink-soft font-medium">${v}</td></tr>`
    ).join("");
    const more = rows.length > N
      ? `<div class="mt-3 text-center"><button class="btn-pill text-sm" data-specs-toggle data-total="${rows.length}">Показать все характеристики (${rows.length})</button></div>`
      : "";
    return `
      <div class="mt-12">
        <h2 class="text-xl font-semibold tracking-tight mb-4">Характеристики</h2>
        <div class="rounded-3xl bg-cloud-card shadow-card overflow-hidden">
          <table class="w-full text-sm"><tbody>${trs}</tbody></table>
        </div>
        ${more}
      </div>`;
  }

  function favIcon(a) {
    return a
      ? `<svg viewBox="0 0 24 24" class="w-5 h-5 text-apple-red" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round">${window.ICONS.heart}</svg>`
      : lucideSVG("heart", "w-5 h-5 text-ink-mute");
  }
  const cmpIcon = (a) => lucideSVG("git-compare", "w-5 h-5 " + (a ? "text-brand" : "text-ink-mute"));

  function view(p, vs, dims) {
    const fav = Store.isFavorite(p.id), cmp = Store.inCompare(p.id);
    const storages = uniqBy(vs.filter((v) => v.storage && v.storage !== "—"), (v) => v.storage).map((v) => v.storage).sort((a, b) => rank(a) - rank(b));
    const sizes = Array.from(new Set(vs.map((v) => v.watchSize).filter(Boolean))).sort((a, b) => parseInt(a) - parseInt(b));
    const sims = uniqBy(vs.filter((v) => v.sim && v.sim !== "—"), (v) => v.sim).map((v) => v.sim);

    return `
      <nav class="text-sm text-ink-mute mb-6 flex items-center gap-1.5 flex-wrap">
        <a href="index.html" class="hover:text-ink">Главная</a><span>/</span>
        <a href="index.html#cat=${encodeURIComponent(p.category)}" class="hover:text-ink">${esc(p.category)}</a><span>/</span>
        <span class="text-ink">${p.series}</span>
      </nav>

      <div class="grid lg:grid-cols-2 gap-8 lg:gap-12">
        ${gallery(p, vs)}
        <div>
          <div class="flex items-start justify-between gap-4">
            <div>
              <h1 class="text-3xl sm:text-4xl font-semibold tracking-tight">${p.series}</h1>
              <p class="text-ink-mute mt-1" data-sub>${[p.storage !== "—" ? p.storage : p.watchSize, p.color].filter(Boolean).join(" · ")}</p>
            </div>
            <div class="flex gap-2 shrink-0">
              <button class="grid place-items-center w-10 h-10 rounded-full bg-black/5 hover:bg-black/10 transition" data-fav aria-pressed="${fav}">${favIcon(fav)}</button>
              <button class="grid place-items-center w-10 h-10 rounded-full bg-black/5 hover:bg-black/10 transition" data-cmp aria-pressed="${cmp}">${cmpIcon(cmp)}</button>
            </div>
          </div>

          <div class="mt-4" data-status>${statusBadge(p.status)}</div>

          ${colorRow(p, vs, dims)}
          ${btnRow(p, vs, dims, "storage", "Память", storages)}
          ${btnRow(p, vs, dims, "watchSize", "Размер корпуса", sizes)}
          ${btnRow(p, vs, dims, "sim", "SIM-карта", sims)}

          <div class="mt-6 rounded-3xl bg-cloud-card shadow-card p-5">
            <div class="flex items-end justify-between gap-4 flex-wrap">
              <div><div class="text-xs text-ink-mute">Наличными</div><div class="text-3xl font-semibold tracking-tight" data-cash>${money(p.priceCash)}</div></div>
              <div class="text-right"><div class="text-xs text-ink-mute">Картой / в кредит</div><div class="text-lg font-medium text-ink-soft" data-card>${money(p.priceCard)}</div></div>
            </div>
            <button class="btn-primary w-full mt-5" data-buy>Оформить заявку</button>
            <div class="grid grid-cols-3 gap-2 mt-3">
              <a data-tg href="#" target="_blank" rel="noopener" class="btn-soft text-sm justify-center">Telegram</a>
              <a data-wa href="#" target="_blank" rel="noopener" class="btn-soft text-sm justify-center">WhatsApp</a>
              <a data-phone href="#" class="btn-soft text-sm justify-center">Позвонить</a>
            </div>
          </div>

          <div class="mt-5"><button class="btn-ghost" data-tradein>Оценить свой по Trade-In →</button></div>
          <ul class="mt-6 space-y-2 text-sm text-ink-soft">
            <li class="flex gap-2"><span class="text-brand">✓</span> Оригинальная техника, гарантия магазина</li>
            <li class="flex gap-2"><span class="text-brand">✓</span> Доставка по городу и самовывоз</li>
            <li class="flex gap-2"><span class="text-brand">✓</span> Trade-In и рассрочка 0-0-12</li>
          </ul>
        </div>
      </div>
      ${specsTable(p)}`;
  }

  function goVariant(v) {
    if (!v) return;
    const u = new URL(location.href);
    u.searchParams.set("id", v.id);
    history.replaceState(null, "", u);
    render();
  }

  // Выбор параметра: строго ищем SKU с новой комбинацией, иначе ближайший
  function pick(p, vs, dims, dim, val) {
    const sel = {};
    dims.forEach((d) => (sel[d] = d === dim ? val : p[d]));
    let target = findSKU(vs, sel, dims);
    if (!target) target = closest(vs, dims, { dim, val }); // сохраняем только что выбранное измерение
    goVariant(target);
  }

  // Лайтбокс: открывает фото в высоком качестве с затемнением экрана.
  function openLightbox(src, alt) {
    let ov = document.getElementById("lightbox");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "lightbox";
      ov.className = "fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm grid place-items-center p-4 opacity-0 transition-opacity duration-200 hidden";
      ov.innerHTML =
        `<img class="max-h-[92vh] max-w-[92vw] object-contain rounded-2xl shadow-pop select-none" alt="">` +
        `<button data-lb-close class="absolute top-4 right-4 w-11 h-11 grid place-items-center rounded-full bg-white/15 text-white hover:bg-white/25 transition" aria-label="Закрыть">` +
        `<svg viewBox="0 0 24 24" class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;
      document.body.appendChild(ov);
      const close = () => { ov.classList.add("opacity-0"); document.body.style.overflow = ""; setTimeout(() => ov.classList.add("hidden"), 200); };
      ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest("[data-lb-close]")) close(); });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !ov.classList.contains("hidden")) close(); });
    }
    const img = ov.querySelector("img");
    img.src = src; img.alt = alt || "";
    ov.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => ov.classList.remove("opacity-0"));
  }

  function wire(p, vs, dims) {
    const media = $("[data-media]", root);
    const frames = $$("[data-frame]", media);
    const thumbs = $$("[data-thumb]", root);
    media.style.cursor = "zoom-in";
    let cur = 0;
    const openCurrent = () => {
      const img = frames[cur] && frames[cur].querySelector("img");
      const s = img && (img.getAttribute("src") || img.getAttribute("data-full"));
      if (s) openLightbox(s, p.series);
    };
    const show = (i) => {
      cur = i;
      frames.forEach((f, k) => (f.style.opacity = k === i ? "1" : "0"));
      // ленивая догрузка полноразмерного фото только для открываемого кадра
      const img = frames[i] && frames[i].querySelector("img[data-full]");
      if (img && !img.getAttribute("src")) img.src = img.getAttribute("data-full");
      thumbs.forEach((t, k) => { t.classList.toggle("ring-brand", k === i); t.classList.toggle("ring-transparent", k !== i); });
    };
    if (frames.length > 1) {
      const n = frames.length;
      media.style.touchAction = "pan-y";
      const at = (x) => { const r = media.getBoundingClientRect(); return Math.max(0, Math.min(n - 1, Math.floor(((x - r.left) / r.width) * n))); };
      // Десктоп: скраб мышью при наведении. Мобильный: СВАЙП влево/вправо меняет фото
      // (а не «драг-скраб»), вертикальный свайп прокручивает страницу.
      let sx = 0, sy = 0, swiping = false;
      media.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") show(at(e.clientX)); });
      media.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "mouse") { swiping = true; sx = e.clientX; sy = e.clientY; }
      });
      media.addEventListener("pointerup", (e) => {
        if (e.pointerType === "mouse" || !swiping) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
          show(Math.max(0, Math.min(n - 1, cur + (dx < 0 ? 1 : -1))));
          media._noClick = true; // свайп не должен открывать лайтбокс
        }
        swiping = false;
      });
      media.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") show(0); });
      media.addEventListener("pointercancel", () => { swiping = false; });
      thumbs.forEach((t) => t.addEventListener("click", () => show(+t.dataset.thumb)));
    }
    // Клик/тап по фото → лайтбокс (высокое качество, затемнение экрана)
    media.addEventListener("click", () => {
      if (media._noClick) { media._noClick = false; return; }
      openCurrent();
    });

    // Матрица: любой параметр
    $$("[data-pick]", root).forEach((b) =>
      b.addEventListener("click", () => pick(p, vs, dims, b.dataset.pick, b.dataset.val))
    );

    const specToggle = $("[data-specs-toggle]", root);
    if (specToggle) specToggle.addEventListener("click", () => {
      const extra = $$(".spec-extra", root);
      const willShow = extra.length && extra[0].classList.contains("hidden");
      extra.forEach((tr) => tr.classList.toggle("hidden"));
      specToggle.textContent = willShow ? "Свернуть характеристики" : `Показать все характеристики (${specToggle.dataset.total})`;
    });

    $("[data-fav]", root)?.addEventListener("click", () => { Store.toggleFavorite(p.id); render(); });
    $("[data-cmp]", root)?.addEventListener("click", () => { Store.toggleCompare(p.id); render(); });
    $("[data-buy]", root)?.addEventListener("click", () => openLeadModal(p.id));
    $("[data-tradein]", root)?.addEventListener("click", () => openTradeInModal());

    if (window.CONFIG) {
      $$("[data-tg]", root).forEach((el) => (el.href = CONFIG.contacts.telegram));
      $$("[data-wa]", root).forEach((el) => (el.href = CONFIG.contacts.whatsapp));
      $$("[data-phone]", root).forEach((el) => (el.href = `tel:${CONFIG.contacts.phoneHref}`));
    }
  }

  // Устойчивый поиск: точное совпадение → тот же вариант с изменённым SEQ →
  // любой товар той же серии (по убывающему префиксу id). Старые ссылки не «умирают».
  function resolveProduct(id) {
    if (!id) return null;
    let p = ALL.find((x) => x.id === id);
    if (p) return p;
    const base = id.replace(/-\d+$/, "");
    p = ALL.find((x) => x.id.replace(/-\d+$/, "") === base);
    if (p) return p;
    const segs = id.split("-");
    for (let n = segs.length - 1; n >= 3; n--) {
      const pref = segs.slice(0, n).join("-") + "-";
      p = ALL.find((x) => x.id.startsWith(pref));
      if (p) return p;
    }
    return null;
  }

  function render() {
    const id = getId();
    const p = resolveProduct(id);
    if (!p) { root.innerHTML = notFound(); return; }
    if (p.id !== id) { const u = new URL(location.href); u.searchParams.set("id", p.id); history.replaceState(null, "", u); }
    const vs = seriesVariants(p.name);
    const dims = dimsOf(vs);
    document.title = `${p.series} — Apple и точка`;
    root.innerHTML = view(p, vs, dims);
    wire(p, vs, dims);
    if (window.lucideInit) window.lucideInit(root);
  }

  // Реальное время: если задан воркер и он доступен — берём каталог из KV
  // (как на главной). При file:// или недоступности — остаётся встроенный.
  // Кэш каталога в sessionStorage — общий с главной; мгновенный первый рендер.
  function readCache() {
    try { const d = JSON.parse(sessionStorage.getItem("catalog:v1") || "null"); return d && Array.isArray(d.products) ? d : null; } catch (e) { return null; }
  }
  async function loadFromKV() {
    try {
      if (window.CONFIG && CONFIG.apiBase) {
        const r = await fetch(`${CONFIG.apiBase}/api/products`, { cache: "no-cache" });
        if (r.ok) {
          const d = await r.json();
          if (d && Array.isArray(d.products) && d.products.length) {
            try { sessionStorage.setItem("catalog:v1", JSON.stringify(d)); } catch (e) {}
            if (JSON.stringify(d.products) !== JSON.stringify(ALL)) { ALL = d.products; return true; }
          }
        }
      }
    } catch (e) { /* оставляем встроенный каталог */ }
    return false;
  }

  document.addEventListener("DOMContentLoaded", () => {
    const cached = readCache();               // самый свежий каталог этой вкладки
    if (cached) ALL = cached.products;
    render();                                 // мгновенно (кэш или встроенный)
    loadFromKV().then((changed) => { if (changed) render(); }); // фоновое обновление из KV
  });
})();
