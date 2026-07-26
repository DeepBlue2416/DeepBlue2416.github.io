// trade-in.js — Пошаговый калькулятор Trade-In (FR-3.2, FR-3.3)
// Оценка ориентировочная. Финальная стоимость — только после диагностики в магазине.

// Базовые оценки выкупа (₽) по модели и памяти — стартовая «идеальная» цена.
// Значения ориентировочные; оператор корректирует в магазине.
export const TRADEIN_MODELS = [
  { id: "ip16pm", label: "iPhone 16 Pro Max", base: { "256 ГБ": 92000, "512 ГБ": 104000, "1 ТБ": 116000 } },
  { id: "ip16p", label: "iPhone 16 Pro", base: { "128 ГБ": 78000, "256 ГБ": 84000, "512 ГБ": 96000 } },
  { id: "ip16", label: "iPhone 16", base: { "128 ГБ": 55000, "256 ГБ": 61000, "512 ГБ": 70000 } },
  { id: "ip15pm", label: "iPhone 15 Pro Max", base: { "256 ГБ": 74000, "512 ГБ": 84000, "1 ТБ": 92000 } },
  { id: "ip15p", label: "iPhone 15 Pro", base: { "128 ГБ": 62000, "256 ГБ": 68000, "512 ГБ": 76000 } },
  { id: "ip15", label: "iPhone 15", base: { "128 ГБ": 44000, "256 ГБ": 49000, "512 ГБ": 56000 } },
  { id: "ip14pm", label: "iPhone 14 Pro Max", base: { "128 ГБ": 55000, "256 ГБ": 60000, "512 ГБ": 66000 } },
  { id: "ip14", label: "iPhone 14", base: { "128 ГБ": 34000, "256 ГБ": 38000, "512 ГБ": 43000 } },
  { id: "ip13", label: "iPhone 13", base: { "128 ГБ": 27000, "256 ГБ": 30000, "512 ГБ": 34000 } },
  { id: "ip12", label: "iPhone 12", base: { "64 ГБ": 18000, "128 ГБ": 20000, "256 ГБ": 23000 } },
];

// Состояние корпуса — множитель.
export const CONDITIONS = [
  { id: "ideal", label: "Идеальное — без следов", factor: 1.0, hint: "Как новый, нет царапин и сколов" },
  { id: "good", label: "Хорошее — лёгкие потёртости", factor: 0.85, hint: "Мелкие следы эксплуатации" },
  { id: "used", label: "Заметный износ", factor: 0.65, hint: "Царапины, потёртости корпуса" },
  { id: "damaged", label: "Повреждения / трещины", factor: 0.4, hint: "Сколы, трещины стекла или корпуса" },
];

// Износ аккумулятора (ёмкость) — множитель.
export const BATTERY = [
  { id: "b90", label: "90–100 %", factor: 1.0 },
  { id: "b80", label: "80–89 %", factor: 0.93 },
  { id: "b70", label: "менее 80 %", factor: 0.85 },
];

export const TradeIn = {
  MODELS: TRADEIN_MODELS,
  CONDITIONS,
  BATTERY,

  storagesFor(modelId) {
    const m = TRADEIN_MODELS.find((x) => x.id === modelId);
    return m ? Object.keys(m.base) : [];
  },

  // Возвращает {min, max} ориентировочной оценки
  estimate({ modelId, storage, conditionId, batteryId }) {
    const m = TRADEIN_MODELS.find((x) => x.id === modelId);
    if (!m) return null;
    const base = m.base[storage];
    if (base == null) return null;
    const cond = CONDITIONS.find((c) => c.id === conditionId)?.factor ?? 1;
    const bat = BATTERY.find((b) => b.id === batteryId)?.factor ?? 1;
    const value = Math.round((base * cond * bat) / 500) * 500;
    // диапазон ±5 % — финальная цена после диагностики
    const min = Math.round((value * 0.95) / 500) * 500;
    const max = Math.round((value * 1.05) / 500) * 500;
    return { value, min, max };
  },
};

if (typeof window !== "undefined") window.TradeIn = TradeIn;
