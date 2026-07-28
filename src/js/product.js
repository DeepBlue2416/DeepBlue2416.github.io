// product.js — Страница товара (product.html?id=…)
// Использует глобальные помощники из app.js: deviceGlyph, productFrames,
// statusBadge, openLeadModal, openTradeInModal, Store, CONFIG.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const CAT = window.__CATALOG__ || { products: [] };
  const ALL = CAT.products || [];
  const CUR = (CAT.meta && CAT.meta.currency) || (window.CONFIG && CONFIG.currency) || "₽";
  const root = document.getElementById("product-root");

  const money = (n) => new Intl.NumberFormat("ru-RU").format(n) + " " + CUR;
  const getId = () => new URLSearchParams(location.search).get("id");
  const uniqBy = (arr, key) => {
    const seen = new Set(), out = [];
    for (const x of arr) { const k = key(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
    return out;
  };

  function findVariant(name, color, storage) {
    const vs = ALL.filter((x) => x.name === name);
    return (
      vs.find((x) => x.color === color && x.storage === storage) ||
      vs.find((x) => x.color === color) ||
      vs.find((x) => x.storage === storage) ||
      vs[0]
    );
  }

  function notFound() {
    return `<div class="py-24 text-center">
      <div class="text-2xl font-semibold">Товар не найден</div>
      <p class="text-ink-mute mt-2">Возможно, ссылка устарела.</p>
      <a href="index.html#catalog" class="btn-primary px-6 py-3 mt-6 inline-flex">Вернуться в каталог</a>
    </div>`;
  }

  function gallery(p) {
    const frames = productFrames(p, 220);
    const thumbsF = productFrames(p, 44);
    return `
      <div class="lg:sticky lg:top-20">
        <div class="card-media relative block aspect-square rounded-3xl overflow-hidden bg-cloud shadow-card" data-media>
          <div class="relative h-full">
            ${frames
              .map(
                (f, i) =>
                  `<div class="absolute inset-0 grid place-items-center transition-opacity duration-150 ${i === 0 ? "opacity-100" : "opacity-0"}" data-frame="${i}">${f}</div>`
              )
              .join("")}
          </div>
          <span class="absolute left-4 top-4 chip bg-white/80 text-ink-mute text-xs">Наведите, чтобы рассмотреть</span>
        </div>
        <div class="mt-3 flex justify-center gap-2">
          ${thumbsF
            .map(
              (f, i) =>
                `<button class="thumb w-16 h-16 rounded-2xl bg-cloud grid place-items-center overflow-hidden ring-2 ${i === 0 ? "ring-brand" : "ring-transparent"} transition" data-thumb="${i}">${f}</button>`
            )
            .join("")}
        </div>
      </div>`;
  }

  function colorRow(p, variants) {
    const cols = uniqBy(variants.filter((v) => v.colorHex), (v) => v.colorHex);
    if (cols.length < 2) return `<div class="mt-1 text-sm text-ink-mute">Цвет: ${p.color}</div>`;
    return `
      <div class="mt-5">
        <div class="text-sm text-ink-soft mb-2">Цвет: <b>${p.color}</b></div>
        <div class="flex flex-wrap gap-2">
          ${cols
            .map(
              (v) =>
                `<button class="swatch w-8 h-8 ${v.colorHex === p.colorHex ? "is-active" : ""}" data-color="${escAttr(v.color)}" title="${escAttr(v.color)}" aria-label="${escAttr(v.color)}" style="--sw:${v.colorHex}"></button>`
            )
            .join("")}
        </div>
      </div>`;
  }

  function storageRow(p, variants) {
    const sameColor = variants.filter((v) => v.color === p.color);
    const stors = uniqBy(sameColor.filter((v) => v.storage && v.storage !== "—"), (v) => v.storage);
    if (stors.length < 2) return "";
    return `
      <div class="mt-5">
        <div class="text-sm text-ink-soft mb-2">Память</div>
        <div class="flex flex-wrap gap-2">
          ${stors
            .map(
              (v) =>
                `<button class="btn-pill ${v.storage === p.storage ? "is-active" : ""}" data-storage="${escAttr(v.storage)}">${v.storage}</button>`
            )
            .join("")}
        </div>
      </div>`;
  }

  function specsTable(p) {
    const base = [
      ["Категория", p.category],
      ["Поколение", p.generation || "—"],
      ["Память", p.storage || "—"],
      ["Цвет", p.color || "—"],
      ["SIM", p.sim || "—"],
    ];
    const extra = p.specs ? Object.entries(p.specs) : [];
    const rows = base.concat(extra);
    return `
      <div class="mt-12">
        <h2 class="text-xl font-semibold tracking-tight mb-4">Характеристики</h2>
        <div class="rounded-3xl bg-cloud-card shadow-card overflow-hidden">
          <table class="w-full text-sm">
            <tbody>
              ${rows
                .map(
                  ([k, v], i) =>
                    `<tr class="${i ? "border-t border-black/[0.06]" : ""}">
                       <td class="p-4 text-ink-mute w-1/2 sm:w-1/3">${k}</td>
                       <td class="p-4 text-ink-soft font-medium">${v}</td>
                     </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function escAttr(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  function view(p, variants) {
    const fav = Store.isFavorite(p.id);
    const cmp = Store.inCompare(p.id);
    return `
      <nav class="text-sm text-ink-mute mb-6 flex items-center gap-1.5 flex-wrap">
        <a href="index.html" class="hover:text-ink">Главная</a><span>/</span>
        <a href="index.html#catalog" class="hover:text-ink">Каталог</a><span>/</span>
        <span class="text-ink">${p.name}</span>
      </nav>

      <div class="grid lg:grid-cols-2 gap-8 lg:gap-12">
        ${gallery(p)}

        <div>
          <div class="flex items-start justify-between gap-4">
            <div>
              <h1 class="text-3xl sm:text-4xl font-semibold tracking-tight">${p.name}</h1>
              <p class="text-ink-mute mt-1" data-sub>${[p.storage, p.color].filter((x) => x && x !== "—").join(" · ")}</p>
            </div>
            <div class="flex gap-2 shrink-0">
              <button class="grid place-items-center w-10 h-10 rounded-full bg-black/5 hover:bg-black/10 transition" data-fav title="В избранное" aria-pressed="${fav}">${favIcon(fav)}</button>
              <button class="grid place-items-center w-10 h-10 rounded-full bg-black/5 hover:bg-black/10 transition" data-cmp title="К сравнению" aria-pressed="${cmp}">${cmpIcon(cmp)}</button>
            </div>
          </div>

          <div class="mt-4">${statusBadge(p.status)}</div>

          ${colorRow(p, variants)}
          ${storageRow(p, variants)}

          <div class="mt-6 rounded-3xl bg-cloud-card shadow-card p-5">
            <div class="flex items-end justify-between gap-4 flex-wrap">
              <div>
                <div class="text-xs text-ink-mute">Наличными</div>
                <div class="text-3xl font-semibold tracking-tight" data-cash>${money(p.priceCash)}</div>
              </div>
              <div class="text-right">
                <div class="text-xs text-ink-mute">Картой / в кредит</div>
                <div class="text-lg font-medium text-ink-soft" data-card>${money(p.priceCard)}</div>
              </div>
            </div>
            <button class="btn-primary w-full mt-5" data-buy>Оформить заявку</button>
            <div class="grid grid-cols-3 gap-2 mt-3">
              <a data-tg href="#" target="_blank" rel="noopener" class="btn-soft text-sm justify-center">Telegram</a>
              <a data-wa href="#" target="_blank" rel="noopener" class="btn-soft text-sm justify-center">WhatsApp</a>
              <a data-phone href="#" class="btn-soft text-sm justify-center">Позвонить</a>
            </div>
          </div>

          <div class="mt-5 flex items-center gap-3 text-sm text-ink-mute">
            <button class="btn-ghost" data-tradein>Оценить свой по Trade-In →</button>
          </div>

          <ul class="mt-6 space-y-2 text-sm text-ink-soft">
            <li class="flex gap-2"><span class="text-brand">✓</span> Оригинальная техника, гарантия магазина</li>
            <li class="flex gap-2"><span class="text-brand">✓</span> Доставка по городу и самовывоз</li>
            <li class="flex gap-2"><span class="text-brand">✓</span> Trade-In и рассрочка</li>
          </ul>
        </div>
      </div>

      ${specsTable(p)}`;
  }

  function favIcon(a) {
    return a
      ? `<svg viewBox="0 0 24 24" class="w-5 h-5 text-apple-red" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round">${window.ICONS.heart}</svg>`
      : lucideSVG("heart", "w-5 h-5 text-ink-mute");
  }
  function cmpIcon(a) {
    return lucideSVG("git-compare", "w-5 h-5 " + (a ? "text-brand" : "text-ink-mute"));
  }

  function goVariant(v) {
    if (!v) return;
    const u = new URL(location.href);
    u.searchParams.set("id", v.id);
    history.replaceState(null, "", u);
    render();
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  function wire(p, variants) {
    // Скраббер + миниатюры
    const media = $("[data-media]", root);
    const frames = $$("[data-frame]", media);
    const thumbs = $$("[data-thumb]", root);
    const show = (i) => {
      frames.forEach((f, k) => (f.style.opacity = k === i ? "1" : "0"));
      thumbs.forEach((t, k) => {
        t.classList.toggle("ring-brand", k === i);
        t.classList.toggle("ring-transparent", k !== i);
      });
    };
    if (frames.length > 1) {
      media.style.touchAction = "pan-y";
      const at = (x) => {
        const r = media.getBoundingClientRect();
        return Math.max(0, Math.min(frames.length - 1, Math.floor(((x - r.left) / r.width) * frames.length)));
      };
      let active = false;
      media.addEventListener("pointerdown", (e) => { active = true; show(at(e.clientX)); });
      media.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || active) show(at(e.clientX)); });
      media.addEventListener("pointerup", () => { active = false; });
      media.addEventListener("pointerleave", () => { active = false; show(0); });
      media.addEventListener("pointercancel", () => { active = false; show(0); });
      thumbs.forEach((t) => t.addEventListener("click", () => show(+t.dataset.thumb)));
    }

    // Выбор цвета / памяти
    $$("[data-color]", root).forEach((b) =>
      b.addEventListener("click", () => goVariant(findVariant(p.name, b.dataset.color, p.storage)))
    );
    $$("[data-storage]", root).forEach((b) =>
      b.addEventListener("click", () => goVariant(findVariant(p.name, p.color, b.dataset.storage)))
    );

    // Избранное / сравнение
    $("[data-fav]", root)?.addEventListener("click", () => { Store.toggleFavorite(p.id); render(); });
    $("[data-cmp]", root)?.addEventListener("click", () => { Store.toggleCompare(p.id); render(); });

    // Заявка / Trade-In
    $("[data-buy]", root)?.addEventListener("click", () => openLeadModal(p.id));
    $("[data-tradein]", root)?.addEventListener("click", () => openTradeInModal());

    // Контакты (ссылки) — берём из CONFIG
    if (window.CONFIG) {
      $$("[data-tg]", root).forEach((el) => (el.href = CONFIG.contacts.telegram));
      $$("[data-wa]", root).forEach((el) => (el.href = CONFIG.contacts.whatsapp));
      $$("[data-phone]", root).forEach((el) => (el.href = `tel:${CONFIG.contacts.phoneHref}`));
    }
  }

  function render() {
    const id = getId();
    const p = ALL.find((x) => x.id === id);
    if (!p) { root.innerHTML = notFound(); return; }
    const variants = ALL.filter((x) => x.name === p.name);
    document.title = `${p.name} — Apple и точка`;
    root.innerHTML = view(p, variants);
    wire(p, variants);
  }

  document.addEventListener("DOMContentLoaded", render);
})();
