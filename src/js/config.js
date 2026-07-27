// config.js — ЕДИНЫЕ НАСТРОЙКИ САЙТА.
// Отредактируйте значения под свой магазин перед деплоем.
// (classic script — работает и при открытии index.html напрямую, без сервера)

var CONFIG = {
  brand: "Apple и точка",
  city: "Таганрог",

  // Базовый URL Cloudflare Worker (без завершающего /).
  apiBase: "https://apple-orders-api.overkraken2416.workers.dev", // <-- Укажите URL вашего воркера
  // Пусто "" -> сайт работает офлайн на встроенном каталоге (data/products.js).

  // Публичный ключ Cloudflare Turnstile (Site Key)
  turnstileSiteKey: "0x4AAAAAAD_YUk6nJXcjmfCm", // <-- Вставьте ваш Site Key (начинается на 0x4...)
  

  // Контакты оператора (FR-4.1)
  contacts: {
    phone: "+7 900 172-36-35",
    phoneHref: "+79001723635",
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
