// product.js — Страница товара с матрицей вариантов (Цвет × Память/Размер × SIM).
// Использует глобали из app.js: deviceGlyph, productFrames, statusBadge,
// openLeadModal, openTradeInModal, Store, CONFIG, lucideSVG.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const CAT = window.__CATALOG__ || { products: [] };
  // Канонизируем тип SIM (схлопывает дубли «2 eSIM / 2 eSIM» из KV/легаси-данных).
  const normAll = (arr) => { const f = window.normSim; if (f) for (const p of (arr || [])) { if (p && "sim" in p) p.sim = f(p.sim) || "—"; } return arr; };
  // Скрытые позиции убираем и здесь. Иначе получался рассинхрон: на первой
  // отрисовке страница берёт статический products.js и показывает скрытый
  // вариант как выбираемый, а через секунду данные из KV (там скрытых нет)
  // его убирают — кнопка исчезает у пользователя под курсором.
  const visibleOnly = (list) => (list || []).filter((p) => !p.hidden);
  // Подпись сырых данных — до normAll, которая правит объекты на месте. По ней
  // фоновое обновление понимает, что данные действительно изменились.
  let RAW_SIG = JSON.stringify(visibleOnly(CAT.products));
  let ALL = normAll(visibleOnly(CAT.products)); // может замениться данными из KV (см. loadFromKV)
  const CUR = (CAT.meta && CAT.meta.currency) || (window.CONFIG && CONFIG.currency) || "₽";
  const root = document.getElementById("product-root");
  let state = null; // {p, vs, dims} — текущий выбранный вариант (для in-place обновления)

  // Ноль = цены нет (комплектация не в прайсе поставщика). Показывать «0 ₽»
  // нельзя — покупатель решит, что товар бесплатный. См. пояснение в app.js.
  const PRICE_ON_REQUEST = "Уточняйте у менеджера";
  const money = (n) => new Intl.NumberFormat("ru-RU").format(n) + " " + CUR;
  const priceText = (v) => (Number(v) > 0 ? money(v) : PRICE_ON_REQUEST);
  // id берём из чистого URL /p/<id>/ (пререндер) или из ?id= (легаси/локально).
  const getId = () => {
    const m = location.pathname.match(/\/p\/([^\/]+)\/?$/);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    return new URLSearchParams(location.search).get("id");
  };
  const escA = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const rank = (s) => { const m = String(s).match(/([\d.]+)\s*(ТБ|TB|ГБ|GB)/i); if (!m) return 0; let n = parseFloat(m[1]); if (/Т|T/i.test(m[2])) n *= 1024; return n; };
  const uniqBy = (arr, key) => { const s = new Set(), o = []; for (const x of arr) { const k = key(x); if (!s.has(k)) { s.add(k); o.push(x); } } return o; };

  const seriesVariants = (name) => ALL.filter((x) => x.name === name);

  // Точный SKU по комбинации; dims — какие измерения учитываем
  function findSKU(vs, sel, dims) {
    return vs.find((v) => dims.every((d) => (sel[d] == null) || v[d] === sel[d])) || null;
  }
  // Ближайший SKU, если точной комбинации нет: только что выбранное измерение (dim=val)
  // ФИКСИРУЕМ, а из остальных сохраняем максимум текущего выбора (вес: цвет > память > SIM).
  // Так при выборе SIM не сбрасывается память/цвет, если такой SKU существует.
  function bestMatch(vs, dims, cur, dim, val) {
    const W = { color: 4, storage: 2, watchSize: 2, sim: 1, region: 1 };
    const locked = vs.filter((v) => v[dim] === val);
    const pool = locked.length ? locked : vs.slice();
    const keep = (v) => dims.reduce((s, d) => s + (d !== dim && v[d] === cur[d] ? (W[d] || 1) : 0), 0);
    return pool.slice().sort((a, b) =>
      (keep(b) - keep(a)) ||                                   // больше совпадений с текущим выбором
      ((a.status === "in_stock" ? 0 : 1) - (b.status === "in_stock" ? 0 : 1)) || // в наличии выше
      (a.priceCash - b.priceCash)                              // затем дешевле
    )[0];
  }

  function dimsOf(vs) {
    const dims = ["color"];
    if (vs.some((v) => v.storage && v.storage !== "—")) dims.push("storage");
    if (vs.some((v) => v.watchSize)) dims.push("watchSize");
    if (vs.some((v) => v.sim && v.sim !== "—")) dims.push("sim");
    // Регион поставки (напр. 🇦🇪 ОАЭ / 🇰🇿 Казахстан / 🇹🇭 Таиланд у региональных
    // версий Samsung .../DS) — самостоятельное измерение матрицы, если у серии
    // вообще встречаются товары с заполненным регионом.
    return dims;
  }

  function notFound() {
    return `<div class="py-24 text-center">
      <div class="text-2xl font-semibold">Товар не найден</div>
      <a href="/#catalog" class="btn-primary px-6 py-3 mt-6 inline-flex">Вернуться в каталог</a>
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
        <div class="lg:sticky lg:top-20" data-gallery-col>
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
      <div class="lg:sticky lg:top-20" data-gallery-col>
        <div class="card-media relative block aspect-square rounded-3xl overflow-hidden media-plate shadow-card" data-media>
          <div class="relative h-full">
            ${media.map((o, i) => `<div class="absolute inset-0 grid place-items-center transition-opacity duration-150 ${i === 0 ? "opacity-100" : "opacity-0"}" data-frame="${i}">${mainImg(o, i)}</div>`).join("")}
          </div>
          ${media.length > 1 ? `<span class="absolute left-4 top-4 chip bg-white/80 text-ink-mute text-xs pointer-events-none">${window.matchMedia && matchMedia("(hover: hover)").matches ? "Нажмите, чтобы рассмотреть" : "Листайте фото влево-вправо"}</span>
          <button type="button" data-gal-prev class="gal-arrow left-3" aria-label="Предыдущее фото"><svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
          <button type="button" data-gal-next class="gal-arrow right-3" aria-label="Следующее фото"><svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>` : ""}
        </div>
        ${media.length > 1 ? `<div class="mt-3 flex justify-center gap-2 flex-wrap">
          ${media.map((o, i) => `<button class="thumb w-16 h-16 rounded-2xl media-plate grid place-items-center overflow-hidden ring-2 ${i === 0 ? "ring-brand" : "ring-transparent"} transition" data-thumb="${i}"><img src="${escA(o.thumb)}" alt="" class="max-h-[86%] max-w-[86%] object-contain" loading="lazy" decoding="async"${o.thumb !== o.full ? ` onerror="this.onerror=null;this.src='${escA(o.full)}'"` : ""}></button>`).join("")}
        </div>` : ""}
      </div>`;
  }

  // --- строка выбора цвета (свотчи) ---
  function colorRow(p, vs, dims) {
    const cols = uniqBy(vs.filter((v) => v.colorHex), (v) => v.colorHex);
    if (cols.length < 2) return `<div class="mt-1 text-sm text-ink-mute">Цвет: <b class="text-ink-soft" data-color-label>${p.color}</b></div>`;
    return `
      <div class="mt-5">
        <div class="text-sm text-ink-soft mb-2">Цвет: <b data-color-label>${p.color}</b></div>
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
            const dot = st === "order" ? `<span data-dot class="w-1.5 h-1.5 rounded-full bg-apple-amber ml-1"></span>` : (st === "na" ? "" : "");
            const disp = dim === "sim" && window.simLabel ? window.simLabel(val) : val;
            return `<button class="btn-pill inline-flex items-center ${active ? "is-active" : ""} ${st === "na" ? "opacity-45" : ""}" data-pick="${dim}" data-val="${escA(val)}">${disp}${dot}</button>`;
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
      ["Цвет", p.color], p.sim && p.sim !== "—" ? ["SIM", (window.simLabel ? window.simLabel(p.sim) : p.sim)] : null,
      p.region ? ["Регион", p.region] : null,
      p.condition ? ["Состояние", (window.conditionLabel && window.conditionLabel(p)) || ""] : null,
    ].filter(Boolean);
    // Строку «Гарантия» из каталога игнорируем: там у всех стоит «12 мес.»,
    // включая наушники и аксессуары. Значение считаем по правилам магазина,
    // а где гарантии нет — строки нет вовсе.
    const specs = Object.entries(p.specs || {}).filter(([k]) => !/гаран/i.test(k));
    const w = window.warrantyPhrase ? window.warrantyPhrase(p) : "";
    const wm = w && w.match(/(\d+)\s*месяц/);
    const rows = base.concat(wm ? [["Гарантия", wm[1] + " мес."]] : []).concat(specs);
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
      <nav class="crumbs text-sm text-ink-mute mb-6 flex items-center gap-1.5 flex-wrap">
        <a href="/" class="hover:text-ink">Главная</a><span>/</span>
        <a href="/#cat=${encodeURIComponent(p.category)}" class="hover:text-ink">${esc(p.category)}</a><span>/</span>
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
              <button class="grid place-items-center w-11 h-11 rounded-full bg-black/5 hover:bg-black/10 active:scale-95 transition" data-fav aria-pressed="${fav}" aria-label="В избранное">${favIcon(fav)}</button>
              <button class="grid place-items-center w-11 h-11 rounded-full bg-black/5 hover:bg-black/10 active:scale-95 transition" data-cmp aria-pressed="${cmp}" aria-label="Сравнить">${cmpIcon(cmp)}</button>
            </div>
          </div>

          <div class="mt-4 flex flex-wrap items-center gap-1.5" data-status>${statusBadge(p.status)}${
            window.conditionLabel && window.conditionLabel(p)
              ? `<span class="chip bg-ink/[0.06] text-ink-soft">${esc(window.conditionLabel(p))}</span>`
              : ""
          }</div>

          ${colorRow(p, vs, dims)}
          ${btnRow(p, vs, dims, "storage", "Память", storages)}
          ${btnRow(p, vs, dims, "watchSize", "Размер корпуса", sizes)}
          ${btnRow(p, vs, dims, "sim", "SIM-карта", sims)}

          <div class="mt-6 rounded-3xl bg-cloud-card shadow-card p-5">
            <div class="flex items-end justify-between gap-4 flex-wrap">
              <div><div class="text-xs text-ink-mute">Наличными</div><div class="text-3xl font-semibold tracking-tight" data-cash>${priceText(p.priceCash)}</div></div>
              <div class="text-right${Number(p.priceCash) > 0 ? "" : " hidden"}" data-card-wrap><div class="text-xs text-ink-mute">Картой / в кредит</div><div class="text-lg font-medium text-ink-soft" data-card>${Number(p.priceCash) > 0 ? money(window.cardPrice(p)) : ""}</div></div>
            </div>
            <p class="text-xs text-ink-mute mt-2${p.priceEstimated ? "" : " hidden"}" data-price-note>Цена ориентировочная, уточните у <a href="#contacts" class="underline" data-tg-note>менеджера</a>.</p>
            <button class="btn-primary w-full mt-5" data-buy>Оформить заявку</button>
            <div class="grid grid-cols-3 gap-2 mt-3">
              <a data-tg href="#" target="_blank" rel="noopener" class="btn-soft text-sm justify-center">Telegram</a>
              <a data-wa href="#" target="_blank" rel="noopener" class="btn-soft text-sm justify-center">WhatsApp</a>
              <a data-phone href="#" class="btn-soft text-sm justify-center">Позвонить</a>
            </div>
          </div>

          <div class="mt-5"><button class="btn-ghost" data-tradein>Оценить свой по Trade-In →</button></div>
          <ul class="mt-6 space-y-2 text-sm text-ink-soft">
            <li class="flex gap-2"><svg viewBox="0 0 24 24" class="w-4 h-4 mt-0.5 shrink-0 text-brand" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg> Проверка при покупке${(window.warrantyPhrase && window.warrantyPhrase(p)) ? ", " + esc(window.warrantyPhrase(p)) : ""}</li>
            <li class="flex gap-2"><svg viewBox="0 0 24 24" class="w-4 h-4 mt-0.5 shrink-0 text-brand" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg> Доставка по городу и самовывоз</li>
            <li class="flex gap-2"><svg viewBox="0 0 24 24" class="w-4 h-4 mt-0.5 shrink-0 text-brand" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg> Trade-In и кредит от банка</li>
          </ul>
        </div>
      </div>
      ${specsTable(p)}`;
  }

  // Синхронизация адреса под выбранный вариант. На боевом (http/https) — чистый /p/<id>/
  // (это же читает getId() на пререндер-страницах!), поэтому МЕНЯЕМ pathname, а не ?id=,
  // и стираем легаси-хвост ?id=. При file:// — через ?id=.
  function setUrl(p) {
    try {
      if (location.protocol !== "file:") {
        const clean = `/p/${encodeURIComponent(p.id)}/`;
        if (location.pathname !== clean || location.search) history.replaceState(null, "", clean);
      } else {
        const u = new URL(location.href); u.searchParams.set("id", p.id); history.replaceState(null, "", u);
      }
    } catch (e) {}
  }

  // «Таганрог» → «Таганроге»: в заголовке нужен предложный падеж, иначе
  // в выдаче было «купить в Таганрог».
  function cityIn() {
    const c = (window.CONFIG && CONFIG.city) || "";
    if (!c) return "вашем городе";
    if (/[аеёиоуыэюя]$/i.test(c)) return c.replace(/а$/i, "е");
    return c + "е";
  }

  // Заголовок и описание — по той же формуле, что и при сборке
  // (scripts/prerender.js, seoHead). Раньше после загрузки скрипт подменял
  // заголовок на свой, без SIM и региона, и у разных комплектаций он
  // совпадал: поисковик, который выполняет JS, видел дубли.
  const COND_T = { used: "б/у", demo: "витринный" };
  // Пререндер-страница уже содержит заголовок, canonical и разметку под свой
  // товар: на ней при загрузке ничего не переписываем.
  const isPrerendered = (p) => document.documentElement.getAttribute("data-pid") === p.id;
  function setHead(p) {
    if (isPrerendered(p)) return;
    const bits = [p.series, p.storage !== "—" ? p.storage : p.watchSize, p.color, p.sim && p.sim !== "—" ? p.sim : null, p.region || null].filter(Boolean);
    const cond = COND_T[p.condition] ? `, ${COND_T[p.condition]}` : "";
    document.title = `Купить ${bits.join(" ")}${cond} в ${cityIn()}` +
      (Number(p.priceCash) > 0 ? ` за ${money(p.priceCash)}` : ", цена по запросу") + " | Apple и точка";
    setMeta("description", `${p.series} ${p.color || ""} ${p.storage !== "—" ? p.storage : ""} ${Number(p.priceCash) > 0 ? ", цена от " + money(p.priceCash) : ", цену уточняйте у менеджера"}. ${p.status === "in_stock" ? "В наличии" : "Под заказ 1–2 дня"}. Trade-In и кредит от банка${(window.warrantyPhrase && window.warrantyPhrase(p)) ? ", " + window.warrantyPhrase(p) : ""}. Магазин «Apple и точка».`.replace(/\s+/g, " ").trim());
  }

  // Плавная смена текста: короткий fade вместо резкой подмены (цена/цвет и т.п.).
  function fadeSet(el, txt) {
    if (!el || el.textContent === txt) return;
    el.style.transition = "opacity .14s ease";
    el.style.opacity = "0";
    setTimeout(() => { el.textContent = txt; el.style.opacity = "1"; }, 140);
  }

  // Выбор параметра: строго ищем SKU с новой комбинацией, иначе ближайший (bestMatch).
  // Читаем текущий выбор из state — обработчики навешиваются один раз, не «протухают».
  function pick(dim, val) {
    if (!state) return;
    const { p, vs, dims } = state;
    const sel = {};
    dims.forEach((d) => (sel[d] = d === dim ? val : p[d]));
    let target = findSKU(vs, sel, dims);
    if (!target) target = bestMatch(vs, dims, p, dim, val); // фиксируем выбранное измерение
    if (!target || target.id === p.id) return;
    applyVariant(target, dim);
  }

  // In-place переключение варианта: без пересборки всей страницы (плавно + без «скачка»
  // прокрутки). Пилюли/свотчи анимируются штатным transition при смене is-active.
  function applyVariant(np, changedDim) {
    if (!state) return;
    const prev = state.p, vs = state.vs, dims = state.dims;
    const colorChanged = np.color !== prev.color;
    state.p = np;
    setUrl(np);
    setHead(np);
    try { injectProductSeo(np); } catch (e) {}

    // Галерея зависит только от ЦВЕТА — перестраиваем лишь при смене цвета (кроссфейд).
    if (colorChanged) {
      const col = $("[data-gallery-col]", root);
      if (col) {
        col.style.transition = "opacity .18s ease";
        col.style.opacity = "0";
        setTimeout(() => {
          const holder = document.createElement("div");
          holder.innerHTML = gallery(np, vs);
          const fresh = holder.firstElementChild;
          col.replaceWith(fresh);
          fresh.style.opacity = "0";
          requestAnimationFrame(() => { fresh.style.transition = "opacity .22s ease"; fresh.style.opacity = "1"; });
          wireGallery();
          if (window.lucideInit) window.lucideInit(root);
        }, 180);
      }
    }
    patchInfo();
  }

  // Обновляем правую колонку под текущий state.p: активные состояния кнопок, цены,
  // статус, подпись, избранное/сравнение. Кнопки НЕ пересоздаём — только правим классы,
  // поэтому CSS-transition даёт плавную анимацию выбора.
  function patchInfo() {
    const { p, vs, dims } = state;
    if (LB.syncBar) LB.syncBar();
    const sub = $("[data-sub]", root);
    if (sub) sub.textContent = [p.storage !== "—" ? p.storage : p.watchSize, p.color].filter(Boolean).join(" · ");
    const stat = $("[data-status]", root);
    if (stat) stat.innerHTML = statusBadge(p.status);
    fadeSet($("[data-cash]", root), priceText(p.priceCash));
    const note = $("[data-price-note]", root);
    if (note) note.classList.toggle("hidden", !p.priceEstimated);
    const cw = $("[data-card-wrap]", root);
    if (cw) {
      const has = Number(p.priceCash) > 0;
      cw.classList.toggle("hidden", !has);
      if (has) fadeSet($("[data-card]", root), money(window.cardPrice(p)));
    }
    $$("[data-color-label]", root).forEach((el) => (el.textContent = p.color));

    $$("[data-pick]", root).forEach((b) => {
      const dim = b.dataset.pick, val = b.dataset.val;
      const isSwatch = b.classList.contains("swatch");
      b.classList.toggle("is-active", p[dim] === val);
      const s = optState(vs, dims, p, dim, val);
      b.classList.toggle(isSwatch ? "opacity-40" : "opacity-45", s === "na");
      if (!isSwatch) {
        let dot = b.querySelector("[data-dot]");
        if (s === "order" && !dot) {
          dot = document.createElement("span");
          dot.setAttribute("data-dot", "");
          dot.className = "w-1.5 h-1.5 rounded-full bg-apple-amber ml-1";
          b.appendChild(dot);
        } else if (s !== "order" && dot) { dot.remove(); }
      } else if (s === "order") {
        b.title = `${val} · под заказ`;
      } else { b.title = val; }
    });

    const favBtn = $("[data-fav]", root);
    if (favBtn) { const f = Store.isFavorite(p.id); favBtn.setAttribute("aria-pressed", f); favBtn.innerHTML = favIcon(f); }
    const cmpBtn = $("[data-cmp]", root);
    if (cmpBtn) { const c = Store.inCompare(p.id); cmpBtn.setAttribute("aria-pressed", c); cmpBtn.innerHTML = cmpIcon(c); }
  }

  // Полноэкранный просмотр фото.
  //
  // Раньше здесь было одно <img> поверх затемнения, а щипок двумя пальцами по
  // фото в карточке воспринимался галереей как свайп: пальцы расходятся по
  // горизонтали больше чем на 40 px — и при отпускании показывалось следующее
  // фото. Человек пытался приблизить середину первого снимка и попадал на второй.
  // Теперь приближение живёт здесь: щипок и двойной тап увеличивают снимок (до
  // ×4) в точке касания, увеличенный снимок двигается пальцем, а листать можно
  // только когда он в обычном масштабе. Кнопка «Назад» на телефоне закрывает
  // просмотр, а не уводит со страницы.
  const LB = { srcs: [], i: 0, s: 1, tx: 0, ty: 0, open: false };
  function lbEnsure() {
    let ov = document.getElementById("lightbox");
    if (ov) return ov;
    ov = document.createElement("div");
    ov.id = "lightbox";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-label", "Просмотр фото");
    ov.className = "fixed inset-0 z-[100] opacity-0 transition-opacity duration-200 hidden select-none";
    ov.style.background = "rgba(0,0,0,.92)";
    const btn = "absolute grid place-items-center w-12 h-12 rounded-full bg-white/15 text-white hover:bg-white/25 active:scale-95 transition outline-none focus-visible:ring-2 focus-visible:ring-white/70";
    const ic = (d) => `<svg viewBox="0 0 24 24" class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
    ov.innerHTML =
      `<div data-lb-stage class="absolute inset-0 overflow-hidden" style="touch-action:none">` +
        `<img data-lb-img alt="" draggable="false" class="absolute left-1/2 top-1/2 max-w-[94vw] max-h-[84vh] object-contain" style="will-change:transform;transform:translate(-50%,-50%)">` +
      `</div>` +
      `<div data-lb-count class="absolute left-4 top-5 text-white/80 text-sm tabular-nums pointer-events-none"></div>` +
      `<button data-lb-close class="${btn} top-3 right-3" aria-label="Закрыть">${ic("M18 6 6 18M6 6l12 12")}</button>` +
      `<button data-lb-prev class="${btn} left-3 top-1/2 -translate-y-1/2" aria-label="Предыдущее фото">${ic("M15 18l-6-6 6-6")}</button>` +
      `<button data-lb-next class="${btn} right-3 top-1/2 -translate-y-1/2" aria-label="Следующее фото">${ic("M9 18l6-6-6-6")}</button>` +
      `<div data-lb-hint class="absolute inset-x-0 bottom-6 text-center text-white/60 text-xs pointer-events-none"></div>`;
    document.body.appendChild(ov);

    const stage = ov.querySelector("[data-lb-stage]");
    const img = ov.querySelector("[data-lb-img]");
    const MAX = 4;
    const apply = (anim) => {
      img.style.transition = anim ? "transform .22s cubic-bezier(.2,.8,.2,1)" : "none";
      img.style.transform = `translate(calc(-50% + ${LB.tx}px), calc(-50% + ${LB.ty}px)) scale(${LB.s})`;
    };
    // Увеличенный снимок не уезжает за край: свободный ход — только лишнее
    // против размера экрана.
    const clamp = () => {
      const r = stage.getBoundingClientRect();
      const mx = Math.max(0, (img.offsetWidth * LB.s - r.width) / 2);
      const my = Math.max(0, (img.offsetHeight * LB.s - r.height) / 2);
      LB.tx = Math.max(-mx, Math.min(mx, LB.tx));
      LB.ty = Math.max(-my, Math.min(my, LB.ty));
    };
    // Точка экрана относительно центра сцены.
    const rel = (x, y) => { const r = stage.getBoundingClientRect(); return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 }; };
    // Масштаб вокруг точки p: то, что было под пальцем, остаётся под ним.
    const zoomAt = (ns, p, anim) => {
      ns = Math.max(1, Math.min(MAX, ns));
      LB.tx = p.x - (p.x - LB.tx) * (ns / LB.s);
      LB.ty = p.y - (p.y - LB.ty) * (ns / LB.s);
      LB.s = ns;
      if (ns === 1) { LB.tx = 0; LB.ty = 0; }
      clamp(); apply(anim);
    };
    LB.reset = (anim) => { LB.s = 1; LB.tx = 0; LB.ty = 0; ov.style.background = "rgba(0,0,0,.92)"; apply(anim); };

    const pts = new Map();
    let g = null;         // текущий жест
    let lastTap = null;   // для двойного тапа
    let tapTimer = 0;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const startDrag = (p) => ({ kind: "drag", x: p.x, y: p.y, tx: LB.tx, ty: LB.ty, moved: false, pinched: g ? g.pinched : false, axis: null });

    stage.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { g = startDrag({ x: e.clientX, y: e.clientY }); g.pinched = false; }
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        g = { kind: "pinch", d: dist(a, b) || 1, m: rel(mid(a, b).x, mid(a, b).y), s: LB.s, tx: LB.tx, ty: LB.ty, pinched: true };
      }
    });
    stage.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId) || !g) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g.kind === "pinch" && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const m = rel(mid(a, b).x, mid(a, b).y);
        const ns = Math.max(1, Math.min(MAX, g.s * dist(a, b) / g.d));
        // точка под серединой пальцев в начале щипка остаётся под ней
        LB.s = ns;
        LB.tx = m.x - (g.m.x - g.tx) * (ns / g.s);
        LB.ty = m.y - (g.m.y - g.ty) * (ns / g.s);
        apply(false);
        return;
      }
      if (g.kind !== "drag") return;
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (!g.moved && Math.hypot(dx, dy) > 8) g.moved = true;
      if (!g.moved) return;
      if (LB.s > 1) { LB.tx = g.tx + dx; LB.ty = g.ty + dy; clamp(); apply(false); return; }
      if (g.pinched) return;
      // обычный масштаб: по горизонтали — листание, вниз — закрыть
      if (!g.axis) g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (g.axis === "x") { LB.tx = dx; LB.ty = 0; }
      else { LB.tx = 0; LB.ty = Math.max(0, dy); ov.style.background = `rgba(0,0,0,${Math.max(0.35, 0.92 - LB.ty / 600)})`; }
      apply(false);
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      const p0 = pts.get(e.pointerId);
      pts.delete(e.pointerId);
      if (!g) return;
      if (g.kind === "pinch") {
        if (pts.size === 1) { const [r] = [...pts.values()]; g = startDrag(r); g.pinched = true; g.moved = true; }
        else if (pts.size === 0) { g = null; if (LB.s < 1.05) LB.reset(true); else { clamp(); apply(true); } }
        return;
      }
      if (pts.size > 0) return;
      const G = g; g = null;
      if (e.type === "pointercancel") { if (LB.s === 1) LB.reset(true); return; }
      if (G.pinched) { if (LB.s < 1.05) LB.reset(true); else { clamp(); apply(true); } return; }
      if (G.moved) {
        if (LB.s > 1) return;
        if (G.axis === "x" && Math.abs(LB.tx) > 60 && LB.srcs.length > 1) { LB.go(LB.tx < 0 ? 1 : -1, LB.tx); return; }
        if (G.axis === "y" && LB.ty > 110) { lbClose(); return; }
        LB.reset(true);
        return;
      }
      // тап: двойной — приблизить/вернуть, одиночный по фону — закрыть
      const now = Date.now();
      if (lastTap && now - lastTap.t < 300 && Math.hypot(p0.x - lastTap.x, p0.y - lastTap.y) < 30) {
        clearTimeout(tapTimer); lastTap = null;
        if (LB.s > 1) LB.reset(true); else zoomAt(2.5, rel(p0.x, p0.y), true);
        return;
      }
      lastTap = { t: now, x: p0.x, y: p0.y };
      const onImg = e.target === img;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { lastTap = null; if (!onImg && LB.s === 1) lbClose(); }, 300);
    };
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
    // Колесо мыши на компьютере — приближение к курсору.
    stage.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(LB.s * Math.exp(-e.deltaY * 0.002), rel(e.clientX, e.clientY), false); }, { passive: false });

    LB.go = (dir, from) => {
      const n = LB.srcs.length;
      if (n < 2) return LB.reset(true);
      const next = (LB.i + dir + n) % n;
      // короткий уезд старого кадра в сторону свайпа, новый въезжает с другой
      const w = stage.getBoundingClientRect().width;
      LB.s = 1; LB.ty = 0; LB.tx = dir > 0 ? -w : w; apply(true);
      setTimeout(() => { LB.show(next); LB.tx = dir > 0 ? w * 0.35 : -w * 0.35; apply(false); requestAnimationFrame(() => { LB.tx = 0; apply(true); }); }, from == null ? 0 : 160);
    };
    LB.show = (i) => {
      LB.i = i; LB.s = 1; LB.tx = 0; LB.ty = 0; apply(false);
      img.src = LB.srcs[i]; img.alt = LB.alt || "";
      const n = LB.srcs.length;
      ov.querySelector("[data-lb-count]").textContent = n > 1 ? `${i + 1} / ${n}` : "";
      ov.querySelectorAll("[data-lb-prev],[data-lb-next]").forEach((b) => b.classList.toggle("hidden", n < 2));
      [i + 1, i - 1].forEach((k) => { const s = LB.srcs[(k + n) % n]; if (s) { const im = new Image(); im.src = s; } });
    };
    ov.querySelector("[data-lb-close]").addEventListener("click", () => lbClose());
    ov.querySelector("[data-lb-prev]").addEventListener("click", () => LB.go(-1));
    ov.querySelector("[data-lb-next]").addEventListener("click", () => LB.go(1));
    document.addEventListener("keydown", (e) => {
      if (!LB.open) return;
      if (e.key === "Escape") lbClose();
      else if (e.key === "ArrowRight") LB.go(1);
      else if (e.key === "ArrowLeft") LB.go(-1);
    });
    // «Назад» на телефоне закрывает просмотр.
    window.addEventListener("popstate", () => { if (LB.open) lbClose(true); });
    return ov;
  }
  function lbClose(fromHistory) {
    const ov = document.getElementById("lightbox");
    if (!ov || !LB.open) return;
    LB.open = false;
    ov.classList.add("opacity-0");
    document.body.style.overflow = "";
    setTimeout(() => { ov.classList.add("hidden"); LB.reset && LB.reset(false); }, 200);
    if (!fromHistory && history.state && history.state.lb) history.back();
  }
  function openLightbox(srcs, start, alt) {
    srcs = (srcs || []).filter(Boolean);
    if (!srcs.length) return;
    const ov = lbEnsure();
    LB.srcs = srcs; LB.alt = alt; LB.open = true;
    LB.show(Math.max(0, Math.min(srcs.length - 1, start || 0)));
    const hint = ov.querySelector("[data-lb-hint]");
    hint.textContent = (window.matchMedia && matchMedia("(pointer: coarse)").matches)
      ? "Двойной тап или два пальца: приблизить" : "Колесо мыши: приблизить, стрелки: листать";
    // подсказка видна пару секунд и при первом касании прячется
    hint.style.transition = "opacity .4s"; hint.style.opacity = "1";
    clearTimeout(LB.hintT); LB.hintT = setTimeout(() => { hint.style.opacity = "0"; }, 2500);
    ov.querySelector("[data-lb-stage]").addEventListener("pointerdown", () => { hint.style.opacity = "0"; }, { once: true });
    ov.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    try { if (!(history.state && history.state.lb)) history.pushState(Object.assign({}, history.state, { lb: 1 }), ""); } catch (_) {}
    requestAnimationFrame(() => ov.classList.remove("opacity-0"));
    ov.querySelector("[data-lb-close]").focus({ preventScroll: true });
  }

  // Навешивание галереи (скраб/свайп/тумбы/лайтбокс). Отдельно — чтобы перевесить
  // после кроссфейд-перестройки при смене цвета. Читает текущий товар из state.
  function wireGallery() {
    const media = $("[data-media]", root);
    if (!media) return;
    const frames = $$("[data-frame]", media);
    const thumbs = $$("[data-thumb]", root);
    media.style.cursor = "zoom-in";
    let cur = 0;
    const srcOf = (f) => { const img = f && f.querySelector("img"); return img && (img.getAttribute("data-full") || img.getAttribute("src")); };
    const openCurrent = () => openLightbox(frames.map(srcOf), cur, state.p.series);
    const show = (i) => {
      cur = i;
      frames.forEach((f, k) => (f.style.opacity = k === i ? "1" : "0"));
      // ленивая догрузка полноразмерного фото только для открываемого кадра
      const img = frames[i] && frames[i].querySelector("img[data-full]");
      if (img && !img.getAttribute("src")) img.src = img.getAttribute("data-full");
      thumbs.forEach((t, k) => { t.classList.toggle("ring-brand", k === i); t.classList.toggle("ring-transparent", k !== i); });
    };
    // Щипок двумя пальцами — это не свайп: браузеру отдаём родное приближение
    // страницы, а галерея считает жест свайпом, только если палец был один.
    media.style.touchAction = "pan-y pinch-zoom";
    const touches = new Set();
    let multi = false;
    if (frames.length > 1) {
      const n = frames.length;
      // Компьютер: фото меняют стрелки, миниатюры и клавиши ← →. Раньше фото
      // менялось от движения мыши (каждому снимку своя полоса по ширине), и,
      // пока курсор шёл к середине, чтобы нажать, кадр успевал смениться на
      // второй. На карточке товара, где фото хотят рассмотреть, это мешало.
      // Телефон: свайп одним пальцем влево/вправо, вертикальный прокручивает страницу.
      let sx = 0, sy = 0, swiping = false;
      const step = (d) => show((cur + d + n) % n);
      $("[data-gal-prev]", media)?.addEventListener("click", (e) => { e.stopPropagation(); step(-1); });
      $("[data-gal-next]", media)?.addEventListener("click", (e) => { e.stopPropagation(); step(1); });
      media.tabIndex = 0;
      media.setAttribute("aria-label", "Фото товара. Enter открывает, стрелки листают");
      media.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCurrent(); }
      });
      media.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse") return;
        touches.add(e.pointerId);
        if (touches.size > 1) { multi = true; swiping = false; return; }
        swiping = true; sx = e.clientX; sy = e.clientY;
      });
      media.addEventListener("pointerup", (e) => {
        if (e.pointerType === "mouse") return;
        touches.delete(e.pointerId);
        if (multi) { media._noClick = Date.now(); if (!touches.size) multi = false; return; }
        if (!swiping) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          show(Math.max(0, Math.min(n - 1, cur + (dx < 0 ? 1 : -1))));
          media._noClick = Date.now(); // свайп не должен открывать лайтбокс
        }
        swiping = false;
      });
      media.addEventListener("pointercancel", (e) => { touches.delete(e.pointerId); if (!touches.size) multi = false; swiping = false; });
      thumbs.forEach((t) => t.addEventListener("click", () => show(+t.dataset.thumb)));
    }
    // Клик/тап по фото → полноэкранный просмотр с текущего кадра
    // Клик сразу после свайпа или щипка гасим, но только в эти 250 мс:
    // браузер после свайпа клика обычно не присылает, и флаг без срока
    // съедал следующий настоящий тап — фото «не открывалось с первого раза».
    media.addEventListener("click", () => {
      const t = media._noClick; media._noClick = 0;
      if (t && Date.now() - t < 250) return;
      openCurrent();
    });
  }

  // Нижняя панель «цена + Оформить» на телефоне. Кнопка заявки стоит в середине
  // карточки, и после прокрутки к характеристикам за ней приходится тянуться
  // вверх. Панель появляется у нижнего края, в зоне большого пальца, только
  // когда основная кнопка ушла с экрана, и прячется, как только та видна снова.
  function wireBuyBar() {
    const main = $("[data-buy]", root);
    let bar = document.getElementById("buybar");
    if (!main) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "buybar";
      bar.className = "buybar lg:hidden";
      bar.innerHTML =
        `<div class="min-w-0"><div class="text-xs text-ink-mute truncate" data-bb-name></div>` +
        `<div class="font-semibold tabular-nums" data-bb-price></div></div>` +
        `<button type="button" class="btn-primary shrink-0" data-bb-buy>Оформить заявку</button>`;
      document.body.appendChild(bar);
      bar.querySelector("[data-bb-buy]").addEventListener("click", () => openLeadModal(state.p.id));
    }
    const sync = () => {
      const p = state.p;
      bar.querySelector("[data-bb-name]").textContent = [p.series, p.storage !== "—" ? p.storage : p.watchSize, p.color].filter(Boolean).join(" · ");
      bar.querySelector("[data-bb-price]").textContent = Number(p.priceCash) > 0 ? money(p.priceCash) : "Цена по запросу";
    };
    sync();
    LB.syncBar = sync;
    // Проверяем по прокрутке, а не IntersectionObserver: при быстром
    // пролистывании кнопка проскакивает экран за один кадр, наблюдатель не
    // видит смены «видна/не видна», и панель не появлялась.
    let raf = 0;
    const check = () => {
      raf = 0;
      const btn = $("[data-buy]", root);
      const gone = !!btn && btn.getBoundingClientRect().bottom < 0;
      bar.classList.toggle("is-on", gone);
      document.body.classList.toggle("has-buybar", gone);
    };
    if (!wireBuyBar.bound) {
      wireBuyBar.bound = true;
      const onScroll = () => { if (!raf) raf = requestAnimationFrame(check); };
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll, { passive: true });
    }
    check();
  }

  function wire(p, vs, dims) {
    wireGallery();

    // Матрица: любой параметр. Обработчик читает текущий выбор из state (навешивается
    // один раз), поэтому при in-place обновлении кнопки не нужно перевешивать.
    $$("[data-pick]", root).forEach((b) =>
      b.addEventListener("click", () => pick(b.dataset.pick, b.dataset.val))
    );

    const specToggle = $("[data-specs-toggle]", root);
    if (specToggle) specToggle.addEventListener("click", () => {
      const extra = $$(".spec-extra", root);
      const willShow = extra.length && extra[0].classList.contains("hidden");
      extra.forEach((tr) => tr.classList.toggle("hidden"));
      specToggle.textContent = willShow ? "Свернуть характеристики" : `Показать все характеристики (${specToggle.dataset.total})`;
    });

    // Избранное/сравнение — по ТЕКУЩЕМУ варианту (state.p.id), обновляем кнопку на месте.
    $("[data-fav]", root)?.addEventListener("click", (e) => {
      const id = state.p.id, on = Store.toggleFavorite(id);
      const btn = e.currentTarget; btn.setAttribute("aria-pressed", on); btn.innerHTML = favIcon(on);
    });
    $("[data-cmp]", root)?.addEventListener("click", (e) => {
      const id = state.p.id, on = Store.toggleCompare(id);
      const btn = e.currentTarget; btn.setAttribute("aria-pressed", on); btn.innerHTML = cmpIcon(on);
    });
    $("[data-buy]", root)?.addEventListener("click", () => openLeadModal(state.p.id));
    wireBuyBar();
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
    // Нормализуем адрес: на боевом (http/https) — чистый /p/<id>/ (совпадает с canonical
    // и пререндер-страницей); при file:// оставляем ?id=. Так стираем дубль product.html?id=.
    try {
      if (location.protocol !== "file:") {
        const clean = `/p/${encodeURIComponent(p.id)}/`;
        if (location.pathname !== clean) history.replaceState(null, "", clean);
      } else if (p.id !== id) {
        const u = new URL(location.href); u.searchParams.set("id", p.id); history.replaceState(null, "", u);
      }
    } catch (e) {}
    const vs = seriesVariants(p.name);
    const dims = dimsOf(vs);
    state = { p, vs, dims };
    setHead(p);
    root.innerHTML = view(p, vs, dims);
    wire(p, vs, dims);
    injectProductSeo(p);
    if (window.lucideInit) window.lucideInit(root);
  }

  // Мягкое обновление после свежих данных из KV: если набор вариантов и фото
  // текущей модели те же — меняем только цену/статус (patchInfo). Полная
  // перерисовка пересоздаёт галерею, и фото на пару секунд пропадают.
  function refresh() {
    if (!state || !state.p) return render();
    const np = ALL.find((x) => x.id === state.p.id);
    if (!np) return render();
    const vs = seriesVariants(np.name);
    const ids = (arr) => arr.map((x) => x.id + "|" + (x.images || []).join(",")).join(";");
    if (ids(vs) !== ids(state.vs)) return render();
    state = { p: np, vs, dims: dimsOf(vs) };
    patchInfo();
    try { injectProductSeo(np); } catch (e) {}
  }

  function setMeta(name, content) {
    let m = document.querySelector(`meta[name="${name}"]`);
    if (!m) { m = document.createElement("meta"); m.setAttribute("name", name); document.head.appendChild(m); }
    m.setAttribute("content", content);
  }
  const statusText = (s) => (s === "in_stock" ? "В наличии" : "Под заказ 1–2 дня");

  // Schema.org: Product + Offer + BreadcrumbList — та же разметка, что при сборке.
  // На пререндер-странице своего товара не добавляем ничего: второй блок
  // Product рядом с серверным — это два разных товара для поисковика.
  // При переключении комплектации серверные блоки убираются и ставятся новые.
  const slugRu = (s) => {
    const map = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
    return String(s).toLowerCase().replace(/[а-яё]/g, (c) => map[c] ?? "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  };
  function injectProductSeo(p) {
    if (isPrerendered(p)) return;
    const html = document.documentElement;
    if (html.hasAttribute("data-pid")) {
      document.querySelectorAll('script[type="application/ld+json"]:not([id])').forEach((s) => s.remove());
      document.querySelectorAll('meta[name="robots"]').forEach((m) => m.remove());
      html.removeAttribute("data-pid");
    }
    const C = window.CONFIG || {};
    const base = (C.siteUrl || location.origin || "").replace(/\/$/, "");
    const purl = `${base}/p/${encodeURIComponent(p.id)}/`;
    if (window.setCanonical) window.setCanonical(purl);
    const img = (Array.isArray(p.images) && p.images[0]) ? (base + "/" + String(p.images[0]).replace(/^\//, "")) : (base + "/apple-touch-icon.png");
    const used = p.condition === "used" || p.condition === "demo";
    const product = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: `${p.series}${p.storage && p.storage !== "—" ? " " + p.storage : ""}${p.color ? " " + p.color : ""}`,
      image: [img],
      description: (p.specs && p.specs["Тип"]) ? `${p.series}, ${p.specs["Тип"]}` : p.series,
      brand: { "@type": "Brand", name: p.brand || "Apple" },
      category: p.category,
      sku: p.id,
      // без цены Offer не отдаём: price 0 поисковик читает как «бесплатно»
      ...(Number(p.priceCash) > 0 ? { offers: {
        "@type": "Offer",
        url: purl,
        priceCurrency: "RUB",
        price: p.priceCash,
        availability: p.status === "in_stock" ? "https://schema.org/InStock" : "https://schema.org/PreOrder",
        itemCondition: used ? "https://schema.org/UsedCondition" : "https://schema.org/NewCondition",
        seller: { "@type": "Organization", name: C.brand || "Apple и точка" },
      } } : {}),
    };
    const cat = window.catOf ? window.catOf(p) : (used ? "Б/у" : p.category);
    const crumbs = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Главная", item: base + "/" },
        { "@type": "ListItem", position: 2, name: cat, item: `${base}/catalog/${slugRu(cat)}/` },
        { "@type": "ListItem", position: 3, name: p.series, item: `${base}/catalog/${slugRu(cat)}/${slugRu(p.series)}/` },
        { "@type": "ListItem", position: 4, name: [p.storage !== "—" ? p.storage : p.watchSize, p.color].filter(Boolean).join(" "), item: purl },
      ],
    };
    if (window.setJsonLd) { window.setJsonLd("ld-product", product); window.setJsonLd("ld-breadcrumb", crumbs); }
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
            d.products = visibleOnly(d.products);
            try { sessionStorage.setItem("catalog:v1", JSON.stringify(d)); } catch (e) {}
            const sig = JSON.stringify(d.products);
            if (sig !== RAW_SIG) { RAW_SIG = sig; ALL = normAll(d.products); return true; }
          }
        }
      }
    } catch (e) { /* оставляем встроенный каталог */ }
    return false;
  }

  document.addEventListener("DOMContentLoaded", () => {
    const cached = readCache();               // самый свежий каталог этой вкладки
    if (cached) { const vis = visibleOnly(cached.products); RAW_SIG = JSON.stringify(vis); ALL = normAll(vis); }
    render();                                 // мгновенно (кэш или встроенный)
    loadFromKV().then((changed) => { if (changed) refresh(); }); // фоновое обновление из KV
  });
})();
