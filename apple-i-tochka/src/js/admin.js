// admin.js — Логика мини-CRM (FR-4.2)
// Таблица товаров с быстрым редактированием цен и статуса.
// Изменения сохраняются в Cloudflare KV через Worker (Bearer-токен).
import { CONFIG } from "./config.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const fmt = (n) => new Intl.NumberFormat("ru-RU").format(n);

// Токен храним только в памяти вкладки (не в localStorage — безопаснее).
let TOKEN = "";
let API = CONFIG.apiBase || "";
let products = [];
const dirty = new Set(); // id изменённых строк

const STATUS_OPTS = [
  { v: "in_stock", t: "В наличии" },
  { v: "on_order", t: "Под заказ 1–2 дня" },
];

function setBar(msg, type = "") {
  const cls =
    "text-sm " +
    (type === "err" ? "text-apple-red" : type === "ok" ? "text-apple-green" : "text-ink-mute");
  ["#status-bar", "#status-bar-2"].forEach((sel) => {
    const bar = $(sel);
    if (!bar) return;
    bar.textContent = msg;
    bar.className = cls;
    bar.classList.remove("hidden");
  });
}

async function api(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(opts.headers || {}),
    },
  });
  if (r.status === 401) throw new Error("Неверный токен доступа (401).");
  if (!r.ok) throw new Error(`Ошибка ${r.status}`);
  return r.json().catch(() => ({}));
}

// ------- Загрузка -------
async function loadProducts() {
  setBar("Загружаю каталог…");
  let data;
  if (API) {
    data = await api("/api/products");
  } else {
    // Демо-режим без Worker — читаем локальный JSON (сохранение недоступно)
    const r = await fetch("./data/products.json", { cache: "no-cache" });
    data = await r.json();
  }
  products = data.products || [];
  renderTable();
  setBar(
    API
      ? `Загружено ${products.length} товаров.`
      : `ДЕМО-режим: CONFIG.apiBase пуст. Сохранение недоступно. Загружено ${products.length}.`,
    API ? "ok" : "err"
  );
}

// ------- Таблица -------
function renderTable() {
  const tb = $("#rows");
  tb.innerHTML = products
    .map(
      (p) => `
    <tr class="border-t border-black/[0.06] hover:bg-black/[0.02]" data-row="${p.id}">
      <td class="p-3">
        <div class="font-medium text-ink">${p.name}</div>
        <div class="text-xs text-ink-mute">${[p.storage, p.color].filter((x) => x && x !== "—").join(" · ")}</div>
        <div class="text-[11px] text-ink-mute/70">${p.category} · ${p.id}</div>
      </td>
      <td class="p-3">
        <input type="number" min="0" step="500" value="${p.priceCash}" data-field="priceCash" data-id="${p.id}"
          class="w-28 rounded-lg border border-black/10 px-2 py-1.5 text-right text-sm focus:border-apple-blue outline-none" />
      </td>
      <td class="p-3">
        <input type="number" min="0" step="500" value="${p.priceCard}" data-field="priceCard" data-id="${p.id}"
          class="w-28 rounded-lg border border-black/10 px-2 py-1.5 text-right text-sm focus:border-apple-blue outline-none" />
      </td>
      <td class="p-3">
        <select data-field="status" data-id="${p.id}"
          class="rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:border-apple-blue outline-none">
          ${STATUS_OPTS.map((s) => `<option value="${s.v}" ${p.status === s.v ? "selected" : ""}>${s.t}</option>`).join("")}
        </select>
      </td>
      <td class="p-3 text-center">
        <span class="dot inline-block w-2.5 h-2.5 rounded-full bg-transparent" data-dot="${p.id}"></span>
      </td>
    </tr>`
    )
    .join("");

  $$("[data-field]", tb).forEach((el) =>
    el.addEventListener("input", () => {
      const id = el.dataset.id;
      const p = products.find((x) => x.id === id);
      if (!p) return;
      const val = el.dataset.field === "status" ? el.value : Number(el.value);
      p[el.dataset.field] = val;
      dirty.add(id);
      const dot = $(`[data-dot="${id}"]`);
      if (dot) dot.classList.replace("bg-transparent", "bg-apple-amber");
      $("#save-all").disabled = dirty.size === 0;
      $("#dirty-count").textContent = dirty.size ? `Не сохранено: ${dirty.size}` : "";
    })
  );
}

// ------- Сохранение -------
async function saveAll() {
  if (!API) return setBar("Нет apiBase — сохранение невозможно в демо-режиме.", "err");
  if (!dirty.size) return;
  const changes = [...dirty].map((id) => {
    const p = products.find((x) => x.id === id);
    return { id, priceCash: p.priceCash, priceCard: p.priceCard, status: p.status };
  });
  setBar("Сохраняю изменения…");
  $("#save-all").disabled = true;
  try {
    await api("/api/admin/update", {
      method: "POST",
      body: JSON.stringify({ changes }),
    });
    changes.forEach((c) => {
      const dot = $(`[data-dot="${c.id}"]`);
      if (dot) dot.classList.replace("bg-apple-amber", "bg-apple-green");
    });
    dirty.clear();
    $("#dirty-count").textContent = "";
    setBar(`Сохранено ${changes.length} изм. в KV.`, "ok");
  } catch (e) {
    setBar(e.message, "err");
    $("#save-all").disabled = false;
  }
}

// ------- Вход -------
function showApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
}

async function onLogin(e) {
  e.preventDefault();
  TOKEN = $("#token").value.trim();
  const custom = $("#api").value.trim();
  if (custom) API = custom.replace(/\/$/, "");
  if (!API && !confirm("apiBase не задан — открыть в ДЕМО-режиме только для чтения?")) return;
  try {
    setBar("Проверяю доступ…");
    await loadProducts();
    showApp();
  } catch (err) {
    setBar(err.message, "err");
  }
}

// ------- Первичная загрузка каталога в KV из локального products.json -------
async function seedKV() {
  if (!API) return setBar("Укажите apiBase — иначе KV недоступен.", "err");
  if (!confirm("Загрузить каталог из products.json в KV? Существующие данные в KV будут перезаписаны.")) return;
  setBar("Инициализирую KV…");
  try {
    const r = await fetch("./data/products.json", { cache: "no-cache" });
    const catalog = await r.json();
    const res = await api("/api/admin/seed", { method: "POST", body: JSON.stringify(catalog) });
    setBar(`KV инициализирован: ${res.count} товаров. Перезагрузите каталог.`, "ok");
    await loadProducts();
  } catch (e) {
    setBar(e.message, "err");
  }
}

function init() {
  $$("[data-brand]").forEach((el) => (el.textContent = CONFIG.brand));
  $("#api").value = CONFIG.apiBase || "";
  $("#login-form").addEventListener("submit", onLogin);
  $("#save-all").addEventListener("click", saveAll);
  $("#seed").addEventListener("click", () => seedKV());
  $("#reload").addEventListener("click", () => loadProducts().catch((e) => setBar(e.message, "err")));
  // Ctrl/Cmd+S — сохранить
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveAll();
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
