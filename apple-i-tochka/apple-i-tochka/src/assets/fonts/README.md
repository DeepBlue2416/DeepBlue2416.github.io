# Шрифты

Сайт использует шрифтовое семейство **SF Pro** (San Francisco) — фирменный шрифт Apple.

На устройствах Apple (macOS/iOS) он подхватывается автоматически через системный
стек `-apple-system, BlinkMacSystemFont` (см. `tailwind.config.js`, `fontFamily.sf`).
На остальных платформах используется аккуратный системный fallback (Segoe UI, Roboto).

## Если хотите подключить SF Pro для всех платформ

1. Скачайте шрифты с сайта Apple: https://developer.apple.com/fonts/
   (шрифты распространяются по лицензии Apple — соблюдайте её условия использования).
2. Сконвертируйте в `.woff2` и положите файлы сюда, например:
   `SF-Pro-Display-Regular.woff2`, `SF-Pro-Display-Medium.woff2`, `SF-Pro-Display-Semibold.woff2`.
3. Добавьте `@font-face` в `src/assets/css/input.css` перед слоями Tailwind:

```css
@font-face {
  font-family: "SF Pro Display";
  src: url("../fonts/SF-Pro-Display-Regular.woff2") format("woff2");
  font-weight: 400; font-display: swap;
}
/* … Medium 500, Semibold 600 аналогично … */
```

4. Пересоберите CSS: `npm run css:min`.

Свободная альтернатива с похожей геометрией — **Inter** (SIL Open Font License),
её можно подключить тем же способом без ограничений лицензии.
