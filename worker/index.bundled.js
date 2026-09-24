// ============================================================================
// worker/index.bundled.js — СОБРАННЫЙ ФАЙЛ. НЕ РЕДАКТИРОВАТЬ ВРУЧНУЮ.
// Сгенерирован scripts/bundle-worker.cjs из worker/*.js.
// Правьте исходные модули и пересоберите: node scripts/bundle-worker.cjs
//
// Как применить: скопировать содержимое целиком в Cloudflare →
// Workers & Pages → ваш воркер → Edit code → заменить всё → Deploy.
// ============================================================================

// ─── tg-price-parse.js ──────────────────────────────────────────────
// worker/tg-price-parse.js — разбор строк прайса из Telegram.
// Вынесено из worker/index.js, чтобы один и тот же парсер использовался
// и в cron, и в тестах/отчётах (иначе они неизбежно разъезжаются).
//
// Исправлено против версии в задеплоенном воркере:
//   1) Цвета: добавлены Cosmic Orange, Sky Blue, Cloud White и др. — раньше
//      «Cosmic Orange» не распознавался и утекал в название модели.
//   2) Формат «12/256» (ОЗУ/память, типично для Samsung) — раньше storage=null.
//   3) «256» без ГБ/GB — раньше объём терялся и утекал в модель.
//   4) Маркеры списка (▪️ • - –) в начале строки — раньше попадали в модель.
//   5) Код модели (SM-S948B/DS) извлекается отдельным полем: для Samsung именно
//      он, а не флаг страны, определяет число SIM-слотов.
//   6) Сохраняется исходная строка (sourceLine) — без неё разбирать спорные
//      сопоставления в отчёте невозможно.

const KNOWN_COLORS = [
  // Многословные — раньше в списке, иначе «Black» съест «Black Titanium».
  "Natural Titanium", "Blue Titanium", "White Titanium", "Black Titanium",
  "Desert Titanium", "Space Black", "Cosmic Orange", "Deep Blue",
  "Sierra Blue", "Sky Blue", "Cloud White", "Soft Pink", "Rose Gold",
  "Cobalt Violet", "Space Gray", "Space Grey", "Midnight", "Starlight",
  "Black", "White", "Blue", "Gold", "Silver", "Lavender", "Sage", "Pink",
  "Green", "Purple", "Red", "Graphite", "Gray", "Grey", "Violet", "Cobalt",
  "Teal", "Ultramarine", "Orange", "Natural", "Desert", "Yellow",
  // Цвета MacBook из прайса: «MacBook MHFJ4 Neo 13 Blush», «Neo Citrus», «Neo Indigo»
  "Indigo", "Blush", "Citrus",
  // Палитра iPhone 18 Pro: Glacier (ледниковый) и Burgundy (бордовый).
  "Glacier", "Burgundy",
  // Поставщик иногда пишет цвета по-русски — принимаем и такие.
  "Чёрный титан", "Белый титан", "Натуральный титан", "Пустынный титан",
  "Космический оранжевый", "Небесно-голубой", "Облачный белый", "Чёрный оникс",
  "Розовое золото", "Сияющая звезда", "Тёмная ночь", "Серебристый",
  "Ультрамарин", "Лавандовый", "Шалфейный", "Бирюзовый", "Сиреневый",
  "Голубой", "Золотой", "Розовый", "Чёрный", "Белый", "Синий", "Серый", "Космос",
].sort((a, b) => b.length - a.length);

