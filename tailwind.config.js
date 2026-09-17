/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{html,js}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        // Фирменный шрифт бренда — Geometria (см. брендбук). Если он не установлен
        // в системе пользователя, подхватывается близкий по геометрии fallback.
        sf: [
          "Geometria",
          '"SF Pro Display"',
          '"SF Pro Text"',
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          '"Helvetica Neue"',
          "Arial",
          "sans-serif",
        ],
      },
      colors: {
        // Дизайн-токены (значения в :root / .dark в input.css). rgb(var/<alpha-value>)
        // сохраняет работу модификаторов прозрачности (bg-cloud/70 и т.п.).
        ink: {
          DEFAULT: "rgb(var(--text-primary) / <alpha-value>)",
          soft: "rgb(var(--text-soft) / <alpha-value>)",
          mute: "rgb(var(--text-secondary) / <alpha-value>)",
        },
        cloud: {
          DEFAULT: "rgb(var(--bg-primary) / <alpha-value>)",  // основной фон
          card: "rgb(var(--bg-surface) / <alpha-value>)",     // карточки/поверхности
        },
        surface: "rgb(var(--bg-surface) / <alpha-value>)",
        brand: {
          DEFAULT: "rgb(var(--brand-primary) / <alpha-value>)",
          cyan: "#17C0F9",
          dark: "rgb(var(--brand-primary-dark) / <alpha-value>)",
        },
        apple: {
          blue: "rgb(var(--brand-primary) / <alpha-value>)",
          blueDark: "rgb(var(--brand-primary-dark) / <alpha-value>)",
          green: "rgb(var(--status-success) / <alpha-value>)",
          amber: "rgb(var(--status-warning) / <alpha-value>)",
          red: "rgb(var(--status-error) / <alpha-value>)",
        },
      },
      borderRadius: {
        xl2: "1.25rem",
        "3xl": "1.75rem",
      },
      boxShadow: {
        glass: "0 8px 30px rgba(0,0,0,0.08)",
        card: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)",
        pop: "0 12px 48px rgba(0,0,0,0.18)",
      },
      backdropBlur: {
        xl2: "28px",
      },
      transitionTimingFunction: {
        apple: "cubic-bezier(0.28, 0.11, 0.32, 1)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.96)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.5s cubic-bezier(0.28,0.11,0.32,1) both",
        "scale-in": "scale-in 0.25s cubic-bezier(0.28,0.11,0.32,1) both",
      },
    },
  },
  plugins: [],
};
