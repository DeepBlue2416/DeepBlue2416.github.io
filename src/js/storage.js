// storage.js — работа с localStorage: Избранное и Сравнение (FR-1.4, FR-1.3)
// Клиентское состояние без бэкенда. Экспортируется как глобальный объект Store.

const KEYS = {
  fav: "ait:favorites",
  cmp: "ait:compare",
  consent: "ait:cookie-consent",
};

const COMPARE_LIMIT = 4;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("localStorage недоступен:", e);
  }
}

const bus = new EventTarget();

function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
  // Дублируем на window, чтобы UI мог слушать глобально
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

const Store = {
  on(name, handler) {
    bus.addEventListener(name, handler);
    return () => bus.removeEventListener(name, handler);
  },

  // ---------- Избранное ----------
  getFavorites() {
    return read(KEYS.fav, []);
  },
  isFavorite(id) {
    return this.getFavorites().includes(id);
  },
  toggleFavorite(id) {
    const list = this.getFavorites();
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(id);
    write(KEYS.fav, list);
    emit("favorites:change", { list, id, active: idx < 0 });
    return idx < 0;
  },

  // ---------- Сравнение ----------
  getCompare() {
    return read(KEYS.cmp, []);
  },
  inCompare(id) {
    return this.getCompare().includes(id);
  },
  toggleCompare(id) {
    const list = this.getCompare();
    const idx = list.indexOf(id);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      if (list.length >= COMPARE_LIMIT) {
        emit("compare:limit", { limit: COMPARE_LIMIT });
        return false;
      }
      list.push(id);
    }
    write(KEYS.cmp, list);
    emit("compare:change", { list, id, active: idx < 0 });
    return idx < 0;
  },
  clearCompare() {
    write(KEYS.cmp, []);
    emit("compare:change", { list: [], id: null, active: false });
  },

  // Очистка «мёртвых» id (товар удалён из каталога) — иначе их не убрать из UI
  pruneMissing(validIds) {
    const valid = new Set(validIds);
    let changed = false;
    const fav = this.getFavorites().filter((id) => valid.has(id));
    if (fav.length !== this.getFavorites().length) { write(KEYS.fav, fav); changed = true; }
    const cmp = this.getCompare().filter((id) => valid.has(id));
    if (cmp.length !== this.getCompare().length) { write(KEYS.cmp, cmp); changed = true; }
    if (changed) { emit("favorites:change", { list: fav }); emit("compare:change", { list: cmp }); }
    return changed;
  },

  // ---------- Cookie-согласие (FR-5.2) ----------
  hasCookieConsent() {
    return read(KEYS.consent, false) === true;
  },
  setCookieConsent() {
    write(KEYS.consent, true);
    emit("consent:change", { value: true });
  },

  COMPARE_LIMIT,
};

if (typeof window !== "undefined") window.Store = Store;