// В маркеры списка обязательно входит U+FE0F (variation selector): без него
// от «▪️» остаётся невидимый хвост и утекает в название модели.
const LEAD_JUNK = /^[\s\uFE0F\u2022\u25AA\u25FE\u00B7\-\u2013\u2014*#>]+/u;

// Ниже этого порога строка считается НЕ товарной (заголовок, номер модели).
const MIN_PRICE = 1000;

function extractFlag(str) {
  const m = str.match(/\p{Regional_Indicator}\p{Regional_Indicator}/u);
  return m ? m[0] : null;
}

function parsePrice(str) {
  const digits = String(str).replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

// Код модели вида SM-S948B/DS, SM-S938B — выдёргиваем до разбора остального,
// иначе «/DS» и цифры кода мешают распознать объём памяти.
function extractModelCode(str) {
  const m = str.match(/\bSM-[A-Z0-9]+(?:\/[A-Z]{2})?\b/i);
  return m ? { code: m[0].toUpperCase(), rest: str.replace(m[0], " ") } : { code: null, rest: str };
}

// Объём памяти. Поддерживает: «256GB», «256 ГБ», «1TB», «12/256» (ОЗУ/память
// — берём второе число), «256» (голое число в конце — трактуем как ГБ).
function extractStorage(str) {
  // «12/256» или «12/256GB»
  let m = str.match(/\b(\d{1,2})\s*\/\s*(\d{3,4})\s*(ГБ|GB|ТБ|TB)?\b/i);
  if (m) {
    return { storage: `${m[2]} ГБ`, ram: `${m[1]} ГБ`, rest: str.replace(m[0], " ") };
  }
  // «256GB» / «256 ГБ» / «1 ТБ». Совпадений может быть несколько:
  // «MacBook ... (A18, 8GB, 512GB)» — первым идёт ОЗУ. Раньше брали первое
  // совпадение и записывали 8 ГБ как объём накопителя. Поэтому берём
  // НАИБОЛЬШЕЕ значение как накопитель, наименьшее — как ОЗУ.
  const all = [...str.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(ГБ|GB|ТБ|TB)\b/gi)];
  if (all.length) {
    const norm = (mm) => {
      const isTb = /T/i.test(mm[2]);
      const n = parseFloat(mm[1].replace(",", "."));
      return { gb: isTb ? n * 1024 : n, label: `${mm[1].replace(",", ".")} ${isTb ? "ТБ" : "ГБ"}`, raw: mm[0] };
    };
    const items = all.map(norm).sort((a, b) => b.gb - a.gb);
    const stor = items[0];
    const ram = items.length > 1 ? items[items.length - 1] : null;
    let rest = str;
    for (const it of items) rest = rest.replace(it.raw, " ");
    return { storage: stor.label, ram: ram ? ram.label : null, rest };
  }
  // Голое число — только из известного набора объёмов, чтобы не съесть
  // «17» из «iPhone 17» или «3» из «AirPods Pro 3».
  m = str.match(/\b(64|128|256|512)\b/);
  if (m) {
    return { storage: `${m[1]} ГБ`, ram: null, rest: str.replace(m[0], " ") };
  }
  return { storage: null, ram: null, rest: str };
}

// Комплектация, указанная поставщиком ПРЯМО в строке: «2Sim», «eSim», «1Sim».
// Это надёжнее, чем вывод по флагу страны, поэтому имеет приоритет.
// Реальные примеры из @OPTMSK77:
//   «iPhone 16 Pro 128GB Desert 2Sim 🇨🇳 — 84 100»
//   «iPhone 17 512GB Sage eSim 🇯🇵 — 87 300»
// Без этого «2Sim»/«eSim» оставались в названии модели, и строка не
// сопоставлялась вообще («модели нет в каталоге»).
function extractSimToken(str) {
  let sim = null;
  let rest = str;
  // Объекты, а не пары-массивы: из пары [RegExp, string] анализаторы выводят
  // общий тип string | RegExp и теряют, что первый элемент — регулярное
  // выражение (VS Code ругался «Property 'test' does not exist»).
  // Порядок важен: более специфичные шаблоны идут раньше.
  const pats = [
    { re: /\b2\s*x?\s*sim\s*\+\s*e-?sim\b/i, val: "2 SIM + eSIM" },
    { re: /\b2\s*e-?sim\b/i, val: "2 eSIM" },
    { re: /\b2\s*sim\b/i, val: "2 SIM" },
    { re: /\b1\s*sim\s*\+\s*e-?sim\b/i, val: "SIM + eSIM" },
    { re: /\be-?sim\b/i, val: "eSIM" },
    { re: /\b1\s*sim\b/i, val: "SIM" },
  ];
  for (const { re, val } of pats) {
    if (re.test(rest)) { sim = val; rest = rest.replace(re, " "); break; }
  }
  return { sim, rest };
}

function parseLine(rawLine) {
  const line = String(rawLine || "").trim();
  if (!line) return null;

  // Цена в конце строки.
  const priceMatch = line.match(/(?:[\s\-\u2014\u2013:.]+)(\d[\d\s.]{2,}\d|\d+)\s*(?:₽|руб|rub|\$)?$/i);
  if (!priceMatch) return null;
  const price = parsePrice(priceMatch[1]);
  if (!price) return null;
  // Заголовок категории «iPhone 17» иначе разбирается как товар с ценой 17.
  // Реальных позиций дешевле MIN_PRICE в каталоге нет (самое дешёвое — наушники
  // за ~20 000 ₽), поэтому floor безопасен и убирает целый класс ложных строк.
  if (price < MIN_PRICE) return null;

  let head = line.slice(0, priceMatch.index).trim();
  if (!head) return null;

  const flag = extractFlag(head);
  if (flag) head = head.replace(flag, " ");

  const mc = extractModelCode(head);
  const sm = extractSimToken(mc.rest);
  const st = extractStorage(sm.rest);

  let rest = st.rest.replace(LEAD_JUNK, "").replace(/\s+/g, " ").trim();

  // Цвет — ищем в любом месте остатка, не только в конце: поставщик пишет и
  // «iPhone 17 Pro Max 512GB 🇺🇸 Deep Blue», и «... Deep Blue 512GB».
  let color = null;
  for (const c of KNOWN_COLORS) {
    const re = new RegExp(`(^|\\s)${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "i");
    if (re.test(rest)) {
      color = c;
      rest = rest.replace(re, " ").replace(/\s+/g, " ").trim();
      break;
    }
  }

  const model = rest.replace(LEAD_JUNK, "").replace(/[\s\uFE0F]+$/u, "").replace(/\s+/g, " ").trim();
  if (!model) return null;

  return {
    model,
    storage: st.storage,
    ram: st.ram,
    color,
    flag,
    modelCode: mc.code,
    // sim из строки прайса (если поставщик его указал) — приоритетнее флага.
    sim: sm.sim,
    price,
    sourceLine: line,
  };
}


// Разбор пачки сообщений прайса в список позиций.
//
// ЕДИНСТВЕННАЯ реализация этого цикла: им пользуются и приём форвардов, и
// скрейпинг канала, и скрипт отчёта. Раньше цикл был скопирован в трёх местах,
// и отчёт не отслеживал заголовки категорий — из-за чего показывал 0
// сопоставлений там, где боевой путь сработал бы.
//
// Строка, которую parseLine не принял, считается ЗАГОЛОВКОМ категории: так
// прайс сам себя размечает («IPHONE 17 AIR», «APPLE (iPhone 17 Pro)»).
// Заголовок важен не только для группировки — поставщик выносит в него модель,
// а в строках товара оставляет лишь хвост («17 Air 256GB Black»), поэтому без
// категории серию не восстановить.
function parseMessages(messages) {
  const items = [];
  let category = null;
  for (const text of messages || []) {
    for (const rawLine of String(text).split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const parsed = parseLine(line);
      if (parsed) items.push({ category, ...parsed });
      else category = line.replace(/[|\u2022\-\u2013\u2014]+$/g, "").trim() || category;
    }
  }

  // Дедуп: поставщик повторяет позиции и внутри сообщения, и между сообщениями.
  // При коллизии оставляем МЕНЬШУЮ цену — завысить закупку хуже, чем занизить.
  const dedup = new Map();
  for (const it of items) {
    const key = [it.model, it.storage, it.color, it.flag, it.sim].join("||");
    const prev = dedup.get(key);
    if (!prev || it.price < prev.price) dedup.set(key, it);
  }
  return [...dedup.values()];
}

// ─── tg-price-sync.js ──────────────────────────────────────────────
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
  "iPhone 16 Plus": { black: "Чёрный", white: "Белый", pink: "Розовый", teal: "Бирюзовый", ultramarine: "Ультрамарин" },
  "iPhone 16e": { black: "Чёрный", white: "Белый" },
  "iPhone 18 Pro": { black: "Чёрный", burgundy: "Бордовый", glacier: "Ледниковый", silver: "Серебристый" },
  "iPhone 18 Pro Max": { black: "Чёрный", burgundy: "Бордовый", glacier: "Ледниковый", silver: "Серебристый" },
  // Samsung: в каталоге цвета уже по-английски, маппинг почти тождественный.
  "Galaxy S26 Ultra": { black: "Black", white: "White", cobalt: "Cobalt Violet", "cobalt violet": "Cobalt Violet", violet: "Violet", gray: "Gray", grey: "Gray", gold: "Gold" },
};

function mapColor(series, colorEN) {
  if (!colorEN) return null;
  const key = Object.keys(COLOR_BY_SERIES).find((k) => k.toLowerCase() === String(series).toLowerCase());
  const table = key ? COLOR_BY_SERIES[key] : null;
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

// Бренд-префиксы, с которых может начинаться полное имя серии в каталоге.
const BRAND_PREFIX = /^(iphone|ipad|apple\s+watch|watch|airpods|macbook|mac\b|galaxy|samsung)/i;

// Из заголовка категории вытаскиваем бренд-слово. Заголовки у поставщика
// выглядят как «IPHONE 17 AIR», «IPHONE 16 PRO MAX», «SAMSUNG GALAXY S26».
function brandFromCategory(category) {
  const c = String(category || "");
  if (/iphone/i.test(c)) return "iPhone";
  if (/ipad/i.test(c)) return "iPad";
  if (/watch/i.test(c)) return "Apple Watch";
  if (/airpods/i.test(c)) return "AirPods";
  if (/macbook/i.test(c)) return "MacBook";
  if (/galaxy|samsung/i.test(c)) return "Galaxy";
  return null;
}

// Название серии из строки прайса.
//
// Поставщик выносит модель в ЗАГОЛОВОК сообщения, а в строках товара оставляет
// только «хвост»: «IPHONE 17 AIR» + «17 Air 256GB Black 🇯🇵 — 75 500». Поэтому
// строка сама по себе даёт серию «17 Air», которой в каталоге нет, и раньше
// такой прайс не сопоставлялся вообще (0 из 51 строки). Достраиваем имя
// бренд-словом из заголовка, если в строке его нет.
function mapSeries(modelRaw, category) {
  if (!modelRaw) return null;
  let s = String(modelRaw).replace(MODEL_LEAD_JUNK, "").replace(/\s+/g, " ").trim();
  if (!s) return null;

  if (!BRAND_PREFIX.test(s)) {
    const brand = brandFromCategory(category);
    // Без заголовка достраивать нечем: строка вида «17 Air» останется как есть
    // и честно не сопоставится, вместо того чтобы угадывать бренд.
    if (brand) s = `${brand} ${s}`;
  }

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
  // 17-я и 18-я серии: одна и та же таблица (Япония, ОАЭ, Канада, Мексика — eSIM-only).
  if (/iPhone 1[78]/i.test(s)) return "gen17";
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
  if (offer.sim) {
    // Перевод словаря поставщика в нашу ось. Поставщик пишет «eSim», имея в
    // виду аппарат БЕЗ физического лотка; у нас такая комплектация называется
    // «2 eSIM» (все eSIM-only iPhone с 14-й серии держат два профиля), а метка
    // «eSIM» у iPhone после переименования не используется вовсе.
    // Часы не трогаем: у Apple Watch «eSIM» — верная и единственная метка.
    if (offer.sim === "eSIM" && /iPhone/i.test(String(series || ""))) return "2 eSIM";
    return offer.sim;
  }
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
  let series = mapSeries(offer.model, offer.category);
  if (!series) return { ok: false, reason: "не разобрана модель" };

  // Скрытые позиции в предложения не попадают: это товары не в продаже, и
  // строки по ним только замусорили бы список на проверку. Когда позицию
  // вернут в продажу, цена подтянется следующей же синхронизацией.
  // Скрытые варианты участвуют в подборе, чтобы строка прайса не «переехала»
  // в соседний видимый вариант, когда её собственный вариант просто скрыт.
  // Регистр в прайсе плавает («18 pro max»), поэтому сравниваем без учёта регистра.
  const low = String(series).toLowerCase();
  const poolAll = products.filter((p) => String(p.series).toLowerCase() === low);
  if (!poolAll.length) return { ok: false, reason: `модели «${series}» нет в каталоге` };
  if (!poolAll.some((p) => !p.hidden)) return { ok: false, reason: `модель «${series}» скрыта на сайте` };
  // Дальше работаем с названием серии в том виде, как оно записано в каталоге:
  // от него зависят словарь цветов и таблица SIM по поколению.
  series = poolAll[0].series;
  const pool0 = poolAll;

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

  // Комплектация. Если флаг однозначно задал SIM, а такой комплектации в
  // каталоге нет — строку НЕ подставляем в соседний вариант: цены «2 eSIM»
  // и «SIM + eSIM» различаются, и японская закупка перебила бы индийскую
  // (минимум при дублях). Такая строка уходит в «Не сопоставлено» с понятной
  // причиной. На выбор оператору отдаём только строки без комплектации.
  let note = null;
  if (sim) {
    pool = pool.filter((p) => p.sim === sim);
    if (!pool.length) {
      return { ok: false, reason: `нет комплектации «${sim}» у «${series}» ${offer.storage || ""} ${color || ""}`.replace(/\s+/g, " ").trim() };
    }
  } else {
    note = "в прайсе не указана комплектация — выберите вариант вручную";
  }

  // Всё подходящее скрыто — цену не предлагаем (товар не в продаже), но и
  // в соседний видимый вариант её не подставляем.
  const visible = pool.filter((p) => !p.hidden);
  if (!visible.length) {
    return { ok: false, reason: `вариант скрыт на сайте: «${series}» ${offer.storage || ""} ${color || ""} ${sim || ""}`.replace(/\s+/g, " ").trim() };
  }
  pool = visible;

  // Один кандидат — обычное однозначное сопоставление.
  if (pool.length === 1) {
    return { ok: true, products: pool, brand, series, color, sim, region, note };
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

// ─── tg-feeds.js ──────────────────────────────────────────────
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

// ─── index.js (основной) ──────────────────────────────────────────────
// worker/index.js — Cloudflare Worker для «Apple i Точка»
// 1) Отправка лидов с сайта в Telegram-чат оператора (FR-4.1)
// 2) Мини-CRM API: чтение/запись цен и наличия в KV (FR-4.2)
// 3) Управление лидами прямо в Telegram: статус, блокировка номера, удаление спама
// 4) Синхронизация прайса из Telegram-канала по расписанию → предложения по ценам
// 5) Товарные фиды для ВК / 2ГИС / Яндекс.Карт, генерируемые из KV на лету
//
// Переменные. В веб-морде: Workers & Pages → воркер → Settings → Variables.
//   TELEGRAM_BOT_TOKEN  (секрет) — токен бота @BotFather
//   TELEGRAM_CHAT_ID    (секрет) — id чата/группы оператора
//   ADMIN_TOKEN         (секрет) — пароль для /admin.html и /prices.html
//   TURNSTILE_SECRET    (секрет, опц.) — Cloudflare Turnstile
//   TG_WEBHOOK_SECRET   (секрет, опц., нужен для кнопок под лидом)
//     После деплоя один раз зарегистрируйте webhook:
//     curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/api/tg/webhook&secret_token=<SECRET>"
//   ALLOWED_ORIGINS     — домены сайта через запятую
//   TG_PRICE_CHANNEL    — ПУБЛИЧНЫЙ канал для скрейпинга. Пусто или "off" —
//                         скрейпинг выключен, прайс принимается форвардами.
//   TG_PRICE_SENDERS    — user id через запятую, от кого бот принимает прайс
//                         форвардами. Пусто = приём выключен. Свой id: /id боту.
//   TG_PRICE_PAGES      — сколько страниц истории читать (по умолчанию 5)
//   SITE_URL, SHOP_NAME — для товарных фидов
//   CARD_RATIO          — цена по карте = наличные × это число (по умолчанию 1.15)
//   GH_DISPATCH_TOKEN   (секрет, опц.) — GitHub fine-grained token с правом
//                         Contents: Read and write на репозиторий сайта. Если
//                         задан, после каждого изменения каталога воркер просит
//                         GitHub пересобрать сайт: страницы товаров, заголовки
//                         в поиске и превью ссылок получают свежие цены.
//   GH_REPO             — owner/repo сайта (по умолчанию DeepBlue2416/DeepBlue2416.github.io)
// Binding KV: PRODUCTS. Ключ "catalog" хранит весь каталог.
//
// Cron: Settings → Trigger Events → Cron Triggers, например "0 5,11,15 * * *"
// (UTC; для Таганрога UTC+3 это 08:00 / 14:00 / 18:00).



const KV_KEY = "catalog";
const TG_PRICES_KEY = "parsed_tg_prices";
const TG_PROPOSALS_KEY = "tg_price_proposals";
const TG_SYNC_LOG_KEY = "tg_sync_log";
const REVIEWS_KEY = "reviews";

// Человекочитаемые подписи статусов лида.
const STATUS_LABEL = {
  new: "",
  active: "🟢 В работе",
  closed: "✅ Закрыт",
  refused: "🚫 Отказ",
  blocked: "⛔ Заблокирован",
};

export default {
  // Cron Triggers вызывают ИМЕННО scheduled(), а не fetch(). Пока этого метода
  // не было, расписание срабатывало «в пустоту»: Cloudflare писал в логи
  // «Handler does not export a scheduled() function».
  async scheduled(event, env, ctx) {
    // Скрейпинг веб-превью работает только с ПУБЛИЧНЫМ каналом. Если прайс
    // приходит форвардами (приватный канал поставщика), TG_PRICE_CHANNEL нужно
    // оставить пустым или поставить "off" — тогда cron ничего не делает и не
    // шлёт оператору ошибку каждые полчаса.
    const ch = String(env.TG_PRICE_CHANNEL || "").trim();
    if (!ch || ch.toLowerCase() === "off") {
      console.log("[tg-sync] скрейпинг выключен (TG_PRICE_CHANNEL пуст) — прайс принимается форвардами");
      return;
    }
    ctx.waitUntil(runTgSync(env, event.cron));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // ---- Товарные фиды (из KV, всегда свежие) ----
      // /feed/vk.yml  /feed/2gis.yml  /feed/2gis.csv  /feed/yandex-maps.yml
      if (url.pathname.startsWith("/feed/")) {
        const fed = await handleFeed(url, env, KV_KEY);
        if (fed) return fed;
      }

      // ---- Сырой разобранный прайс ----
      // Под токеном: это закупочные цены поставщика, наружу отдавать нельзя.
      if (url.pathname === "/api/tg-prices" && request.method === "GET") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const raw = await env.PRODUCTS.get(TG_PRICES_KEY);
        return new Response(raw || "[]", {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // ---- Статус последней синхронизации (диагностика cron) ----
      // Без токена: секретов не содержит, а смотреть его нужно часто.
      if (url.pathname === "/api/tg-sync-status" && request.method === "GET") {
        const raw = await env.PRODUCTS.get(TG_SYNC_LOG_KEY);
        const chan = String(env.TG_PRICE_CHANNEL || "").trim();
        let st;
        try { st = raw ? JSON.parse(raw) : { ok: false, error: "cron ещё ни разу не запускался" }; }
        catch { st = { ok: false, error: "журнал синхронизации повреждён" }; }
        st.channelEnabled = !!chan && chan.toLowerCase() !== "off";
        return new Response(JSON.stringify(st), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // ---- Предложения по ценам ----
      if (url.pathname === "/api/tg-proposals" && request.method === "GET") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const raw = await env.PRODUCTS.get(TG_PROPOSALS_KEY);
        return new Response(raw || JSON.stringify({ proposals: [], unmatched: [], stats: {} }), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // ---- Ручной запуск синхронизации ----
      // Тем же кодом, что и cron: иначе ручной и автоматический путь разъедутся
      // и отладка перестанет что-либо доказывать.
      if (url.pathname === "/api/admin/sync-tg" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const ch = (url.searchParams.get("channel") || env.TG_PRICE_CHANNEL || "").trim();
        if (!ch || ch.toLowerCase() === "off") {
          return json({
            success: false,
            error: "scraping_disabled",
            hint: "TG_PRICE_CHANNEL пуст или off. Скрейпинг доступен только для публичного канала; приватный присылайте форвардами боту.",
          }, 409, cors);
        }
        const log = await runTgSync(env, "manual", ch, url.searchParams.get("pages"));
        return json({ success: log.ok, ...log }, log.ok ? 200 : 502, cors);
      }

      // ---- Прайс, вставленный вручную ----
      // Нужен, когда канал поставщика приватный: страницы t.me/s/<channel> у
      // таких каналов не существует, и скрейпинг превью невозможен в принципе.
      // Оператор копирует сообщения из Telegram и вставляет текст — дальше всё
      // идёт тем же путём, что и при автоматической синхронизации.
      if (url.pathname === "/api/admin/tg-paste" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        return await handleTgPaste(request, env, cors);
      }

      // ---- Применить ВЫБРАННЫЕ предложения ----
      if (url.pathname === "/api/admin/tg-apply" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        return await handleTgApply(request, env, cors);
      }

      // ---- Публичный каталог (реальное время из KV) ----
      if (url.pathname === "/api/products" && request.method === "GET") {
        const raw = await env.PRODUCTS.get(KV_KEY);
        if (!raw) {
          return json({ error: "catalog_not_seeded" }, 404, cors);
        }
        // Без query-параметров — прежнее поведение: каталог целиком (витрина
        // фильтрует на клиенте). С параметрами — фильтруем на сервере теми же
        // ортогональными правилами: ?simSlots=2&esim=1, ?simSlots=1,2,
        // ?category=&series=&storage=&watchSize=&color=&region=
        const catalog = JSON.parse(raw);

        // ?includeHidden=1 — полный каталог, включая скрытые позиции. Только
        // под токеном и только для CRM: иначе скрытые товары нельзя было бы
        // увидеть и вернуть в продажу — админка читает этот же эндпоинт.
        if (url.searchParams.get("includeHidden") === "1") {
          if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
          return json({ ...catalog, total: (catalog.products || []).length }, 200, cors);
        }

        if (![...url.searchParams.keys()].length) {
          // Раньше отдавали сырой JSON из KV одним куском. Теперь приходится
          // разобрать и собрать обратно, чтобы вырезать скрытые позиции:
          // витрина фильтрует на клиенте, но полагаться на это нельзя —
          // этот же ответ читают внешние интеграции.
          const visible = (catalog.products || []).filter((p) => !p.hidden);
          return json({ ...catalog, products: visible, total: visible.length }, 200, cors);
        }
        const filtered = filterProducts(catalog.products || [], url.searchParams);
        return json({ ...catalog, products: filtered, total: filtered.length }, 200, cors);
      }

      // ---- Витрина отзывов ----
      // Публично: список читают и сайт, и CRM. Роут был в более раннем
      // варианте воркера и потерялся при сборке — фронтенд его зовёт на каждой
      // загрузке страницы и получал 404 (видно в консоли браузера). Витрина при
      // этом падала на встроенный список из config.js, а правки из CRM
      // сохранить было нельзя вообще.
      if (url.pathname === "/api/reviews" && request.method === "GET") {
        const raw = await env.PRODUCTS.get(REVIEWS_KEY);
        // Пустое хранилище — не ошибка: фронтенд в этом случае берёт список из
        // config.js. Поэтому отдаём 200 с пустым массивом, а не 404.
        return new Response(raw || JSON.stringify({ sources: [] }), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // ---- CRM: сохранить витрину отзывов ----
      if (url.pathname === "/api/admin/reviews" && request.method === "POST") {
        if (!authorized(request, env)) return json({ success: false, error: "unauthorized" }, 401, cors);
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.sources)) {
          return json({ success: false, error: "bad_reviews" }, 400, cors);
        }
        // Чистим форму: наружу это отдаётся публично и вставляется в разметку,
        // поэтому храним только ожидаемые поля и ограничиваем длину.
        const clean = body.sources.slice(0, 20).map((s0) => ({
          name: String(s0 && s0.name || "").slice(0, 120),
          url: String(s0 && s0.url || "").slice(0, 500),
          widgetUrl: String(s0 && s0.widgetUrl || "").slice(0, 500),
          rating: String(s0 && s0.rating || "").slice(0, 10),
          count: String(s0 && s0.count || "").slice(0, 40),
          featured: Array.isArray(s0 && s0.featured)
            ? s0.featured.slice(0, 20).map((r) => ({
                author: String(r && r.author || "").slice(0, 120),
                date: String(r && r.date || "").slice(0, 40),
                rating: Math.max(1, Math.min(5, Math.round(Number(r && r.rating) || 5))),
                text: String(r && r.text || "").slice(0, 2000),
              }))
            : [],
        }));
        await env.PRODUCTS.put(REVIEWS_KEY, JSON.stringify({
          sources: clean,
          updatedAt: new Date().toISOString(),
        }));
        return json({ success: true, ok: true, count: clean.length }, 200, cors);
      }

      // ---- Приём лида -> Telegram ----
      if (url.pathname === "/api/lead" && request.method === "POST") {
        return await handleLead(request, env, cors);
      }

      // ---- Telegram webhook: нажатия кнопок под заявкой ----
      // Вызывается самим Telegram (server-to-server), CORS не нужен.
      if (url.pathname === "/api/tg/webhook" && request.method === "POST") {
        return await handleTgWebhook(request, env);
      }

      // ---- CRM: инициализация каталога (первый запуск) ----
      if (url.pathname === "/api/admin/seed" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        const body = await request.json();
        if (!body || !Array.isArray(body.products)) {
          return json({ error: "bad_catalog" }, 400, cors);
        }
        canonicalizeSim(body.products);
        await env.PRODUCTS.put(KV_KEY, JSON.stringify(body));
        await triggerRebuild(env);
        return json({ ok: true, count: body.products.length }, 200, cors);
      }

      // ---- CRM: обновление цен/статусов ----
      if (url.pathname === "/api/admin/update" && request.method === "POST") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401, cors);
        return await handleUpdate(request, env, cors);
      }

      // ---- CRM: сохранить ВЕСЬ каталог ----
      if (url.pathname === "/api/admin/save" && request.method === "POST") {
        if (!authorized(request, env)) return json({ success: false, error: "unauthorized" }, 401, cors);
        const body = await request.json().catch(() => null);
        const cat = body && body.catalog;
        if (!cat || !Array.isArray(cat.products) || !Array.isArray(cat.categories)) {
          return json({ success: false, error: "bad_catalog" }, 400, cors);
        }
        const cur = await env.PRODUCTS.get(KV_KEY);
        await pushHistory(env, cur, (body && body.note) || "перед сохранением");
        if (cat.meta) cat.meta.updatedAt = new Date().toISOString().slice(0, 10);
        canonicalizeSim(cat.products);
        await env.PRODUCTS.put(KV_KEY, JSON.stringify(cat));
        await triggerRebuild(env);
        return json({ success: true, ok: true, count: cat.products.length }, 200, cors);
      }

      // ---- CRM: список версий (история для отката) ----
      if (url.pathname === "/api/admin/history" && request.method === "GET") {
        if (!authorized(request, env)) return json({ success: false, error: "unauthorized" }, 401, cors);
        let idx = [];
        try { idx = JSON.parse((await env.PRODUCTS.get("cat:hist:index")) || "[]"); } catch {}
        return json({ success: true, versions: idx }, 200, cors);
      }

      // ---- CRM: откат к версии ----
      if (url.pathname === "/api/admin/restore" && request.method === "POST") {
        if (!authorized(request, env)) return json({ success: false, error: "unauthorized" }, 401, cors);
        const body = await request.json().catch(() => null);
        const ts = body && body.ts;
        const bak = ts ? await env.PRODUCTS.get(`cat:hist:${ts}`) : null;
        if (!bak) return json({ success: false, error: "version_not_found" }, 404, cors);
        const cur = await env.PRODUCTS.get(KV_KEY);
        await pushHistory(env, cur, "перед откатом");
        await env.PRODUCTS.put(KV_KEY, bak);
        await triggerRebuild(env);
        return json({ success: true, catalog: JSON.parse(bak) }, 200, cors);
      }

      return json({ error: "not_found" }, 404, cors);
    } catch (e) {
      return json({ error: "server_error", detail: String(e) }, 500, cors);
    }
  },
};

// ----------------------------------------------------------------------
function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ok = allowed.includes(origin) || allowed.includes("*");
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...(cors || {}), "Content-Type": "application/json" },
  });
}

// Резервная копия текущего каталога в историю (для обратимости изменений).
// Храним последние KEEP версий; каждая версия живёт 30 дней.
async function pushHistory(env, catalogRaw, note) {
  if (!catalogRaw) return;
  const KEEP = 15;
  const ts = Date.now();
  let count = 0;
  try { count = (JSON.parse(catalogRaw).products || []).length; } catch {}
  await env.PRODUCTS.put(`cat:hist:${ts}`, catalogRaw, { expirationTtl: 60 * 60 * 24 * 30 });
  let idx = [];
  try { idx = JSON.parse((await env.PRODUCTS.get("cat:hist:index")) || "[]"); } catch {}
  idx.unshift({ ts, count, note: note || "" });
  const drop = idx.slice(KEEP);
  idx = idx.slice(0, KEEP);
  await env.PRODUCTS.put("cat:hist:index", JSON.stringify(idx));
  for (const d of drop) { try { await env.PRODUCTS.delete(`cat:hist:${d.ts}`); } catch {} }
}

function authorized(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return env.ADMIN_TOKEN && token && safeEqual(token, env.ADMIN_TOKEN);
}

// Сравнение строк с защитой от тайминг-атак
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ======================================================================
// SIM: канонизация и разбор на ортогональные признаки.
// ДЕРЖАТЬ ИДЕНТИЧНЫМ src/js/config.js — фронтенд и бэкенд обязаны понимать
// комплектации одинаково, иначе клиентская и серверная выборка разойдутся.
// ======================================================================
function normSim(s) {
  if (s == null) return "";
  const v = String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const low = v.toLowerCase();
  if (low === "" || low === "—" || low === "-" || low === "нет") return "";
  // «2 SIM + eSIM» проверяем ПЕРВЫМ: иначе «2x Nano-SIM + eSIM» совпадёт
  // как одиночный «SIM + eSIM» либо как «2 eSIM».
  if (/2\s*x?\s*(nano-?sim|physical\s*sim|sim)s?\s*\+\s*e-?sim|dual\s*sim\s*\+\s*e-?sim/.test(low)) return "2 SIM + eSIM";
  if (/2\s*e-?sim|dual\s*e-?sim|двойн\w*\s*e-?sim/.test(low)) return "2 eSIM";
  if (/(physical|nano|sim)\s*\+\s*e-?sim|sim\s*\+\s*e-?sim/.test(low)) return "SIM + eSIM";
  if (/2\s*x?\s*(nano-?sim|physical\s*sim|sim)s?\b|dual\s*sim/.test(low)) return "2 SIM";
  if (/^e-?sim$/.test(low)) return "eSIM";
  if (/physical\s*sim|nano-?sim|^sim$/.test(low)) return "SIM";
  return v;
}

function simInfo(s) {
  switch (normSim(s)) {
    case "SIM": return { slots: 1, esim: false };
    case "eSIM": return { slots: 0, esim: true };
    case "SIM + eSIM": return { slots: 1, esim: true };
    case "2 eSIM": return { slots: 0, esim: true };
    case "2 SIM": return { slots: 2, esim: false };
    case "2 SIM + eSIM": return { slots: 2, esim: true };
    default: return { slots: 0, esim: false };
  }
}

// Приводим sim к канонической метке ПРИ ЗАПИСИ, чтобы в KV не попадали «сырые»
// строки поставщика («2x Nano-SIM + eSIM», «Dual SIM»).
function canonicalizeSim(products) {
  for (const p of products || []) {
    if (p && "sim" in p) p.sim = normSim(p.sim) || "—";
  }
  return products;
}

// Серверная выборка. Все условия по И; simSlots и esim независимы, поэтому
// «2 слота» + «есть eSIM» вместе дают именно версии .../DS.
function filterProducts(products, q) {
  // Скрытые не отдаём наружу даже по прямому запросу с фильтрами.
  products = (products || []).filter((p) => !p.hidden);
  const eq = (key, field) => {
    const want = q.get(key);
    return want ? (p) => String(p[field] ?? "") === want : null;
  };
  const tests = [
    eq("category", "category"), eq("series", "series"), eq("storage", "storage"),
    eq("watchSize", "watchSize"), eq("color", "color"), eq("region", "region"),
  ].filter(Boolean);

  const slotsRaw = q.get("simSlots");
  if (slotsRaw) {
    const want = slotsRaw.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n));
    if (want.length) tests.push((p) => want.includes(simInfo(p.sim).slots));
  }
  const esimRaw = q.get("esim");
  if (esimRaw === "1" || esimRaw === "true") tests.push((p) => simInfo(p.sim).esim);

  return products.filter((p) => tests.every((t) => t(p)));
}

// ----------------------------------------------------------------------
async function verifyTurnstile(token, env, ip) {
  // Если секрет не задан — проверку пропускаем (совместимость с офлайн/демо).
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const out = await r.json();
    return !!out.success;
  } catch {
    return false;
  }
}

// Rate limit через KV: не более LIMIT заявок с одного IP за WINDOW секунд.
async function rateLimited(env, ip) {
  if (!env.PRODUCTS || !ip) return false;
  const LIMIT = 3, WINDOW = 900;
  const key = `rl:${ip}`;
  const cur = parseInt((await env.PRODUCTS.get(key)) || "0", 10);
  if (cur >= LIMIT) return true;
  await env.PRODUCTS.put(key, String(cur + 1), { expirationTtl: WINDOW });
  return false;
}

// ==== Telegram helpers ================================================

// Нормализуем телефон в стабильный ключ: только цифры, последние 15.
function normPhone(p) {
  return String(p || "").replace(/\D/g, "").slice(-15);
}

// Универсальный вызов Telegram Bot API. Возвращает разобранный JSON.
async function tgCall(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Инлайн-клавиатура под заявкой. status ∈ new|active|closed|refused|blocked.
// В callback_data: 2-буквенный код действия + ":" + нормализованный телефон.
function leadKeyboard(phone, status) {
  if (status === "blocked") {
    return { inline_keyboard: [[{ text: "✅ Разблокировать", callback_data: `ub:${phone}` }]] };
  }
  const mark = (s, label) => (status === s ? `${label} ✓` : label);
  return {
    inline_keyboard: [
      [
        { text: mark("active", "🟢 В работе"), callback_data: `sa:${phone}` },
        { text: mark("closed", "✅ Закрыт"), callback_data: `sc:${phone}` },
        { text: mark("refused", "🚫 Отказ"), callback_data: `sr:${phone}` },
      ],
      [
        { text: "⛔ Блокировать", callback_data: `bl:${phone}` },
        { text: "🗑 Удалить спам", callback_data: `dl:${phone}` },
      ],
    ],
  };
}

// Запоминаем сообщение лида: исходный текст (для смены статуса) и связь с телефоном
// (чтобы «Удалить спам» мог снести все сообщения этого номера).
async function rememberLeadMessage(env, chatId, msgId, text, phone) {
  try {
    await env.PRODUCTS.put(
      `tg:lead:${chatId}:${msgId}`,
      JSON.stringify({ text, phone }),
      { expirationTtl: 60 * 60 * 24 * 60 }
    );
    let list = [];
    try { list = JSON.parse((await env.PRODUCTS.get(`tg:msgs:${phone}`)) || "[]"); } catch {}
    list.push({ c: chatId, m: msgId });
    if (list.length > 200) list = list.slice(-200);
    await env.PRODUCTS.put(`tg:msgs:${phone}`, JSON.stringify(list), { expirationTtl: 60 * 60 * 24 * 60 });
  } catch {}
}

async function handleLead(request, env, cors) {
  const data = await request.json().catch(() => null);
  // Имя не обязательно: чем меньше полей, тем больше заявок. Достаточно
  // телефона — по нему оператор и перезванивает.
  if (!data || !data.phone) {
    return json({ success: false, error: "phone_required" }, 400, cors);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const np = normPhone(data.phone);

  // Заблокированный номер: молча «принимаем» заявку (сайт покажет успех),
  // но оператору ничего не шлём — чтобы спамер не понял, что он в бане.
  if (np && env.PRODUCTS) {
    try {
      if (await env.PRODUCTS.get(`tg:block:${np}`)) {
        return json({ success: true, ok: true }, 200, cors);
      }
    } catch {}
  }

  if (await rateLimited(env, ip)) {
    return json({ success: false, error: "rate_limited", message: "Слишком много заявок. Попробуйте через минуту." }, 429, cors);
  }

  const ok = await verifyTurnstile(data.turnstileToken, env, ip);
  if (!ok) {
    return json({ success: false, error: "captcha_failed" }, 403, cors);
  }

  // Мягкая защита от спама: длина полей
  const name = String(data.name || "").slice(0, 120);
  const phone = String(data.phone).slice(0, 40);
  const comment = String(data.comment || "").slice(0, 1000);
  const product = String(data.product || "—").slice(0, 200);
  const price = String(data.price || "—").slice(0, 60);

  const text =
    `🛒 <b>Новая заявка с сайта</b>\n\n` +
    `📱 <b>Товар:</b> ${escapeHtml(product)}\n` +
    `💰 <b>Цена:</b> ${escapeHtml(price)}\n` +
    (name ? `👤 <b>Имя:</b> ${escapeHtml(name)}\n` : "") +
    `📞 <b>Телефон:</b> ${escapeHtml(phone)}\n` +
    (comment ? `💬 <b>Комментарий:</b> ${escapeHtml(comment)}\n` : "") +
    `\n🔗 ${escapeHtml(data.page || "")}`;

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return json({ error: "telegram_not_configured" }, 500, cors);
  }

  const res = await tgCall(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: leadKeyboard(np, "new"),
  });

  if (!res || !res.ok) {
    return json({ success: false, error: "telegram_failed", detail: res && res.description }, 502, cors);
  }

  const m = res.result;
  if (m && m.chat && np) {
    await rememberLeadMessage(env, m.chat.id, m.message_id, text, np);
  }

  return json({ success: true, ok: true }, 200, cors);
}

// ==== Telegram webhook: обработка нажатий кнопок ======================
async function handleTgWebhook(request, env) {
  if (env.TG_WEBHOOK_SECRET) {
    const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!safeEqual(got, env.TG_WEBHOOK_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }
  }

  const update = await request.json().catch(() => null);

  // Обычные сообщения: приём прайса ФОРВАРДАМИ. Нужно потому, что канал
  // поставщика приватный — веб-превью t.me/s/<channel> у закрытых каналов
  // не существует, и скрейпить нечего. Оператор пересылает сообщения с
  // прайсом боту, бот их разбирает.
  if (update && update.message) {
    return await handlePriceMessage(update.message, env);
  }

  const cq = update && update.callback_query;
  if (!cq || !cq.data) return new Response("ok");

  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const msgId = cq.message && cq.message.message_id;
  const action = String(cq.data).slice(0, 2);
  const phone = String(cq.data).slice(3);

  // Исходный текст заявки (без строки статуса) — чтобы статус не «накапливался».
  let baseText = (cq.message && (cq.message.text || cq.message.caption)) || "";
  try {
    const saved = await env.PRODUCTS.get(`tg:lead:${chatId}:${msgId}`);
    if (saved) baseText = JSON.parse(saved).text || baseText;
  } catch {}

  const answer = (t) => tgCall(env, "answerCallbackQuery", { callback_query_id: cq.id, text: t || "" });

  const setStatus = async (statusKey) => {
    const label = STATUS_LABEL[statusKey] || "";
    const newText = baseText + (label ? `\n\n<b>Статус:</b> ${label}` : "");
    await tgCall(env, "editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: newText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: leadKeyboard(phone, statusKey),
    });
  };

  try {
    if (action === "sa") { await setStatus("active"); await answer("Отмечено: в работе"); }
    else if (action === "sc") { await setStatus("closed"); await answer("Отмечено: закрыт"); }
    else if (action === "sr") { await setStatus("refused"); await answer("Отмечено: отказ"); }
    else if (action === "bl") {
      if (phone) await env.PRODUCTS.put(`tg:block:${phone}`, "1", { expirationTtl: 60 * 60 * 24 * 365 });
      await setStatus("blocked");
      await answer("Номер заблокирован — новые заявки с него не придут");
    } else if (action === "ub") {
      if (phone) await env.PRODUCTS.delete(`tg:block:${phone}`);
      await tgCall(env, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: baseText,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: leadKeyboard(phone, "new"),
      });
      await answer("Номер разблокирован");
    } else if (action === "dl") {
      let list = [];
      try { list = JSON.parse((await env.PRODUCTS.get(`tg:msgs:${phone}`)) || "[]"); } catch {}
      let n = 0;
      for (const it of list) {
        const r = await tgCall(env, "deleteMessage", { chat_id: it.c, message_id: it.m });
        if (r && r.ok) n++;
        try { await env.PRODUCTS.delete(`tg:lead:${it.c}:${it.m}`); } catch {}
      }
      await tgCall(env, "deleteMessage", { chat_id: chatId, message_id: msgId });
      try { await env.PRODUCTS.delete(`tg:msgs:${phone}`); } catch {}
      await answer(`Удалено сообщений: ${n}`);
    } else {
      await answer();
    }
  } catch (e) {
    await answer("Ошибка: " + String(e).slice(0, 80));
  }

  return new Response("ok");
}

// ----------------------------------------------------------------------
async function handleUpdate(request, env, cors) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.changes)) {
    return json({ error: "bad_changes" }, 400, cors);
  }
  const raw = await env.PRODUCTS.get(KV_KEY);
  if (!raw) return json({ error: "catalog_not_seeded" }, 409, cors);

  const catalog = JSON.parse(raw);
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  let applied = 0;

  for (const ch of body.changes) {
    const p = byId.get(ch.id);
    if (!p) continue;
    if (Number.isFinite(ch.priceCash)) p.priceCash = Math.max(0, Math.round(ch.priceCash));
    if (Number.isFinite(ch.priceCard)) p.priceCard = Math.max(0, Math.round(ch.priceCard));
    if (ch.status === "in_stock" || ch.status === "on_order") p.status = ch.status;
    // Комплектация и регион тоже правятся из CRM — канонизируем на входе.
    if (typeof ch.sim === "string" && ch.sim.trim()) p.sim = normSim(ch.sim) || "—";
    if (typeof ch.region === "string") p.region = ch.region.trim();
    applied++;
  }

  if (catalog.meta) catalog.meta.updatedAt = new Date().toISOString().slice(0, 10);
  await env.PRODUCTS.put(KV_KEY, JSON.stringify(catalog));
  await triggerRebuild(env);
  return json({ ok: true, applied }, 200, cors);
}

// ======================================================================
// Синхронизация прайса из Telegram.
// ВАЖНО: cron НЕ пишет цены в каталог. Прайс берётся скрейпингом HTML-страницы
// t.me; одна ошибка разбора опубликовала бы неверную цену на живой витрине.
// Поэтому cron готовит ПРЕДЛОЖЕНИЯ, а применяет их человек через
// POST /api/admin/tg-apply со списком ids (страница /prices.html).
// ======================================================================
async function runTgSync(env, cronExpr, channelOverride, pagesOverride) {
  const startedAt = new Date().toISOString();
  const channel = channelOverride || env.TG_PRICE_CHANNEL || "OPTMSK77";
  const pages = Math.max(1, Math.min(30, parseInt(pagesOverride || env.TG_PRICE_PAGES || "5", 10) || 5));
  const log = { startedAt, cron: cronExpr || null, channel, pages, ok: false };

  try {
    // Каталог проверяем ПЕРВЫМ: без него сопоставлять не с чем, а чтение канала
    // это 5 HTTP-запросов. Раньше они делались впустую при каждом прогоне.
    const rawCat = await env.PRODUCTS.get(KV_KEY);
    if (!rawCat) throw new Error("catalog_not_seeded — сначала залейте каталог через /admin.html");
    const catalog = JSON.parse(rawCat);

    const { offers, messages, pagesRead } = await fetchAndParseTgChannel(channel, pages);
    log.messages = messages;
    log.pagesRead = pagesRead;

    // Пустой результат — ОШИБКА, а не успех: иначе затрём валидный прайс.
    if (!offers.length) {
      throw new Error(`0 позиций с t.me/s/${channel} — канал закрыт, выключено веб-превью или изменилась вёрстка`);
    }

    const result = buildProposals(offers, catalog);

    await env.PRODUCTS.put(TG_PRICES_KEY, JSON.stringify(offers));

    // Перезапись предложений затирает набор, который оператор может разбирать
    // прямо сейчас (галочки и ручные правки живут на странице). Поэтому если
    // предложения не изменились по сути — оставляем прежние и только обновляем
    // отметку времени. Сравниваем по составу id+цена, а не по всему JSON:
    // builtAt меняется всегда и сравнение стало бы бессмысленным.
    const fingerprint = (props) =>
      (props || []).map((x) => `${x.id}:${x.retail}`).sort().join("|");
    let prevPrint = "";
    try {
      const prevRaw = await env.PRODUCTS.get(TG_PROPOSALS_KEY);
      if (prevRaw) prevPrint = fingerprint(JSON.parse(prevRaw).proposals);
    } catch {}

    if (prevPrint && prevPrint === fingerprint(result.proposals)) {
      log.unchanged = true;
      console.log(`[tg-sync] прайс не изменился — предложения оставлены как есть`);
    } else {
      await env.PRODUCTS.put(TG_PROPOSALS_KEY, JSON.stringify({
        builtAt: new Date().toISOString(), channel, pagesRead, ...result,
      }));
    }

    log.ok = true;
    log.stats = result.stats;
    log.finishedAt = new Date().toISOString();
    console.log(`[tg-sync] ok ${channel}: ${JSON.stringify(result.stats)}`);

    // Мало сопоставилось — первый признак, что у поставщика сменился формат.
    if (result.stats.parsed > 10 && result.stats.matchedLines / result.stats.parsed < 0.5) {
      await notifyOperator(env, `⚠️ Прайс @${channel}: сопоставлено ${result.stats.matchedLines} строк из ${result.stats.parsed}. Проверьте /prices.html`, "lowmatch");
    }
  } catch (e) {
    log.error = String((e && e.message) || e).slice(0, 500);
    log.finishedAt = new Date().toISOString();
    console.error(`[tg-sync] FAIL (${channel}): ${log.error}`);
    await notifyOperator(env, `❌ Синхронизация прайса @${channel} упала: ${log.error}`, "fail:" + log.error.slice(0, 60));
  }

  try { await env.PRODUCTS.put(TG_SYNC_LOG_KEY, JSON.stringify(log)); } catch {}
  return log;
}

// Молча падающий cron — худший вариант: он выглядит работающим.
// dedupeKey — если передан, одинаковое сообщение не повторяется чаще, чем раз
// в NOTIFY_COOLDOWN. При cron раз в 30 минут одна и та же поломка иначе даёт
// 48 сообщений в сутки, и оператор перестаёт их читать.
const NOTIFY_COOLDOWN = 6 * 60 * 60 * 1000; // 6 часов

async function notifyOperator(env, text, dedupeKey) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  if (dedupeKey) {
    const k = `tg:notify:${dedupeKey}`;
    try {
      const last = await env.PRODUCTS.get(k);
      if (last && Date.now() - Number(last) < NOTIFY_COOLDOWN) return;
      await env.PRODUCTS.put(k, String(Date.now()), { expirationTtl: 60 * 60 * 24 });
    } catch {}
  }

  try {
    await tgCall(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true });
  } catch {}
}

// Применение выбранных предложений. Режима «применить всё» намеренно нет:
// оператор должен видеть, что именно применяет.
async function handleTgApply(request, env, cors) {
  const body = await request.json().catch(() => null);
  const ids = body && Array.isArray(body.ids) ? body.ids : null;
  if (!ids || !ids.length) {
    return json({ success: false, error: "ids_required" }, 400, cors);
  }

  const rawProp = await env.PRODUCTS.get(TG_PROPOSALS_KEY);
  if (!rawProp) return json({ success: false, error: "no_proposals" }, 409, cors);
  const stored = JSON.parse(rawProp);

  const rawCat = await env.PRODUCTS.get(KV_KEY);
  if (!rawCat) return json({ success: false, error: "catalog_not_seeded" }, 409, cors);

  // Бэкап до записи — цены откатываются через /api/admin/restore.
  await pushHistory(env, rawCat, `перед применением прайса (${ids.length})`);

  const overrides = body && body.prices && typeof body.prices === "object" ? body.prices : null;
  const ratio = Number(env.CARD_RATIO) > 1 ? Number(env.CARD_RATIO) : 1.15;
  const { catalog: next, applied, rejected } = applyProposals(
    JSON.parse(rawCat), stored.proposals || [], ids, overrides, ratio
  );
  await env.PRODUCTS.put(KV_KEY, JSON.stringify(next));
  await triggerRebuild(env);

  const appliedSet = new Set(ids);
  const rest = (stored.proposals || []).filter((p) => !appliedSet.has(p.id));
  await env.PRODUCTS.put(TG_PROPOSALS_KEY, JSON.stringify({ ...stored, proposals: rest }));

  return json({ success: true, applied, rejected, remaining: rest.length }, 200, cors);
}

// ======================================================================
// Чтение канала через веб-превью t.me (бот и админ-права НЕ нужны).
//
// ГЛУБИНА ИСТОРИИ: одна страница t.me/s/<channel> отдаёт примерно 16–20
// последних сообщений. Чтобы уйти глубже, страница запрашивается с параметром
// ?before=<id>, где id — номер самого старого сообщения текущей страницы.
// Номер берётся из атрибута data-post="<channel>/<id>". Глубину задаёт
// TG_PRICE_PAGES (по умолчанию 5 ≈ 80–100 сообщений).
//
// Что стоит знать:
//   • страницы читаются последовательно, каждая — отдельный HTTP-запрос,
//     поэтому глубина стоит времени (у воркера ограничен CPU на запрос);
//   • обход прекращается, если страница не дала нового id — значит дошли до
//     начала канала либо изменилась вёрстка. Бесконечного цикла не будет;
//   • превью отдаёт ТЕКУЩУЮ версию сообщения, поэтому отредактированные
//     поставщиком цены подтянутся сами при следующем проходе.
// ======================================================================
async function fetchOnePage(channel, before) {
  const url = `https://t.me/s/${encodeURIComponent(channel)}${before ? `?before=${before}` : ""}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} на ${url}`);

  const messages = [];
  const ids = [];
  let buf = "";

  const rewriter = new HTMLRewriter()
    // Номера постов нужны для пагинации: data-post="channel/12345"
    .on(".tgme_widget_message", {
      element(el) {
        const dp = el.getAttribute("data-post");
        if (dp) {
          const n = parseInt(String(dp).split("/").pop(), 10);
          if (!isNaN(n)) ids.push(n);
        }
      },
    })
    .on(".tgme_widget_message_text", {
      element(el) {
        buf = "";
        el.onEndTag(() => {
          if (buf.trim()) messages.push(buf.trim());
        });
      },
      text(t) { buf += t.text; },
    })
    // В превью переводы строк — это <br>, иначе прайс склеится в одну строку.
    .on(".tgme_widget_message_text br", {
      element() { buf += "\n"; },
    });

  await rewriter.transform(res).text();
  return { messages, minId: ids.length ? Math.min(...ids) : null };
}

async function fetchAndParseTgChannel(channel = "OPTMSK77", maxPages = 5) {
  const allMessages = [];
  let before = null;
  let pagesRead = 0;
  const seenIds = new Set();

  for (let i = 0; i < maxPages; i++) {
    const { messages, minId } = await fetchOnePage(channel, before);
    pagesRead++;
    allMessages.push(...messages);
    if (minId == null || seenIds.has(minId)) break;
    seenIds.add(minId);
    before = minId;
  }

  return { offers: parseMessages(allMessages), messages: allMessages.length, pagesRead };
}

// Разбор набора сообщений в позиции прайса. Вынесено отдельно, потому что
// используется двумя путями: чтением канала и ручной вставкой текста.

// Ручная вставка прайса. Тот же разбор, сопоставление и проверки, что у cron —
// отличается только источником текста.
async function handleTgPaste(request, env, cors) {
  const body = await request.json().catch(() => null);
  const text = body && typeof body.text === "string" ? body.text : "";
  if (text.trim().length < 20) {
    return json({ success: false, error: "empty_text", hint: "вставьте текст прайса" }, 400, cors);
  }

  const rawCat = await env.PRODUCTS.get(KV_KEY);
  if (!rawCat) return json({ success: false, error: "catalog_not_seeded" }, 409, cors);

  // Текст приходит одним куском; разбиваем на «сообщения» по пустым строкам,
  // чтобы заголовки категорий работали так же, как при чтении канала.
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const offers = parseMessages(blocks.length ? blocks : [text]);

  if (!offers.length) {
    return json({ success: false, error: "nothing_parsed", hint: "ни одной строки с ценой не распознано" }, 422, cors);
  }

  const result = buildProposals(offers, JSON.parse(rawCat));
  await env.PRODUCTS.put(TG_PRICES_KEY, JSON.stringify(offers));
  await env.PRODUCTS.put(TG_PROPOSALS_KEY, JSON.stringify({
    builtAt: new Date().toISOString(), channel: "вставлено вручную", ...result,
  }));
  await env.PRODUCTS.put(TG_SYNC_LOG_KEY, JSON.stringify({
    startedAt: new Date().toISOString(), cron: null, channel: "вставлено вручную",
    ok: true, stats: result.stats, finishedAt: new Date().toISOString(),
  }));

  return json({ success: true, ...result.stats }, 200, cors);
}

// ======================================================================
// Приём прайса форвардами в Telegram.
//
// Почему так, а не скрейпингом: канал поставщика закрытый. У приватных каналов
// публичной веб-страницы t.me/s/<channel> нет, поэтому прежний путь возвращал
// 0 позиций. Здесь оператор пересылает сообщения боту — ни админ-прав в канале,
// ни участия бота в нём не требуется.
//
// ДОСТУП: только с user id из TG_PRICE_SENDERS (список через запятую). Если
// переменная пуста, приём выключен целиком — иначе любой, кто найдёт бота, смог
// бы подменить цены в каталоге. Узнать свой id: команда /id.
//
// КАК РАБОТАЕТ НАКОПЛЕНИЕ: поставщик присылает прайс пачкой сообщений (по
// одному на серию). Каждый форвард дописывается в буфер, и предложения
// пересобираются по ВСЕМУ буферу — так строки из разных сообщений видят друг
// друга при дедупликации. Буфер живёт BUFFER_TTL и начинается заново, если
// между форвардами прошло больше BUFFER_GAP: пачку за новый день не надо
// смешивать с прошлой.
//
// Команды (только для разрешённых отправителей):
//   /id     — показать свой user id и id чата (для настройки)
//   /reset  — очистить буфер и начать пачку заново
//   /status — что сейчас в буфере и что получилось сопоставить
// ======================================================================
const TG_BUFFER_KEY = "tg_price_buffer";
const BUFFER_TTL = 60 * 60 * 24 * 3;      // 3 суток
const BUFFER_GAP = 3 * 60 * 60 * 1000;    // 3 часа — признак новой пачки
const BUFFER_MAX = 200 * 1024;            // защита от случайной простыни

function priceSenders(env) {
  return String(env.TG_PRICE_SENDERS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function handlePriceMessage(msg, env) {
  const ok = () => new Response("ok");
  const from = msg.from && msg.from.id;
  const chatId = msg.chat && msg.chat.id;
  const text = msg.text || msg.caption || "";
  if (!chatId) return ok();

  const reply = async (t) => {
    await tgCall(env, "sendMessage", {
      chat_id: chatId,
      text: t,
      reply_parameters: { message_id: msg.message_id },
      disable_web_page_preview: true,
    });
  };

  // /id отвечаем всем: без него невозможно узнать, что вписать в
  // TG_PRICE_SENDERS. Ничего чувствительного команда не раскрывает —
  // свой собственный id отправитель и так может увидеть в любом боте.
  if (/^\/id\b/.test(text)) {
    await reply(`Ваш user id: ${from}\nid этого чата: ${chatId}\n\nВпишите user id в переменную TG_PRICE_SENDERS у воркера.`);
    return ok();
  }

  const allowed = priceSenders(env);
  if (!allowed.length) {
    // Молчим, а не объясняем: неизвестному собеседнику незачем знать,
    // что у бота вообще есть приём прайса.
    return ok();
  }
  if (!from || !allowed.includes(String(from))) return ok();

  if (/^\/reset\b/.test(text)) {
    await env.PRODUCTS.delete(TG_BUFFER_KEY);
    await reply("Буфер очищен. Пересылайте прайс заново.");
    return ok();
  }

  let buf = null;
  try {
    const raw = await env.PRODUCTS.get(TG_BUFFER_KEY);
    if (raw) buf = JSON.parse(raw);
  } catch {}

  if (/^\/status\b/.test(text)) {
    if (!buf || !buf.chunks || !buf.chunks.length) {
      await reply("Буфер пуст. Перешлите сообщения с прайсом.");
      return ok();
    }
    const st = buf.stats || {};
    await reply(
      `В буфере сообщений: ${buf.chunks.length}\n` +
      `Обновлён: ${new Date(buf.updatedAt).toLocaleString("ru-RU")}\n\n` +
      `Разобрано строк: ${st.parsed ?? "—"}\n` +
      `Сопоставлено: ${st.matchedLines ?? "—"}\n` +
      `Однозначных: ${st.applicable ?? "—"}\n` +
      `Требуют выбора: ${st.ambiguous ?? "—"}\n` +
      `Не сопоставлено: ${st.unmatched ?? "—"}`
    );
    return ok();
  }

  if (!text.trim()) return ok();
  // Служебные команды дальше не идут, чтобы не попасть в буфер как прайс.
  if (text.trim().startsWith("/")) return ok();

  // Новая пачка, если буфера нет или между форвардами был большой перерыв.
  const now = Date.now();
  if (!buf || !buf.chunks || now - (buf.updatedAt || 0) > BUFFER_GAP) {
    buf = { startedAt: now, chunks: [] };
  }

  // Повторный форвард того же сообщения не дублируем: оператор легко
  // пересылает одно и то же дважды, а в прайсе и без того много повторов.
  const origin = msg.forward_origin || {};
  const fid = [
    origin.chat && origin.chat.id,
    origin.message_id,
    origin.date || msg.forward_date || "",
  ].join(":");
  const seen = new Set(buf.chunks.map((c) => c.fid).filter(Boolean));
  if (fid !== "::" && seen.has(fid)) {
    await reply("Это сообщение уже в буфере — пропустил.");
    return ok();
  }

  buf.chunks.push({ fid: fid === "::" ? null : fid, text });
  buf.updatedAt = now;

  // Обрезаем старые куски, если оператор прислал слишком много.
  let total = buf.chunks.reduce((n, c) => n + c.text.length, 0);
  while (total > BUFFER_MAX && buf.chunks.length > 1) {
    total -= buf.chunks.shift().text.length;
  }

  // Разбор всего буфера.
  const catRaw = await env.PRODUCTS.get(KV_KEY);
  if (!catRaw) {
    await reply("Каталог не залит в хранилище — сначала сохраните его из /admin.html.");
    return ok();
  }
  const catalog = JSON.parse(catRaw);

  const offers = parseMessages(buf.chunks.map((c) => c.text));

  if (!offers.length) {
    await reply(
      `В сообщении не нашёл ни одной строки с ценой.\n` +
      `Ожидаю формат вида «iPhone 17 Pro 256GB Silver 🇯🇵 — 97 300».\n` +
      `Сообщений в буфере: ${buf.chunks.length}.`
    );
    await env.PRODUCTS.put(TG_BUFFER_KEY, JSON.stringify(buf), { expirationTtl: BUFFER_TTL });
    return ok();
  }

  const result = buildProposals(offers, catalog);
  buf.stats = result.stats;

  await env.PRODUCTS.put(TG_BUFFER_KEY, JSON.stringify(buf), { expirationTtl: BUFFER_TTL });
  await env.PRODUCTS.put(TG_PRICES_KEY, JSON.stringify(offers));
  await env.PRODUCTS.put(TG_PROPOSALS_KEY, JSON.stringify({
    builtAt: new Date().toISOString(),
    source: "forward",
    messages: buf.chunks.length,
    ...result,
  }));

  const st = result.stats;
  const site = env.SITE_URL || "";
  await reply(
    `Принято. Сообщений в пачке: ${buf.chunks.length}\n\n` +
    `Строк с ценой: ${st.parsed}\n` +
    `Сопоставлено: ${st.matchedLines}\n` +
    `Не сопоставлено: ${st.unmatched}\n\n` +
    `Предложений: ${st.proposals}\n` +
    `  однозначных: ${st.applicable}\n` +
    `  требуют выбора: ${st.ambiguous}\n` +
    `  заблокировано проверками: ${st.blocked}\n\n` +
    `Цены НЕ применены. Проверьте и примените: ${site}/prices.html\n` +
    `Продолжайте пересылать — пересоберу по всей пачке. /reset — начать заново.`
  );
  return ok();
}



// ---------------------------------------------------------------------------
// Пересборка сайта после изменения каталога (repository_dispatch → deploy.yml).
// Без GH_DISPATCH_TOKEN ничего не делает. Ошибка GitHub не мешает сохранению:
// каталог уже записан в KV, а ночная пересборка в deploy.yml всё равно догонит.
// Частые сохранения не страшны — в workflow стоит cancel-in-progress, и
// собирается последняя версия.
// ---------------------------------------------------------------------------
async function triggerRebuild(env) {
  const token = env && env.GH_DISPATCH_TOKEN;
  if (!token) return false;
  const repo = (env.GH_REPO || "DeepBlue2416/DeepBlue2416.github.io").trim();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "appleitochka-worker",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: "catalog-updated" }),
    });
    if (!r.ok) console.log("[rebuild] GitHub ответил", r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) {
    console.log("[rebuild] не удалось:", e && e.message);
    return false;
  } finally {
    clearTimeout(t);
  }
}
