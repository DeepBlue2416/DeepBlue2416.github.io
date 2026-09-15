// worker/tg-price-sync.js — сопоставление прайса из Telegram с каталогом.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ: один и тот же код должен работать и в воркере (cron),
// и в Node (тесты, ручные прогоны). Поэтому здесь НЕТ ничего специфичного для
// Workers — ни KV, ни fetch, ни HTMLRewriter. Чистые функции над данными.
//
// ГЛАВНЫЙ ПРИНЦИП: этот слой НЕ применяет цены сам. Он готовит ПРЕДЛОЖЕНИЯ
// (proposals) с указанием, что и почему меняется, и прогоняет их через жёсткие
// проверки. Автоприменение выключено по умолчанию — см. комментарий к
// buildProposals(). Причина простая: прайс приходит из скрейпинга HTML-страницы,
// и одна ошибка разбора («112 000» → 112) опубликует iPhone за 11 200 ₽ на живой
// витрине. Цена товара — не то место, где уместен молчаливый автопилот.

// ---------------------------------------------------------------------------
// 1. Наценка: зависит от бренда (правила разные, это не единая формула)
// ---------------------------------------------------------------------------
// Правило единое для всех брендов: закупка + наценка, затем округление до
// БЛИЖАЙШЕЙ X990, при ничьей — вверх. Наценка отличается только размером:
// Apple +5000, Samsung +4500.
//
// Про «при ничьей вверх»: Math.round для положительных чисел округляет .5 вверх,
// так что это выполняется само. Но на практике ничья невозможна: цены поставщика
// всегда кратны 100 (проверено на прайсе @OPTMSK77 — 96 из 96 позиций), наценки
// тоже кратны 100, поэтому S = закупка + наценка кратно 100. Ничья до ближайшей
// X990 требует остатка S mod 1000 = 490, а 490 не кратно 100. Итог: остаток
// 0…400 — вниз, 500…900 — вверх, промежуточных случаев не существует.
//
// Учтите: фактическая наценка из-за округления гуляет. При кратности 100 она
// лежит в диапазоне (наценка − 410) … (наценка + 490) — то есть для Apple
// 4590…5490 ₽, для Samsung 4090…4990 ₽. Если нужна гарантия «не ниже
// номинала», замените roundTo990 на ceilTo990 (см. ниже).
const MARKUP_BY_BRAND = { Apple: 5000, Samsung: 4500 };

// Цена по карте = наличные + 15%. Держится в одном месте: значение дублируется
// в samsung-s26-ultra.cjs и в переменной CARD_RATIO у воркера, и расхождение
// между ними даёт разные цены в каталоге и в применённых предложениях.
const CARD_RATIO = 1.15;
const DEFAULT_MARKUP = 5000;

// Ближайшая X990, при ничьей вверх.
const roundTo990 = (v) => Math.round(v / 1000) * 1000 - 10;
// Вариант «всегда вверх»: наценка никогда не опускается ниже номинала.
// Не используется по умолчанию — переключение меняет уже выставленные цены.
const ceilTo990 = (v) => Math.ceil((v - 990) / 1000) * 1000 + 990;

const MARKUP = {
  Apple: (supplier) => roundTo990(supplier + MARKUP_BY_BRAND.Apple),
  Samsung: (supplier) => roundTo990(supplier + MARKUP_BY_BRAND.Samsung),
};
function retailFrom(supplier, brand) {
  const f = MARKUP[brand];
  if (f) return f(supplier);
  return roundTo990(supplier + DEFAULT_MARKUP);
}

