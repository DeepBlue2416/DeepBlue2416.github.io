// config.js — ЕДИНЫЕ НАСТРОЙКИ САЙТА.
// Отредактируйте значения под свой магазин перед деплоем.
// (classic script — работает и при открытии index.html напрямую, без сервера)

var CONFIG = {
  brand: "Apple и точка",
  city: "Таганрог",
  // Юридические реквизиты продавца. Подставляются в подвал и в политику
  // при сборке (scripts/build.js → substituteContacts).
  legal: {
    entity: "ИП Саглаева Людмила Михайловна",
    inn: "614347387393",
    ogrnip: "322080000014729",
    address: "Таганрог, площадь Мира, 7, ТЦ «Мармелад», 1 этаж",
  },

  // Базовый адрес сайта (для canonical, sitemap, JSON-LD). БЕЗ завершающего «/».
  siteUrl: "https://appleitochka.ru",

  // Базовый URL Cloudflare Worker (без завершающего /).
  apiBase: "https://api.appleitochka.ru", // <-- Укажите URL вашего воркера
  // Пусто "" -> сайт работает офлайн на встроенном каталоге (data/products.js).

  // Номер счётчика Яндекс.Метрики. Пусто — код счётчика в страницы НЕ
  // вставляется (удобно для локальной разработки: свои визиты не портят
  // статистику). Вставляется при сборке, см. scripts/build.js.
  // Онлайн-калькулятор Trade-In. Выключен: оценка не учитывала состояние
  // устройства и расходилась с реальной в магазине. Включать только после
  // того, как в trade-in.js появятся коэффициенты по состоянию и примеры.
  tradeInCalculator: false,

  metrikaId: "112725950",

  // Публичный ключ Cloudflare Turnstile (Site Key)
  turnstileSiteKey: "0x4AAAAAAD_YUk6nJXcjmfCm", // <-- Вставьте ваш Site Key (начинается на 0x4...)
  

  // Контакты оператора (FR-4.1)
  contacts: {
    phone: "+7 989 536-06-84",
    phoneHref: "+79895360684",
    telegram: "https://t.me/aleksandr_tgn",   // без @: t.me/@user — нерабочая форма
    whatsapp: "https://wa.me/79895360684",
    vk: "https://vk.ru/appleitochka_tgn",
    // max: "https://max.ru/<аккаунт>",  // мессенджер MAX — заглушка убрана,
    //                                   // раскомментируйте, вписав реальный аккаунт
  },

  // Города обслуживания (для селектора города в шапке). Первый — по умолчанию.
  cities: ["Таганрог", "Ростов-на-Дону", "Азов", "Батайск"],

  // Ссылки в футере (FR-5.3)
  legal: {
    privacy: "privacy.html",
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
  var v = String(s).replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
  var low = v.toLowerCase();
  if (low === "" || low === "\u2014" || low === "-" || low === "\u043D\u0435\u0442") return "";
  // 2 \u0444\u0438\u0437\u0438\u0447\u0435\u0441\u043A\u0438\u0445 \u0441\u043B\u043E\u0442\u0430 (Nano-SIM) + eSIM \u2014 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u043C \u041F\u0415\u0420\u0412\u042B\u041C, \u0438\u043D\u0430\u0447\u0435 \u0441\u043E\u0432\u043F\u0430\u0434\u0451\u0442
  // \u043A\u0430\u043A \u00ABSIM + eSIM\u00BB (\u043E\u0434\u0438\u043D\u043E\u0447\u043D\u044B\u0439) \u0438\u043B\u0438 \u043A\u0430\u043A \u00AB2 eSIM\u00BB (\u0434\u0432\u0430 eSIM \u0431\u0435\u0437 \u0444\u0438\u0437\u0438\u0447\u0435\u0441\u043A\u0438\u0445 \u0441\u043B\u043E\u0442\u043E\u0432).
  if (/2\s*x?\s*(nano-?sim|physical\s*sim|sim)s?\s*\+\s*e-?sim|dual\s*sim\s*\+\s*e-?sim/.test(low)) return "2 SIM + eSIM";
  // 2 eSIM (\u0431\u0435\u0437 \u0444\u0438\u0437\u0438\u0447\u0435\u0441\u043A\u0438\u0445 \u0441\u043B\u043E\u0442\u043E\u0432 \u0432\u043E\u043E\u0431\u0449\u0435)
  if (/2\s*e-?sim|dual\s*e-?sim|\u0434\u0432\u043E\u0439\u043D\w*\s*e-?sim/.test(low)) return "2 eSIM";
  // 1 \u0444\u0438\u0437\u0438\u0447\u0435\u0441\u043A\u0438\u0439 \u0441\u043B\u043E\u0442 + eSIM
  if (/(physical|nano|sim)\s*\+\s*e-?sim|sim\s*\+\s*e-?sim/.test(low)) return "SIM + eSIM";
  // 2 \u0444\u0438\u0437\u0438\u0447\u0435\u0441\u043A\u0438\u0445 \u0441\u043B\u043E\u0442\u0430 \u0431\u0435\u0437 eSIM (\u043E\u0431\u044B\u0447\u043D\u044B\u0439 Dual-SIM)
  if (/2\s*x?\s*(nano-?sim|physical\s*sim|sim)s?\b|dual\s*sim/.test(low)) return "2 SIM";
  if (/^e-?sim$/.test(low)) return "eSIM";
  if (/physical\s*sim|nano-?sim|^sim$/.test(low)) return "SIM";
  return v;
};

// \u0420\u0430\u0437\u0431\u043E\u0440 \u043A\u0430\u043D\u043E\u043D\u0438\u0447\u0435\u0441\u043A\u043E\u0439 \u043C\u0435\u0442\u043A\u0438 SIM \u043D\u0430 \u0434\u0432\u0430 \u043D\u0435\u0437\u0430\u0432\u0438\u0441\u0438\u043C\u044B\u0445 \u043F\u0440\u0438\u0437\u043D\u0430\u043A\u0430 (\u0447\u0438\u0441\u043B\u043E \u0444\u0438\u0437\u0438\u0447\u0435\u0441\u043A\u0438\u0445
// \u0441\u043B\u043E\u0442\u043E\u0432 / \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0430 eSIM) \u2014 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u044E\u0442\u0441\u044F \u0444\u0438\u043B\u044C\u0442\u0440\u0430\u043C\u0438 \u043A\u0430\u0442\u0430\u043B\u043E\u0433\u0430 \u0432\u043C\u0435\u0441\u0442\u043E \u043E\u0434\u043D\u043E\u0433\u043E
// \u043A\u043E\u043C\u0431\u0438\u043D\u0430\u0442\u043E\u0440\u043D\u043E\u0433\u043E select \u043D\u0430 \u0432\u0441\u0435 \u0441\u043E\u0447\u0435\u0442\u0430\u043D\u0438\u044F. \u041F\u0440\u0438\u043C\u0435\u0440: \u0440\u0435\u0433\u0438\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0435
// \u0432\u0435\u0440\u0441\u0438\u0438 Samsung .../DS (\u00AB2x Nano-SIM + eSIM\u00BB) \u2192 { slots: 2, esim: true }, \u0447\u0442\u043E \u0432\u043C\u0435\u0441\u0442\u0435
// \u0441 \u0444\u0438\u043B\u044C\u0442\u0440\u043E\u043C \u00AB2 \u0441\u043B\u043E\u0442\u0430\u00BB + \u00AB\u0415\u0441\u0442\u044C \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0430 eSIM\u00BB \u0438 \u043D\u0430\u0445\u043E\u0434\u0438\u0442 \u043D\u0443\u0436\u043D\u044B\u0439 \u0442\u043E\u0432\u0430\u0440.
window.simInfo = function (s) {
  var v = window.normSim ? window.normSim(s) : s;
  switch (v) {
    case "SIM": return { slots: 1, esim: false };
    case "eSIM": return { slots: 0, esim: true };
    case "SIM + eSIM": return { slots: 1, esim: true };
    case "2 eSIM": return { slots: 0, esim: true };
    case "2 SIM": return { slots: 2, esim: false };
    case "2 SIM + eSIM": return { slots: 2, esim: true };
    default: return { slots: 0, esim: false };
  }
};

// Отправка цели в Яндекс.Метрику. Работает, только если счётчик вставлен
// (metrikaId задан) — иначе тихо ничего не делает, поэтому вызывать можно
// безусловно и не проверять наличие счётчика в каждом месте.
window.ymGoal = function (goal, params) {
  try {
    var id = window.CONFIG && CONFIG.metrikaId;
    if (!id || typeof window.ym !== "function") return;
    window.ym(Number(id), "reachGoal", goal, params || {});
  } catch (e) {}
};

// Клики по контактам как цели Метрики.
//
// Зачем: у магазина основной канал — мессенджеры, и значительная часть людей
// не заполняет форму, а просто жмёт «Telegram» или на номер. Метрика такие
// переходы целью не считает, поэтому без этих вызовов отчёт по рекламе
// недооценивает результат: кампания выглядит нерабочей, хотя обращения идут.
//
// Слушатель один и делегированный — работает на всех страницах, где подключён
// config.js, и не зависит от того, отрисован ли элемент изначально или появился
// в модальном окне позже.
(function () {
  var MAP = [
    ["[data-tg]", "contact_telegram"],
    ["[data-wa]", "contact_whatsapp"],
    ["[data-max]", "contact_max"],
    ["[data-phone]", "contact_phone"],
    ['a[href^="tel:"]', "contact_phone"],
    ['a[href*="t.me/"]', "contact_telegram"],
    ['a[href*="wa.me/"]', "contact_whatsapp"],
  ];
  document.addEventListener(
    "click",
    function (e) {
      try {
        var t = e.target && e.target.closest ? e.target : null;
        if (!t) return;
        for (var i = 0; i < MAP.length; i++) {
          var el = t.closest(MAP[i][0]);
          if (el) {
            // Откуда пришёл клик — чтобы в отчёте было видно, что срабатывает:
            // карточка товара или подвал главной.
            window.ymGoal(MAP[i][1], { page: location.pathname });
            return; // одна цель на клик, иначе tel: даст две
          }
        }
      } catch (err) {}
    },
    true // capture: успеваем до перехода по ссылке
  );
})();

// ─────────────────────────────────────────────────────────────────────
// Согласие на аналитику (152-ФЗ)
//
// Прежний баннер сообщал «продолжая, вы соглашаетесь» и не влиял ни на что:
// Метрика с Вебвизором стартовала при загрузке страницы, то есть данные
// собирались до любого согласия. Теперь решение посетителя реально управляет
// загрузкой счётчика, а отказ — полноценный вариант, а не отсутствие кнопки.
//
// Баннер создаётся скриптом, поэтому появляется на всех страницах, а не только
// на главной (раньше он был в разметке одного index.html).
// ─────────────────────────────────────────────────────────────────────
(function () {
  var KEY = "ait:cookie-consent"; // тот же ключ, что у Store.hasCookieConsent
  function decided() {
    try { return localStorage.getItem(KEY) !== null; } catch (e) { return false; }
  }
  function decide(ok) {
    try { localStorage.setItem(KEY, ok ? "1" : "0"); } catch (e) {}
    if (ok) window.dispatchEvent(new Event("ait:consent-granted"));
  }

  function build() {
    if (decided() || document.getElementById("cookie-banner")) return;
    var d = document.createElement("div");
    d.id = "cookie-banner";
    d.className = "fixed bottom-4 left-1/2 -translate-x-1/2 z-[55] w-[calc(100%-2rem)] " +
      "max-w-2xl glass rounded-2xl shadow-pop p-4 flex flex-wrap items-center gap-3 transition-all duration-300";
    d.innerHTML =
      '<p class="text-sm text-ink-soft flex-1 min-w-[16rem]">' +
      'Мы используем аналитику, чтобы понимать, какие товары вам интересны. ' +
      'Она собирает обезличенные данные о посещении. Подробности — в ' +
      '<a href="privacy.html" class="text-apple-blue underline">Политике конфиденциальности</a>.' +
      '</p>' +
      '<button id="cookie-decline" class="btn-ghost text-sm px-4 py-2">Только необходимые</button>' +
      '<button id="cookie-accept" class="btn-primary text-sm px-5 py-2">Принять</button>';
    document.body.appendChild(d);

    function close(ok) {
      decide(ok);
      d.classList.add("opacity-0", "translate-y-4");
      setTimeout(function () { d.remove(); }, 300);
    }
    d.querySelector("#cookie-accept").addEventListener("click", function () { close(true); });
    d.querySelector("#cookie-decline").addEventListener("click", function () { close(false); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();

// ---------------------------------------------------------------------------
// Телефон: короткое нажатие — звонок (обычная ссылка tel:), долгое (0,5 с) —
// номер копируется, внизу всплывает подсказка «Номер скопирован».
// Работает для всех [data-phone] на всех страницах, включая добавленные позже.
// Системное меню ссылки («Share link / Call / Copy») при удержании подавляется.
// ---------------------------------------------------------------------------
(function phoneLongPress() {
  if (typeof document === "undefined") return;
  var HOLD = 500, timer = null, fired = false, sx = 0, sy = 0;
  var st = document.createElement("style");
  st.textContent = "[data-phone]{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}";
  (document.head || document.documentElement).appendChild(st);

  function phone() { return (window.CONFIG && CONFIG.contacts && CONFIG.contacts.phone) || ""; }
  function toast(msg) {
    var el = document.getElementById("ait-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ait-toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.style.cssText = "position:fixed;left:50%;bottom:calc(88px + env(safe-area-inset-bottom));" +
        "transform:translate(-50%,12px);background:#1d1d1f;color:#fff;padding:11px 18px;border-radius:999px;" +
        "font:500 14px/1.3 -apple-system,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);" +
        "opacity:0;transition:opacity .18s,transform .18s;z-index:9999;pointer-events:none;white-space:nowrap";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(function () { el.style.opacity = "1"; el.style.transform = "translate(-50%,0)"; });
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.opacity = "0"; el.style.transform = "translate(-50%,12px)"; }, 2200);
  }
  window.aitToast = toast;
  function copy(text) {
    function legacy() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
      ta.remove(); return ok;
    }
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, legacy);
    }
    return Promise.resolve(legacy());
  }
  function target(e) { return e.target && e.target.closest ? e.target.closest("[data-phone]") : null; }
  function cancel() { clearTimeout(timer); timer = null; }

  document.addEventListener("pointerdown", function (e) {
    if (!target(e) || (e.pointerType === "mouse" && e.button !== 0)) return;
    fired = false; sx = e.clientX; sy = e.clientY; cancel();
    timer = setTimeout(function () {
      timer = null; fired = true;
      var num = phone();
      copy(num).then(function (ok) {
        toast(ok ? "Номер скопирован: " + num : "Не удалось скопировать номер");
        if (ok && navigator.vibrate) navigator.vibrate(15);
        if (ok && window.ymGoal) window.ymGoal("contact_phone", { action: "copy" });
      });
    }, HOLD);
  }, { passive: true });
  document.addEventListener("pointermove", function (e) {
    if (timer && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 12) cancel();
  }, { passive: true });
  document.addEventListener("pointerup", cancel, { passive: true });
  document.addEventListener("pointercancel", cancel, { passive: true });
  document.addEventListener("contextmenu", function (e) { if (target(e)) e.preventDefault(); });
  // После удержания отпускание пальца не должно запускать звонок.
  document.addEventListener("click", function (e) {
    if (fired && target(e)) { e.preventDefault(); e.stopPropagation(); fired = false; }
  }, true);
})();


// ---------------------------------------------------------------------------
// Цена по карте / в кредит = наличные × 1.15 (округление до 10 ₽, как в воркере).
// Если в данных уже лежит корректная цена по карте (больше наличной) — берём её.
// ---------------------------------------------------------------------------
// ---- Состояние устройства ----
// Пустое значение = новое. Поле в каталоге заводится только у бывших в
// употреблении и витринных позиций: писать condition:"new" всем 274 товарам
// незачем, а «нет поля» читается однозначно.
window.CONDITIONS = [
  { v: "", t: "Новое" },
  { v: "used", t: "Б/у" },
  { v: "demo", t: "Витринный" },
];
// Б/у и витринные живут отдельным разделом каталога, а не подмешиваются к
// новым внутри iPhone/Samsung. Раздел виртуальный: в самих товарах категория
// остаётся прежней (она нужна фидам и характеристикам), а витрина и сборка
// раскладывают их по catOf(). Поэтому достаточно поставить «Б/у» в CRM —
// переносить товар между категориями руками не нужно.
// Картинки у раздела нет — рисуется векторный глиф. Имя глифа обязано быть из
// тех, что понимает deviceGlyph («iPhone», «iPad», «Mac», «Watch», «AirPods»,
// «accessory»), иначе на плитке появляется серый круг-заглушка.
window.USED_CATEGORY = { key: "Б/у", title: "Б/у и витрина", glyph: "iPhone", accent: "#3A3A3C" };
window.catOf = function (p) {
  return p && p.condition ? window.USED_CATEGORY.key : ((p && p.category) || "");
};

window.conditionLabel = function (p) {
  var v = p && p.condition;
  if (!v) return "";
  for (var i = 0; i < window.CONDITIONS.length; i++) {
    if (window.CONDITIONS[i].v === v) return window.CONDITIONS[i].t;
  }
  return "";
};
// Срок гарантии магазина: 12 месяцев на новую технику, 3 месяца на наушники
// и на бывшие в употреблении устройства. По аксессуарам гарантия не заявляется
// вовсе — функция возвращает пустую строку, и блок про гарантию на таких
// страницах просто не выводится.
window.warrantyPhrase = function (p) {
  if (p && (p.condition === "used" || p.condition === "demo")) return "гарантия магазина 3 месяца";
  var cat = (p && p.category) || "";
  if (cat === "Аксессуары") return "";
  if (cat === "Наушники") return "гарантия магазина 3 месяца";
  return "гарантия магазина 12 месяцев";
};

window.cardPrice = function (p) {
  var cash = Number(p && p.priceCash) || 0;
  if (cash <= 0) return 0;
  var card = Number(p && p.priceCard) || 0;
  return card > cash ? card : Math.round((cash * 1.15) / 10) * 10;
};

// ---------------------------------------------------------------------------
// Запрет перетаскивания карточек и фото. На Android (особенно Samsung) долгое
// нажатие на ссылку/картинку с малейшим сдвигом пальца запускает drag-and-drop,
// и система предлагает «поделиться» — открывается WhatsApp/Telegram. Карточка
// товара целиком накрыта ссылкой, поэтому это срабатывало именно на ней.
// ---------------------------------------------------------------------------
(function noDrag() {
  if (typeof document === "undefined") return;
  var st = document.createElement("style");
  st.textContent =
    "a[data-cardlink],[data-media] img,.media-plate img,.card img{-webkit-user-drag:none;user-drag:none}" +
    "[data-media] img,.media-plate img,.card img,a[data-cardlink]{-webkit-touch-callout:none}";
  (document.head || document.documentElement).appendChild(st);
  document.addEventListener("dragstart", function (e) {
    var t = e.target;
    if (t && t.closest && t.closest("a[data-cardlink],[data-media],.media-plate,.card")) e.preventDefault();
  }, true);
})();
