# Apple и точка — интернет-магазин техники Apple

Лёгкий, сверхбыстрый и автономный магазин техники Apple для одного города.

> **Обновление:** сайт теперь работает и без веб-сервера — можно просто открыть
> `src/index.html` двойным кликом (каталог, поиск, избранное, сравнение и модалки
> функционируют). Применён брендбук: логотип «Apple и точка», фирменные цвета
> (#0582F6 / #17C0F9), шрифт Geometria. Интерфейс адаптирован под телефоны.
Статический фронтенд на GitHub Pages + Cloudflare Worker (Telegram-лиды и мини-CRM на KV).

- **Фронтенд:** HTML5 + Tailwind CSS + Vanilla JS (без фреймворков)
- **Хостинг:** GitHub Pages (бесплатно)
- **Бэкенд:** Cloudflare Workers + KV (Free tier)
- **Лиды:** Telegram Bot API
- **CRM:** защищённая страница `/admin.html` с редактированием цен и наличия
- **Состояние клиента:** localStorage (Избранное, Сравнение, cookie-согласие)

---

## Структура проекта (Tree View)

```
apple-i-tochka/
├── .github/
│   └── workflows/
│       └── deploy.yml
├── public/
│   ├── favicon.ico
│   ├── favicon.svg
│   └── robots.txt
├── scripts/
│   ├── build.js
│   └── gen-catalog.mjs
├── src/
│   ├── assets/
│   │   ├── css/
│   │   │   ├── input.css
│   │   │   └── tailwind.css
│   │   ├── fonts/
│   │   │   └── README.md
│   │   ├── logo-full.svg
│   │   ├── logo-icon.svg
│   │   └── logo-mark.svg
│   ├── data/
│   │   ├── products.js
│   │   └── products.json
│   ├── js/
│   │   ├── admin.js
│   │   ├── app.js
│   │   ├── compare.js
│   │   ├── config.js
│   │   ├── icons.js
│   │   ├── product.js
│   │   ├── search.js
│   │   ├── storage.js
│   │   └── trade-in.js
│   ├── admin.html
│   ├── favicon.ico
│   ├── favicon.svg
│   ├── index.html
│   ├── offer.html
│   ├── privacy.html
│   └── product.html
├── worker/
│   ├── index.js
│   └── wrangler.toml
├── .gitignore
├── ADMIN.md
├── CHANGELOG.md
├── README.md
├── package.json
└── tailwind.config.js
```

**Ключевые файлы:**
- `src/js/config.js` — единые настройки (бренд, город, контакты, `apiBase`, ключ Turnstile).
- `src/js/app.js` — логика витрины (каталог, поиск, модалки, скраббер, speed dial, город).
- `src/js/icons.js` — офлайн-набор иконок Lucide.
- `src/js/product.js` — страница товара; `src/js/admin.js` — CRM-таблица.
- `src/data/products.js` — встроенный каталог (работа без сервера); `products.json` — для сидинга KV.
- `worker/index.js` — Cloudflare Worker: заявки в Telegram (+Turnstile) и CRM-API поверх KV.

---

## Быстрый старт (локально)

```bash
npm install
npm run css        # собрать Tailwind (src/assets/css/tailwind.css)
npm run serve      # http://localhost:5173
```

Или всё сразу в режиме разработки:

```bash
npm run dev        # watch Tailwind + локальный сервер
```

> Без Cloudflare Worker сайт работает в офлайн-режиме: каталог берётся из
> `src/data/products.json`, а заявки открывают Telegram с преднабранным текстом.
> Это удобно для просмотра дизайна до настройки бэкенда.

---

## Настройка (обязательно перед деплоем)

Отредактируйте **`src/js/config.js`**:

```js
brand: "Apple и точка",
city: "Ваш город",
apiBase: "https://apple-i-tochka-api.ВАШ-СУБДОМЕН.workers.dev",
contacts: {
  phone: "+7 978 000-00-00",
  phoneHref: "+79780000000",
  telegram: "https://t.me/ваш_оператор",
  whatsapp: "https://wa.me/79780000000",
},
```

---

## Деплой фронтенда на GitHub Pages

1. Создайте репозиторий на GitHub и запушьте проект в ветку `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. При каждом пуше в `main` запускается `.github/workflows/deploy.yml`:
   собирает Tailwind, кладёт сайт в `./dist` и публикует.
4. Сайт будет доступен по адресу `https://USERNAME.github.io/REPO/`.

> Свой домен: положите файл `public/CNAME` с доменом (например `shop.example.ru`)
> — он попадёт в корень сайта при сборке.

---

## Деплой Cloudflare Worker + KV

Нужен аккаунт Cloudflare (бесплатный) и установленный `wrangler` (входит в devDependencies).

```bash
npx wrangler login

# 1) Создать KV namespace и получить id
npx wrangler kv namespace create PRODUCTS
npx wrangler kv namespace create PRODUCTS --preview
```

Подставьте выданные `id` и `preview_id` в **`worker/wrangler.toml`**
(поле `kv_namespaces`), а также укажите ваш `github.io` в `ALLOWED_ORIGINS`.

```bash
# 2) Задать секреты (значения не попадают в git)
npx wrangler secret put TELEGRAM_BOT_TOKEN   # токен от @BotFather
npx wrangler secret put TELEGRAM_CHAT_ID      # id чата оператора
npx wrangler secret put ADMIN_TOKEN           # пароль для /admin.html

# 3) Опубликовать Worker
npx wrangler deploy
```

Скопируйте выданный URL Worker (`https://…workers.dev`) и вставьте его в
`apiBase` в `src/js/config.js`, затем передеплойте фронтенд.

### Как узнать TELEGRAM_CHAT_ID
Напишите боту любое сообщение и откройте
`https://api.telegram.org/bot<ТОКЕН>/getUpdates` — `chat.id` будет в ответе.
Для группы добавьте бота в группу и посмотрите там же (id группы начинается с `-`).

---

## Первичная загрузка каталога в KV

Каталог в реальном времени хранится в KV (ключ `catalog`). Инициализируйте его один раз:

1. Откройте `https://USERNAME.github.io/REPO/admin.html`.
2. Введите `ADMIN_TOKEN` и URL Worker → **Войти**.
3. Нажмите **«Инициализировать KV»** — каталог из `products.json` загрузится в KV.

После этого витрина и CRM работают из KV. Дальше цены и статусы правятся прямо в таблице CRM (кнопка «Сохранить» или ⌘/Ctrl+S).

---

## API Worker

| Метод | Путь | Доступ | Назначение |
|------|------|--------|-----------|
| GET  | `/api/products`      | публичный | каталог из KV (реальное время) |
| POST | `/api/lead`          | публичный | заявка → Telegram оператора |
| POST | `/api/admin/seed`    | Bearer ADMIN_TOKEN | загрузить каталог в KV |
| POST | `/api/admin/update`  | Bearer ADMIN_TOKEN | обновить цены/статусы |

---

## Реализованные требования

- **Каталог/навигация:** категории, фильтры (поколение, память, цвет, SIM), сравнение, избранное, статусы наличия.
- **Умный поиск:** транслитерация (айфон→iPhone), опечатки (айфно→iPhone), исправление раскладки (fbajy→айфон), поиск по характеристикам (16 256 титан), живой дропдаун от 2 символов.
- **Цены:** две цены (наличные / картой-кредит), калькулятор Trade-In с уведомлением о диагностике.
- **Оператор/CRM:** кнопки Telegram/WhatsApp/tel, защищённая CRM-таблица с сохранением в KV.
- **152-ФЗ:** чекбокс согласия, cookie-баннер, ссылки на Политику и Оферту.

---

## Замечания
- Данные каталога (`products.json`) — демонстрационные; отредактируйте под свой ассортимент.
- Реквизиты в `privacy.html` и `offer.html` замените на реальные (ИП/ООО, ИНН, адрес).
- Название «Apple i Точка» и товарные знаки Apple используются информационно; сайт не аффилирован с Apple Inc.