// ---------------------------------------------------------------------------
// 2. Цвета: EN из прайса → RU в каталоге, ПО СЕМЕЙСТВАМ
// ---------------------------------------------------------------------------
// Ключевая причина, почему нельзя обойтись одной таблицей: «Black» — это
// «Чёрный титан» для 16 Pro, но просто «Чёрный» для 17-й серии. Таблица
// построена по фактическим значениям p.color из каталога (219 SKU).
const COLOR_BY_SERIES = {
  "iPhone 16 Pro": { black: "Чёрный титан", "black titanium": "Чёрный титан", white: "Белый титан", "white titanium": "Белый титан", natural: "Натуральный титан", "natural titanium": "Натуральный титан", desert: "Пустынный титан", "desert titanium": "Пустынный титан" },
  "iPhone 16 Pro Max": { black: "Чёрный титан", "black titanium": "Чёрный титан", white: "Белый титан", "white titanium": "Белый титан", natural: "Натуральный титан", "natural titanium": "Натуральный титан", desert: "Пустынный титан", "desert titanium": "Пустынный титан" },
  "iPhone Air": { black: "Чёрный", blue: "Небесно-голубой", "sky blue": "Небесно-голубой", white: "Облачный белый", "cloud white": "Облачный белый", gold: "Золотой" },
  "iPhone 17 Pro": { blue: "Синий", "deep blue": "Синий", orange: "Космический оранжевый", "cosmic orange": "Космический оранжевый", silver: "Серебристый" },
  "iPhone 17 Pro Max": { blue: "Синий", "deep blue": "Синий", orange: "Космический оранжевый", "cosmic orange": "Космический оранжевый", silver: "Серебристый" },
  "iPhone 17": { black: "Чёрный", white: "Белый", blue: "Голубой", sage: "Шалфейный", lavender: "Лавандовый" },
  "iPhone 17e": { black: "Чёрный", white: "Белый", pink: "Розовый", "soft pink": "Розовый" },
  "iPhone 16": { black: "Чёрный", white: "Белый", pink: "Розовый", teal: "Бирюзовый", ultramarine: "Ультрамарин" },
  "iPhone 16 Plus": { black: "Чёрный", pink: "Розовый", teal: "Бирюзовый", ultramarine: "Ультрамарин" },
  "iPhone 16e": { black: "Чёрный", white: "Белый" },
  // Samsung: в каталоге цвета уже по-английски, маппинг почти тождественный.
  "Galaxy S26 Ultra": { black: "Black", white: "White", cobalt: "Cobalt Violet", "cobalt violet": "Cobalt Violet", violet: "Violet", gray: "Gray", grey: "Gray", gold: "Gold" },
};

function mapColor(series, colorEN) {
  if (!colorEN) return null;
  const table = COLOR_BY_SERIES[series];
  if (!table) return null;
  return table[String(colorEN).toLowerCase().trim()] || null;
}

// ---------------------------------------------------------------------------
// 3. Модель из прайса → series в каталоге
// ---------------------------------------------------------------------------
const SERIES_ALIAS = {
  "iphone 17 air": "iPhone Air",
  "iphone air": "iPhone Air",
  "galaxy s26 ultra": "Galaxy S26 Ultra",
};
// Мусор, который поставщик ставит в начало строки и который парсер не срезает.
const MODEL_LEAD_JUNK = /^[\s\p{P}\p{S}]+/u;

function mapSeries(modelRaw) {
  if (!modelRaw) return null;
  let s = String(modelRaw).replace(MODEL_LEAD_JUNK, "").replace(/\s+/g, " ").trim();
  const low = s.toLowerCase();
  if (SERIES_ALIAS[low]) return SERIES_ALIAS[low];
  return s;
}

