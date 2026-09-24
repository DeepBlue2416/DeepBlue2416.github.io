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

export { parseLine, parseMessages, extractStorage, extractModelCode, extractSimToken, KNOWN_COLORS };
