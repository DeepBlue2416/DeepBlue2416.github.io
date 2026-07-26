// compare.js — Таблица сравнения характеристик (FR-1.3)
// Строит единую таблицу для выбранных товаров из Store.getCompare().

import { Store } from "./storage.js";

function fmt(n, cur = "₽") {
  return new Intl.NumberFormat("ru-RU").format(n) + " " + cur;
}

export const Compare = {
  // products — полный массив каталога; возвращает HTML-разметку таблицы
  buildTableHTML(products, currency = "₽") {
    const ids = Store.getCompare();
    const items = ids
      .map((id) => products.find((p) => p.id === id))
      .filter(Boolean);

    if (!items.length) {
      return `<div class="py-16 text-center text-ink-mute">
        Добавьте товары к сравнению — нажмите значок «весы» на карточке.
      </div>`;
    }

    // Собираем объединённый набор строк характеристик
    const baseRows = [
      ["Категория", (p) => p.category],
      ["Поколение", (p) => p.generation || "—"],
      ["Память", (p) => p.storage || "—"],
      ["Цвет", (p) => p.color || "—"],
      ["SIM", (p) => p.sim || "—"],
      ["Наличными", (p) => fmt(p.priceCash, currency)],
      ["Картой / кредит", (p) => fmt(p.priceCard, currency)],
      ["Статус", (p) => (p.status === "in_stock" ? "В наличии" : "Под заказ 1–2 дня")],
    ];

    const specKeys = Array.from(
      new Set(items.flatMap((p) => (p.specs ? Object.keys(p.specs) : [])))
    );

    const head = `
      <thead>
        <tr>
          <th class="sticky left-0 z-10 bg-cloud-card p-4 text-left text-sm text-ink-mute font-medium w-40">Параметр</th>
          ${items
            .map(
              (p) => `<th class="p-4 text-left min-w-[180px]">
                <div class="font-semibold text-ink">${p.name}</div>
                <div class="text-xs text-ink-mute">${p.storage} · ${p.color}</div>
                <button class="mt-2 text-xs text-apple-red hover:underline" data-cmp-remove="${p.id}">Убрать</button>
              </th>`
            )
            .join("")}
        </tr>
      </thead>`;

    const rowHTML = (label, getter, highlight = false) => `
      <tr class="border-t border-black/[0.06]">
        <td class="sticky left-0 bg-cloud-card p-4 text-sm text-ink-mute font-medium">${label}</td>
        ${items
          .map(
            (p) =>
              `<td class="p-4 text-sm ${highlight ? "font-semibold text-ink" : "text-ink-soft"}">${getter(p)}</td>`
          )
          .join("")}
      </tr>`;

    const body = `
      <tbody>
        ${baseRows.map(([l, g], i) => rowHTML(l, g, l.includes("Наличными"))).join("")}
        ${specKeys
          .map((key) =>
            rowHTML(key, (p) => (p.specs && p.specs[key] ? p.specs[key] : "—"))
          )
          .join("")}
      </tbody>`;

    return `<div class="overflow-x-auto rounded-3xl border border-black/[0.06] bg-cloud-card">
      <table class="w-full border-collapse">${head}${body}</table>
    </div>`;
  },
};

if (typeof window !== "undefined") window.Compare = Compare;