// ---------------------------------------------------------------------------
// 4. Флаг региона → SIM
// ---------------------------------------------------------------------------
// ⚠️ ВНИМАНИЕ: в проекте ДВЕ несовпадающие версии этого маппинга:
//   worker/index.js FLAG_SIM:   🇭🇰 → "SIM + eSIM", 🇨🇳 → "SIM"
//   scripts/price-update.cjs:   HK/CN → "2 eSIM"
// Какая верна — вопрос к вам (см. отчёт). Здесь таблица ОДНА, и она источник
// истины для обоих путей; пока выставлено по worker/index.js.
// Отдельно: для Samsung число слотов задаёт суффикс кода модели (/DS), а НЕ флаг,
// поэтому для Samsung флаг даёт только регион — см. simFor().
// Комплектация SIM по стране поставки. ЗАВИСИТ ОТ ПОКОЛЕНИЯ — плоская таблица
// «флаг → SIM» неверна в принципе, Apple меняет конфигурации от серии к серии.
// Проверено по открытым источникам (сентябрь 2026):
//
//   iPhone 14 / 15 / 16:
//     США            — только eSIM (началось с iPhone 14)
//     Япония, ОАЭ    — nano-SIM + eSIM («Global»-версия для Японии, Европы, арабских стран)
//     Индия, Корея   — nano-SIM + eSIM (вся Азия, кроме Японии и Китая)
//     Гонконг, Китай — ДВА физических nano-SIM, eSIM нет
//
//   iPhone 17 / 17 Pro / 17 Pro Max:
//     США, Япония, ОАЭ, Канада, Мексика и страны Персидского залива — только eSIM
//       (Япония и ОАЭ ПЕРЕШЛИ на eSIM-only именно в 17-й серии — для 16-й они были SIM + eSIM)
//     Гонконг, Корея, Европа, остальная Азия — nano-SIM + eSIM
//     Материковый Китай — два физических nano-SIM, eSIM нет
//
//   iPhone Air — только eSIM во ВСЕХ регионах, физического лотка нет ни в одной версии.
//
//   iPhone 17e — по прайсу идёт с 🇮🇳 и 🇯🇵; считаем как 17-ю серию,
//     но данных по нему меньше всего, поэтому строки уйдут на ручной выбор.
//
// Метки берём из оси каталога, где «2 eSIM» = eSIM-only (два профиля, лотка нет),
// а «SIM + eSIM» = один физический nano-SIM + eSIM. Для eSIM-only регионов ставим
// именно «2 eSIM»: все iPhone без лотка (с 14-й серии) держат два профиля eSIM.
//
// Samsung здесь не участвует: у него комплектацию задаёт индекс кода модели (/DS).
const SIM_BY_GEN_FLAG = {
  // Поколения, где Япония и ОАЭ ещё с физическим слотом.
  legacy: {
    "🇺🇸": "2 eSIM",
    "🇯🇵": "SIM + eSIM",
    "🇦🇪": "SIM + eSIM",
    "🇮🇳": "SIM + eSIM",
    "🇰🇷": "SIM + eSIM",
    "🇰🇿": "SIM + eSIM",
    "🇹🇭": "SIM + eSIM",
    "🇭🇰": "2 SIM",
    "🇨🇳": "2 SIM",
  },
  // 17-я серия: Япония и ОАЭ стали eSIM-only, Гонконг — гибрид.
  gen17: {
    "🇺🇸": "2 eSIM",
    "🇯🇵": "2 eSIM",
    "🇦🇪": "2 eSIM",
    "🇨🇦": "2 eSIM",
    "🇲🇽": "2 eSIM",
    "🇮🇳": "SIM + eSIM",
    "🇰🇷": "SIM + eSIM",
    "🇰🇿": "SIM + eSIM",
    "🇹🇭": "SIM + eSIM",
    "🇭🇰": "SIM + eSIM",
    "🇨🇳": "2 SIM",
  },
};

// Какую таблицу применять к серии. iPhone Air — особый случай: eSIM-only везде,
// флаг на комплектацию не влияет вообще.
function simTableFor(series) {
  const s = String(series || "");
  if (/iPhone Air/i.test(s)) return "air";
  if (/iPhone 17/i.test(s)) return "gen17";
  return "legacy";
}

const FLAG_REGION = {
  "🇦🇪": "🇦🇪 ОАЭ",
  "🇰🇿": "🇰🇿 Казахстан",
  "🇹🇭": "🇹🇭 Таиланд",
};

function simFor(offer, brand, series) {
  // 1) Поставщик указал комплектацию прямо в строке («2Sim», «eSim») — это
  //    факт, а не вывод, поэтому приоритет выше флага и кода модели.
  if (offer.sim) return offer.sim;
  // 2) Samsung: число слотов задаёт индекс кода модели (/DS), а не страна.
  if (brand === "Samsung" && offer.modelCode && /\/DS\b/i.test(offer.modelCode)) {
    return "2 SIM + eSIM";
  }
  // 3) iPhone Air — eSIM-only во всех регионах, флаг не важен.
  const table = simTableFor(series);
  if (table === "air") return "2 eSIM";
  // 4) Иначе — по стране поставки с учётом поколения.
  if (!offer.flag) return null;
  return SIM_BY_GEN_FLAG[table][offer.flag] || null;
}

