// search.js — Модуль умного поиска (client-side), FR-2.1 … FR-2.5
// Возможности:
//   • Транслитерация кириллицы → латиницы (айфон → iphone)
//   • Исправление опечаток (айфно → iphone) через расстояние Левенштейна
//   • Исправление ошибочной раскладки клавиатуры (fbajy → айфон → iPhone)
//   • Поиск по сочетанию характеристик (16 256 титан)
//   • Живые результаты от 2 символов
//
// Экспорт: SmartSearch.build(products) -> index; index.query(str) -> [{product, score}]

// ------- Таблицы транслитерации кириллица → латиница -------
const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

// ------- Раскладка: латинская клавиша (QWERTY) → кириллица (ЙЦУКЕН) -------
const EN_TO_RU_LAYOUT = {
  q: "й", w: "ц", e: "у", r: "к", t: "е", y: "н", u: "г", i: "ш", o: "щ",
  p: "з", "[": "х", "]": "ъ", a: "ф", s: "ы", d: "в", f: "а", g: "п",
  h: "р", j: "о", k: "л", l: "д", ";": "ж", "'": "э", z: "я", x: "ч",
  c: "с", v: "м", b: "и", n: "т", m: "ь", ",": "б", ".": "ю",
};
// Обратная раскладка: кириллица → латиница
const RU_TO_EN_LAYOUT = Object.fromEntries(
  Object.entries(EN_TO_RU_LAYOUT).map(([en, ru]) => [ru, en])
);

// ------- Словарь синонимов/алиасов -> каноничное английское слово -------
// Ключи хранятся в нормализованном (нижнем) виде: кириллица, транслит, латиница.
const ALIAS = {
  // iPhone
  айфон: "iphone", айфоны: "iphone", афон: "iphone", ayfon: "iphone",
  ajfon: "iphone", iphone: "iphone", "айфончик": "iphone", фон: "iphone",
  // Mac
  мак: "mac", макбук: "macbook", макбуки: "macbook", ноутбук: "macbook",
  ноут: "macbook", mac: "mac", macbook: "macbook", makbuk: "macbook",
  мини: "mini", "мак-мини": "mac",
  // Watch
  часы: "watch", вотч: "watch", эпплвотч: "watch", watch: "watch",
  chasy: "watch", ultra: "ultra", ультра: "ultra",
  // iPad
  айпад: "ipad", планшет: "ipad", ipad: "ipad", ajpad: "ipad", айпэд: "ipad",
  // AirPods
  наушники: "airpods", эйрподс: "airpods", аирподс: "airpods",
  airpods: "airpods", наушник: "airpods", ерподс: "airpods",
  // Аксессуары
  аксессуары: "accessory", аксессуар: "accessory", чехол: "accessory",
  кабель: "cable", зарядка: "charger", зарядное: "charger",
  // Материалы/цвета/термины
  титан: "titan", титановый: "titan", titan: "titan", про: "pro", pro: "pro",
  макс: "max", max: "max",
};

// ------- Утилиты -------
function lower(s) {
  return (s || "").toString().toLowerCase().trim();
}

function translit(s) {
  return lower(s)
    .split("")
    .map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch))
    .join("");
}

function layoutEnToRu(s) {
  return lower(s)
    .split("")
    .map((ch) => EN_TO_RU_LAYOUT[ch] ?? ch)
    .join("");
}

function layoutRuToEn(s) {
  return lower(s)
    .split("")
    .map((ch) => RU_TO_EN_LAYOUT[ch] ?? ch)
    .join("");
}

// Расстояние Левенштейна (с учётом транспозиций — Дамерау)
function editDistance(a, b) {
  a = a || "";
  b = b || "";
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // транспозиция
      }
    }
  }
  return d[m][n];
}

const ALIAS_KEYS = Object.keys(ALIAS);

// Каноникализация одного токена: возвращает единое латинское представление.
function canon(tokenRaw) {
  const t = lower(tokenRaw);
  if (!t) return "";
  // прямые кандидаты
  const candidates = [
    t,
    translit(t),
    layoutEnToRu(t),
    translit(layoutEnToRu(t)),
    layoutRuToEn(t),
  ];
  for (const c of candidates) {
    if (ALIAS[c]) return ALIAS[c];
  }
  // фаззи-поиск по ключам алиасов (опечатки: айфно, iphon, ...)
  let best = null, bestD = Infinity;
  const probes = [t, translit(t), layoutEnToRu(t)];
  for (const p of probes) {
    if (p.length < 3) continue;
    for (const key of ALIAS_KEYS) {
      if (Math.abs(key.length - p.length) > 2) continue;
      const dist = editDistance(p, key);
      if (dist < bestD) {
        bestD = dist;
        best = key;
      }
    }
  }
  const tol = t.length <= 4 ? 1 : 2;
  if (best && bestD <= tol) return ALIAS[best];

  // по умолчанию — транслит (латиница остаётся как есть)
  return translit(t);
}

function tokenize(s) {
  return lower(s)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

// ------- Построение индекса -------
export const SmartSearch = {
  build(products) {
    const docs = products.map((p) => {
      const fields = [
        p.name, p.category, p.generation, p.storage, p.color, p.sim,
        ...(p.specs ? Object.values(p.specs) : []),
      ].join(" ");
      const bag = tokenize(fields).map(canon).filter(Boolean);
      return {
        product: p,
        bag: Array.from(new Set(bag)),
        title: `${p.name} ${p.storage} ${p.color}`.trim(),
      };
    });

    return {
      // возвращает массив {product, score} по убыванию релевантности
      query(str, limit = 8) {
        const raw = lower(str);
        if (raw.length < 2) return [];
        const qTokens = tokenize(raw).map(canon).filter(Boolean);
        if (!qTokens.length) return [];

        const results = [];
        for (const doc of docs) {
          let score = 0;
          let matchedAll = true;
          for (const qt of qTokens) {
            let tokenScore = 0;
            const numeric = /^\d+$/.test(qt); // числа сравниваем строго (16, 256)
            for (const bt of doc.bag) {
              if (bt === qt) { tokenScore = Math.max(tokenScore, 100); }
              else if (numeric) {
                // для чисел: совпадение только если токен товара начинается с запроса
                if (bt.startsWith(qt)) tokenScore = Math.max(tokenScore, 80);
              }
              else if (bt.startsWith(qt) || qt.startsWith(bt)) {
                tokenScore = Math.max(tokenScore, 70);
              } else if (qt.length >= 3 && bt.includes(qt)) {
                tokenScore = Math.max(tokenScore, 50);
              } else if (!numeric) {
                const dist = editDistance(qt, bt);
                const tol = qt.length <= 4 ? 1 : 2;
                if (dist <= tol) tokenScore = Math.max(tokenScore, 40 - dist * 5);
              }
            }
            if (tokenScore === 0) { matchedAll = false; break; }
            score += tokenScore;
          }
          if (matchedAll) {
            // бонус за наличие товара
            if (doc.product.status === "in_stock") score += 5;
            results.push({ product: doc.product, score });
          }
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
      },
    };
  },

  // экспорт утилит для отладки/тестов
  _utils: { translit, layoutEnToRu, layoutRuToEn, canon, editDistance, tokenize },
};

if (typeof window !== "undefined") window.SmartSearch = SmartSearch;
