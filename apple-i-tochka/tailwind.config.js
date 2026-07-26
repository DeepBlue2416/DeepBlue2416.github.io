/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{html,js}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        // SF Pro с системным fallback (San Francisco на Apple-устройствах)
        sf: [
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
        // Палитра в стиле Apple
        ink: {
          DEFAULT: "#1d1d1f",
          soft: "#424245",
          mute: "#6e6e73",
        },
        cloud: {
          DEFAULT: "#f5f5f7",
          card: "#fbfbfd",
        },
        apple: {
          blue: "#0071e3",
          blueDark: "#0077ED",
          green: "#00a15c",
          amber: "#c98a00",
          red: "#e30000",
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