// ---------------------------------------------------------------------------
// 5. Сопоставление одной строки прайса с SKU каталога
// ---------------------------------------------------------------------------
// Сопоставляем СТРОГО по модель+память+цвет+SIM(+регион). Никакого «похожего»
// подбора: неоднозначность возвращается как причина отказа, а не разрешается
// угадыванием. Цена — не то поле, где стоит проявлять инициативу.
function matchOffer(offer, products) {
  const series = mapSeries(offer.model);
  if (!series) return { ok: false, reason: "не разобрана модель" };

  const pool0 = products.filter((p) => p.series === series);
  if (!pool0.length) return { ok: false, reason: `модели «${series}» нет в каталоге` };

  const brand = pool0[0].brand || "Apple";
  // Цвет: сначала таблица EN→RU, затем — прямое совпадение с тем, что уже лежит
  // в каталоге (поставщик иногда пишет цвет по-русски, и тогда перевод не нужен).
  const catalogColors = [...new Set(pool0.map((p) => p.color).filter(Boolean))];
  const color =
    mapColor(series, offer.color) ||
    catalogColors.find((c) => c.toLowerCase() === String(offer.color || "").toLowerCase()) ||
    null;
  if (offer.color && !color) {
    return { ok: false, reason: `цвет «${offer.color}» не сопоставлен для «${series}» (есть: ${catalogColors.join(", ")})` };
  }

  const sim = simFor(offer, brand, series);
  const region = offer.flag ? FLAG_REGION[offer.flag] : null;

  let pool = pool0;
  if (offer.storage) pool = pool.filter((p) => p.storage === offer.storage);
  if (!pool.length) return { ok: false, reason: `нет объёма «${offer.storage}» у «${series}»` };
  if (color) pool = pool.filter((p) => p.color === color);
  if (!pool.length) return { ok: false, reason: `нет цвета «${color}» у «${series}» ${offer.storage || ""}`.trim() };
  if (region) {
    const byReg = pool.filter((p) => p.region === region);
    if (byReg.length) pool = byReg;
  }

  // Комплектация. Если по определённому sim совпадений нет — НЕ отбрасываем
  // строку: маппинг флаг→SIM ненадёжен (см. FLAG_SIM), а цена поставщика
  // относится к этому товару независимо от того, как мы угадали комплектацию.
  // Помечаем как неоднозначное и отдаём все варианты оператору на выбор.
  let note = null;
  if (sim) {
    const bySim = pool.filter((p) => p.sim === sim);
    if (bySim.length) {
      pool = bySim;
    } else {
      note = `в каталоге нет комплектации «${sim}» — выберите вариант вручную`;
    }
  } else {
    note = "в прайсе не указана комплектация — выберите вариант вручную";
  }

  // Один кандидат — обычное однозначное сопоставление.
  if (pool.length === 1) {
    return { ok: true, products: pool, brand, series, color, sim, region, note: pool[0].sim === sim ? null : note };
  }
  // Несколько — предложение на каждый, оператор отметит галочкой нужный.
  return { ok: true, products: pool, brand, series, color, sim, region, note, ambiguous: true };
}

// ---------------------------------------------------------------------------
// 6. Проверки безопасности
// ---------------------------------------------------------------------------
// Защита от ошибок разбора и от «шального» прайса. Любое предложение, не
// прошедшее проверку, помечается blocked и НЕ применяется даже в авторежиме.
const GUARDS = {
  minRetail: 10000,      // дешевле — почти наверняка потерянный разряд
  maxRetail: 500000,     // дороже — лишний разряд
  maxDeltaPct: 25,       // резкий скачок цены требует глаз человека
};

