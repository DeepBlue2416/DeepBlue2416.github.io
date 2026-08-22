// config.js — ЕДИНЫЕ НАСТРОЙКИ САЙТА.
// Отредактируйте значения под свой магазин перед деплоем.
// (classic script — работает и при открытии index.html напрямую, без сервера)

var CONFIG = {
  brand: "Apple и точка",
  city: "Таганрог",

  // Базовый адрес сайта (для canonical, sitemap, JSON-LD). БЕЗ завершающего «/».
  siteUrl: "https://appleitochka.ru",

  // Базовый URL Cloudflare Worker (без завершающего /).
  apiBase: "https://api.appleitochka.ru", // <-- Укажите URL вашего воркера
  // Пусто "" -> сайт работает офлайн на встроенном каталоге (data/products.js).

  // Публичный ключ Cloudflare Turnstile (Site Key)
  turnstileSiteKey: "0x4AAAAAAD_YUk6nJXcjmfCm", // <-- Вставьте ваш Site Key (начинается на 0x4...)
  

  // Контакты оператора (FR-4.1)
  contacts: {
    phone: "+7 900 172-36-35",
    phoneHref: "+79001723635",
    telegram: "https://t.me/your_operator",
    whatsapp: "https://wa.me/79001723635",
    vk: "https://vk.ru/appleitochka_tgn",
    max: "https://max.ru/your_account", // мессенджер MAX
  },

  // Города обслуживания (для селектора города в шапке). Первый — по умолчанию.
  cities: ["Таганрог", "Ростов-на-Дону", "Азов", "Батайск"],

  // Ссылки в футере (FR-5.3)
  legal: {
    privacy: "privacy.html",
    offer: "offer.html",
  },

  // ---- Точки продаж + карта (блок «Как нас найти» над футером) ----
  // Координаты можно взять на Яндекс.Картах: правый клик по точке → координаты
  // (Яндекс показывает «широта, долгота»; сюда впишите lat и lon).
  // Карта строится встроенным виджетом Яндекса по координатам — API-ключ НЕ нужен.
  locations: [
    {
      name: "Apple и точка",
      address: "Таганрог, площадь Мира, 7",
      // Координаты необязательны: если пусто — карта сама найдёт точку по адресу.
      // Хотите точный пин и гео в микроразметке — впишите широту/долготу с Яндекс.Карт.
      lat: null,
      lon: null,
      hours: "Ежедневно 10:00–20:00",
    },
    // Добавьте другие точки при необходимости:
    // { name: "Apple и точка — ТЦ …", address: "…", hours: "10:00–21:00" },
  ],
  map: {
    zoom: 15,        // масштаб карты (0–19)
    embedUrl: "",    // (опц.) готовый iframe-URL Яндекс.Конструктора карт; если задан — берётся он
  },

  // ---- Отзывы (блок «О нас пишут») ----
  // Живой парсинг Яндекс/2ГИС со стороны статичного сайта невозможен (нужен их API/виджет,
  // и это против правил площадок). Поэтому: rating/count/featured — витрина (обновляется вручную),
  // либо вставьте официальный виджет отзывов (widgetUrl → iframe площадки, всегда актуален).
  // Виджет: Яндекс Бизнес → «Виджеты» → «Отзывы»; 2ГИС → кабинет партнёра.
  reviews: {
    sources: [
      {
        name: "Яндекс Карты",
        url: "https://yandex.ru/maps/org/191242131381", // карточка организации на Яндекс.Картах
        // Официальный виджет отзывов Яндекс.Карт (iframe) — показывает НАСТОЯЩИЕ, всегда
        // актуальные отзывы прямо с карточки организации. featured пуст → рендерится виджет.
        widgetUrl: "https://yandex.ru/maps-reviews-widget/191242131381?comments",
        rating: "5,0",
        count: "отзывы на Яндекс.Картах",
        featured: [],
      },
    ],
  },

  currency: "₽",
};

window.CONFIG = CONFIG;

// Ретрай загрузки картинок при «холодном старте» (GitHub Pages/сеть ещё не прогреты).
// Вместо мгновенной замены на заглушку по onerror — до 4 повторных попыток с нарастающей
// задержкой и cache-busting. Только если все попытки провалились — показываем глиф-заглушку.
window.imgRetry = function (img) {
  try {
    var n = parseInt(img.getAttribute("data-try") || "0", 10);
    var max = parseInt(img.getAttribute("data-max") || "4", 10);
    var base = img.getAttribute("data-src") || (img.src || "").split("?")[0];
    if (n < max && base) {
      img.setAttribute("data-try", String(n + 1));
      var delay = 200 * Math.pow(2, n); // 200, 400, 800, 1600 мс
      setTimeout(function () { img.src = base + "?r=" + (n + 1); }, delay);
      return;
    }
    img.onerror = null;
    // Финальная заглушка — глиф категории/устройства (если рендерер доступен).
    var box = img.closest && img.closest("[data-glyph]");
    if (box && typeof window.deviceGlyph === "function") {
      box.innerHTML = window.deviceGlyph(
        { category: box.getAttribute("data-glyph") || "accessory", colorHex: "#ffffff" },
        parseInt(box.getAttribute("data-glyph-size") || "96", 10)
      );
    } else {
      img.style.visibility = "hidden";
    }
  } catch (e) {}
};

// Отображаемая метка типа SIM: показываем «SIM» вместо «eSIM» (данные не меняем —
// это только для UI). «2 eSIM» → «2 SIM»; комбинированные («SIM + eSIM») не трогаем.
window.simLabel = function (s) {
  if (s == null) return "";
  var v = String(s);
  if (v.indexOf("+") >= 0) return v;
  return v.replace(/eSIM/g, "SIM");
};

// Канонизация типа SIM (общая для сайта и CRM): схлопывает пробелы/синонимы,
// чтобы не было дублей «2 eSIM / 2 eSIM». Итог: «SIM + eSIM» / «SIM» / «eSIM» / «2 eSIM».
window.normSim = function (s) {
  if (s == null) return "";
  var v = String(s).replace(/ /g, " ").replace(/\s+/g, " ").trim();
  var low = v.toLowerCase();
  if (low === "" || low === "—" || low === "-" || low === "нет") return "";
  if (/2\s*e-?sim|dual\s*e-?sim/.test(low)) return "2 eSIM";
  if (/(physical|nano|sim)\s*\+\s*e-?sim|sim\s*\+\s*e-?sim|dual\s*sim/.test(low)) return "SIM + eSIM";
  if (/^e-?sim$/.test(low)) return "eSIM";
  if (/physical\s*sim|nano-?sim|^sim$/.test(low)) return "SIM";
  return v;
};
