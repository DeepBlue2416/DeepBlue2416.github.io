# Шрифты

По брендбуку основной фирменный шрифт — **Geometria** (Bold — для логотипа и
заголовков, SemiBold/Medium/Regular — для текста).

В `tailwind.config.js` (`fontFamily.sf`) шрифтовой стек начинается с `Geometria`.
Если шрифт установлен в системе пользователя — он применяется автоматически.
Иначе подхватывается близкий системный fallback (SF Pro на Apple-устройствах,
Segoe UI / Roboto на остальных), чтобы сайт всегда выглядел аккуратно.

## Как подключить Geometria для всех посетителей

Geometria — коммерческий шрифт, распространяется по лицензии. Если у вас есть
лицензионные веб-файлы (`.woff2`), положите их сюда и добавьте `@font-face`
в `src/assets/css/input.css` перед слоями Tailwind:

```css
@font-face {
  font-family: "Geometria";
  src: url("../fonts/Geometria.woff2") format("woff2");
  font-weight: 400; font-display: swap;
}
@font-face {
  font-family: "Geometria";
  src: url("../fonts/Geometria-Medium.woff2") format("woff2");
  font-weight: 500; font-display: swap;
}
@font-face {
  font-family: "Geometria";
  src: url("../fonts/Geometria-Bold.woff2") format("woff2");
  font-weight: 700; font-display: swap;
}
```

После этого пересоберите CSS: `npm run css:min`.

Бесплатная альтернатива с похожей геометрией (если нет лицензии на Geometria) —
**Manrope** или **Golos Text** (обе с открытой лицензией, хорошо поддерживают
кириллицу).