function guard(product, retail, g = GUARDS) {
  if (!Number.isFinite(retail)) return "цена не число";
  if (retail < g.minRetail) return `цена ${retail} ₽ ниже порога ${g.minRetail} ₽ (похоже на потерянный разряд)`;
  if (retail > g.maxRetail) return `цена ${retail} ₽ выше порога ${g.maxRetail} ₽ (похоже на лишний разряд)`;
  const old = Number(product.priceCash) || 0;
  if (old > 0) {
    const delta = Math.abs(retail - old) / old * 100;
    if (delta > g.maxDeltaPct) {
      return `отклонение ${delta.toFixed(1)}% от текущей ${old} ₽ — больше порога ${g.maxDeltaPct}%`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 7. Сборка предложений
// ---------------------------------------------------------------------------
// Возвращает { proposals, unmatched, stats }. НИЧЕГО не мутирует.
// Применение — отдельным шагом (applyProposals), по явному решению оператора.
function buildProposals(prices, catalog, opts = {}) {
  const g = { ...GUARDS, ...(opts.guards || {}) };
  const products = (catalog && catalog.products) || [];
  const proposals = [];
  const unmatched = [];
  const seen = new Set();

  for (const offer of prices || []) {
    const m = matchOffer(offer, products);
    if (!m.ok) {
      unmatched.push({ offer, reason: m.reason });
      continue;
    }

    const retail = retailFrom(offer.price, m.brand);

    // Кандидатов может быть несколько: комплектация в прайсе не указана либо
    // указанной в каталоге нет. Тогда предложение создаётся на КАЖДЫЙ вариант
    // и помечается ambiguous — оператор отметит нужный. Раньше такая строка
    // просто отбрасывалась, и цена терялась.
    for (const prod of m.products) {
      const blocked = guard(prod, retail, g);
      const old = Number(prod.priceCash) || 0;

      // Дубликат в прайсе (поставщик часто повторяет позицию): берём
      // минимальную закупку, но факт дубля показываем оператору.
      if (seen.has(prod.id)) {
        const prev = proposals.find((x) => x.id === prod.id);
        if (prev) {
          if (retail < prev.retail) {
            prev.retail = retail;
            prev.supplier = offer.price;
            prev.blocked = blocked;
          }
          prev.duplicates += 1;
        }
        continue;
      }
      seen.add(prod.id);

      proposals.push({
        id: prod.id,
        label: `${m.series} ${prod.storage || ""} ${prod.color}${prod.region ? " " + prod.region : ""}`.replace(/\s+/g, " ").trim(),
        sim: prod.sim,
        supplier: offer.price,
        retail,
        oldPrice: old,
        deltaPct: old > 0 ? Number((((retail - old) / old) * 100).toFixed(1)) : null,
        brand: m.brand,
        blocked: blocked || null,
        ambiguous: !!m.ambiguous,
        note: m.note || null,
        // Сколько раз позиция встретилась в прайсе. Объявляем сразу, а не
        // дописываем позже: иначе поле отсутствует в типе объекта и правки
        // вида prev.duplicates не проходят проверку анализатором.
        duplicates: 1,
        sourceLine: offer.sourceLine || null,
      });
    }
  }

  // Предложений может быть БОЛЬШЕ, чем строк прайса: когда комплектация не
  // определилась, на одну строку создаётся вариант на каждый подходящий SKU.
  // Поэтому строки прайса и предложения считаем отдельно, иначе в отчёте
  // появляются бессмысленные «103% сопоставлено».
  const applicable = proposals.filter((p) => !p.blocked && !p.ambiguous);
  return {
    proposals,
    unmatched,
    stats: {
      parsed: (prices || []).length,
      matchedLines: (prices || []).length - unmatched.length,
      proposals: proposals.length,
      applicable: applicable.length,
      ambiguous: proposals.filter((p) => p.ambiguous).length,
      blocked: proposals.filter((p) => p.blocked).length,
      unmatched: unmatched.length,
    },
  };
}

// ---------------------------------------------------------------------------
// 8. Применение
// ---------------------------------------------------------------------------
// Мутирует КОПИЮ каталога и возвращает её. Применяет только незаблокированные
// предложения; ids (если передан) дополнительно ограничивает набор — так CRM
// может применить выборочно, галочками.
// overrides — { id: цена }: цена, вручную исправленная оператором в CRM.
// Ручная правка СИЛЬНЕЕ блокировки guard'ом: если человек посмотрел на позицию
// и сам вписал цифру, он берёт ответственность на себя — незачем ему мешать.
// Но проверку на вменяемость числа оставляем: опечатка в поле ввода так же
// возможна, как ошибка разбора.
function applyProposals(catalog, proposals, ids, overrides, cardRatio) {
  const next = JSON.parse(JSON.stringify(catalog));
  const byId = new Map(next.products.map((p) => [p.id, p]));
  const allow = ids ? new Set(ids) : null;
  const ov = overrides || {};
  const ratio = Number(cardRatio) > 1 ? Number(cardRatio) : CARD_RATIO;
  let applied = 0;
  const rejected = [];

  for (const pr of proposals) {
    if (allow && !allow.has(pr.id)) continue;
    const manual = Object.prototype.hasOwnProperty.call(ov, pr.id);
    const price = manual ? Math.round(Number(ov[pr.id])) : pr.retail;

    if (!manual && pr.blocked) continue;
    if (!Number.isFinite(price) || price < GUARDS.minRetail || price > GUARDS.maxRetail) {
      rejected.push({ id: pr.id, price, reason: "цена вне допустимых границ" });
      continue;
    }

    const p = byId.get(pr.id);
    if (!p) { rejected.push({ id: pr.id, reason: "SKU не найден в каталоге" }); continue; }
    p.priceCash = price;
    // Цена по карте пересчитывается по конвенции магазина, а не копируется:
    // иначе ручная правка наличных сломала бы соотношение.
    p.priceCard = Math.round((price * ratio) / 10) * 10;
    applied++;
  }
  next.meta = next.meta || {};
  next.meta.updatedAt = new Date().toISOString().slice(0, 10);
  return { catalog: next, applied, rejected };
}

export { MARKUP, retailFrom, COLOR_BY_SERIES, mapColor, mapSeries, SIM_BY_GEN_FLAG, simTableFor, FLAG_REGION, simFor, matchOffer, GUARDS, guard, buildProposals, applyProposals };
