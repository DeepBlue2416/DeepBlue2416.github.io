// config.js — ЕДИНЫЕ НАСТРОЙКИ САЙТА.
// Отредактируйте значения под свой магазин перед деплоем.
// (classic script — работает и при открытии index.html напрямую, без сервера)

var CONFIG = {
  brand: "Apple и точка",
  city: "ваш город",

  // Базовый URL Cloudflare Worker (без завершающего /).
  // Пусто "" -> сайт работает офлайн на встроенном каталоге (data/products.js).
  // Пример: "https://apple-i-tochka-api.ВАШ-СУБДОМЕН.workers.dev"
  apiBase: "",

  // Контакты оператора (FR-4.1)
  contacts: {
    phone: "+7 000 000-00-00",
    phoneHref: "+70000000000",
    telegram: "https://t.me/your_operator",
    whatsapp: "https://wa.me/70000000000",
  },

  // Ссылки в футере (FR-5.3)
  legal: {
    privacy: "privacy.html",
    offer: "offer.html",
  },

  currency: "₽",
};

window.CONFIG = CONFIG;
