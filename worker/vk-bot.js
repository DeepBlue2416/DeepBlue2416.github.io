// worker/vk-bot.js — автоответчик в сообщениях сообщества ВКонтакте.
//
// ЗАЧЕМ: реклама ВК с целью «Отправка сообщения» приводит человека в диалог.
// Если после кнопки «Начать» или вопроса «сколько стоит…» тишина, он уходит.
// Бот отвечает сразу и по делу: цену и наличие берёт из того же каталога в KV,
// что и сайт, поэтому после правки в CRM или обновления прайса ничего отдельно
// менять не нужно. Дальше разговор ведёт продавец.
//
// ЧЕГО БОТ НЕ ДЕЛАЕТ:
//   • не называет закупочные цены: в ответ идёт только priceCash (розница);
//   • не угадывает: если под запрос подходит несколько моделей, переспрашивает;
//   • не перебивает продавца: как только в диалог написал администратор
//     сообщества, бот замолкает на VK_HUMAN_TTL;
//   • не обещает рассрочку: её в магазине нет, только кредит.
//
// Здесь нет ничего специфичного для Workers, кроме fetch и KV через env:
// разбор текста и сборка ответа это чистые функции, их гоняют тесты в Node.
//
// Переменные воркера (Settings → Variables and Secrets):
//   VK_GROUP_ID        — числовой id сообщества
//   VK_CONFIRM_CODE    — строка подтверждения из раздела Callback API
//   VK_CALLBACK_SECRET (секрет) — «Секретный ключ» из того же раздела.
//                        ОБЯЗАТЕЛЕН: без него любой мог бы слать воркеру
//                        поддельные события и рассылать ответы от имени магазина.
//   VK_GROUP_TOKEN     (секрет) — ключ доступа сообщества с правом «сообщения»
//   VK_BOT             — "off" выключает ответы, не трогая остальное
//   VK_NOTIFY_TG       — "off" выключает дубль сообщений в Telegram продавцу

const VK_API = "https://api.vk.com/method/";
const VK_API_VERSION = "5.199";

const VK_HUMAN_TTL = 6 * 60 * 60 * 1000;   // сколько бот молчит после ответа продавца
const VK_STUB_GAP = 30 * 60 * 1000;        // заглушку не повторяем чаще
const VK_MAX_PER_HOUR = 8;                 // предохранитель от зацикливания
const VK_BOT_ECHO_WINDOW = 20 * 1000;      // окно, в котором message_reply считаем эхом бота
const VK_PEER_TTL = 60 * 60 * 24;          // состояние диалога живёт сутки

const VK_SHOP = {
  address: "ТЦ «Мармелад», пл. Мира, 7, 1 этаж",
  hours: "ежедневно с 10:00 до 20:00",
  openFrom: 10,
  openTo: 20,
  utcOffset: 3, // Таганрог, UTC+3
};

// ---------------------------------------------------------------------------
// 1. Разбор текста покупателя
// ---------------------------------------------------------------------------
// Словарь «как пишут» → «как в каталоге». Только целые слова.
const VK_WORDS = {
  айфон: "iphone", айфона: "iphone", айфоны: "iphone", айфону: "iphone", айфоне: "iphone", афон: "iphone", ифон: "iphone", iphon: "iphone",
  макс: "max", плюс: "plus", plus: "plus",
  эйр: "air", аир: "air", эир: "air", эйер: "air",
  ультра: "ultra", мини: "mini",
  галакси: "galaxy", гэлакси: "galaxy", галактика: "galaxy", самсунг: "samsung", самсунга: "samsung",
  вотч: "watch", уотч: "watch", воч: "watch", часы: "watch", часики: "watch",
  аирподс: "airpods", аирподсы: "airpods", эирподс: "airpods", эйрподс: "airpods", эйрподсы: "airpods", аирпадс: "airpods", наушники: "airpods",
  макбук: "macbook", макбука: "macbook", айпад: "ipad", айпада: "ipad", айпэд: "ipad", планшет: "ipad",
  эпл: "apple", эппл: "apple", апл: "apple",
};
// Короткие слова, которые в обычной речи значат другое: «расскажите ПРО айфон»,
// «С какого числа», «у вас Е…». Переводим их только рядом с цифрой модели.
const VK_AFTER_DIGIT = { про: "pro", е: "e", се: "se" };   // «17 про», «16е», «вотч се»
const VK_BEFORE_DIGIT = { с: "s" };                         // «с26»

const VK_CATEGORY_WORDS = new Set(["iphone", "galaxy", "ipad", "macbook", "airpods", "watch"]);
// Слова из названия серии, которые покупатель обычно не пишет.
const VK_OPTIONAL_WORDS = new Set(["apple", "samsung", "series"]);
const VK_INTENT = /(сколько|стоит|стоимост|цена|цену|цены|почем|почём|прайс|налич|есть ли|купить|интересует)/i;

function vkTokens(text) {
  let s = String(text || "").toLowerCase().replace(/ё/g, "е");
  // «e-sim», «есим» убираем заранее: иначе одиночная «e» превратит «16» в «16e».
  s = s.replace(/\be[\s-]*sim\b|\bе[\s-]*сим\b|\bесим\b/g, " ");
  s = s.replace(/\+/g, " plus ");
  const raw = s.match(/[a-zа-я]+|\d+/g) || [];
  return raw.map((t, i) => {
    if (VK_WORDS[t]) return VK_WORDS[t];
    const prev = raw[i - 1] || "", next = raw[i + 1] || "";
    // «17 про», «аирподс про 3», «айпад про», «про макс» — но не «расскажите про айфон».
    const prevIsModel = /^\d+$/.test(prev) || VK_CATEGORY_WORDS.has(VK_WORDS[prev] || prev);
    if (VK_AFTER_DIGIT[t] && (prevIsModel || /^(макс|max)$/.test(next))) return VK_AFTER_DIGIT[t];
    if (VK_BEFORE_DIGIT[t] && /^\d{2}$/.test(next)) return VK_BEFORE_DIGIT[t];
    return t;
  });
}

// Токены названия серии. Чип («M3», «(A16)») покупатель не называет, поэтому
// он не участвует в сравнении: «макбук эйр 13» должен найти «MacBook Air 13 M3».
function vkSeriesTokens(series) {
  const s = String(series || "").replace(/\bM\d\b/gi, " ").replace(/\(A\d+\)/gi, " ");
  return vkTokens(s).filter((t) => !VK_OPTIONAL_WORDS.has(t));
}

// Товары, о которых бот вправе говорить: видимые, с ценой, новые.
// Б/у позиции единичные и с индивидуальным состоянием, о них рассказывает продавец.
function vkSellable(catalog) {
  return ((catalog && catalog.products) || []).filter((p) => !p.hidden && Number(p.priceCash) > 0 && !p.condition);
}

function vkSeriesIndex(catalog) {
  const map = new Map();
  for (const p of vkSellable(catalog)) {
    if (!p.series) continue;
    if (!map.has(p.series)) map.set(p.series, { series: p.series, category: p.category, tokens: vkSeriesTokens(p.series), products: [] });
    map.get(p.series).products.push(p);
  }
  return [...map.values()];
}

// Какую серию имеет в виду покупатель.
// Возвращает { series: [...], brandOnly } — пусто, одна (уверенно) или несколько (переспросить).
function vkFindSeries(text, catalog) {
  let q = vkTokens(text);
  // «айфон 17 эйр» в каталоге называется «iPhone Air»: цифру отбрасываем.
  if (q.includes("air") && !q.includes("macbook") && !q.includes("ipad")) {
    q = q.filter((t) => t !== "17");
    if (!q.includes("iphone")) q.push("iphone");
  }
  const qset = new Set(q);
  const hasCategory = q.some((t) => VK_CATEGORY_WORDS.has(t));
  const hasIntent = VK_INTENT.test(String(text || ""));
  const index = vkSeriesIndex(catalog);

  const hits = [];
  for (const it of index) {
    const need = hasCategory ? it.tokens : it.tokens.filter((t) => !VK_CATEGORY_WORDS.has(t));
    if (!need.length) continue;
    if (!need.every((t) => qset.has(t))) continue;
    if (!hasCategory) {
      // Без слова «айфон/галакси/…» цифра в тексте может быть чем угодно
      // («подойду в 16 часов»). Требуем либо два совпавших слова («17 про»),
      // либо явный вопрос о цене («сколько стоит 17»).
      const hasDigit = need.some((t) => /\d/.test(t));
      if (!hasDigit) continue;
      if (need.length < 2 && !hasIntent) continue;
    }
    hits.push({ it, score: need.length });
  }
  if (hits.length) {
    const best = Math.max(...hits.map((h) => h.score));
    return { series: hits.filter((h) => h.score === best).map((h) => h.it), brandOnly: false };
  }
  // Назван только вид техники («сколько стоит айфон?») — покажем список моделей.
  if (hasCategory) {
    const cats = q.filter((t) => VK_CATEGORY_WORDS.has(t));
    const list = index.filter((it) => it.tokens.some((t) => cats.includes(t)));
    if (list.length) return { series: list, brandOnly: true };
  }
  return { series: [], brandOnly: false };
}

function vkStorageFromText(text) {
  const s = String(text || "").toLowerCase();
  const tb = s.match(/\b([12])\s*(тб|tb|терабайт|тера)/);
  if (tb) return `${tb[1]} ТБ`;
  const gb = s.match(/\b(64|128|256|512)\b/);
  return gb ? `${gb[1]} ГБ` : null;
}

// ---------------------------------------------------------------------------
// 2. Сборка ответа
// ---------------------------------------------------------------------------
const vkMoney = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₽";

// Тот же алгоритм, что slugRu() в scripts/prerender.js: по нему собраны адреса
// страниц /catalog/<раздел>/<модель>/. Менять только вместе с ним.
function vkSlug(s) {
  const map = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
  return String(s).toLowerCase().replace(/[а-яё]/g, (c) => map[c] ?? "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function vkStorageGb(label) {
  const m = String(label || "").match(/([\d.]+)\s*(ГБ|ТБ)/);
  if (!m) return 0;
  return parseFloat(m[1]) * (m[2] === "ТБ" ? 1024 : 1);
}

function vkStockWord(list) {
  if (list.some((p) => p.status === "in_stock")) return "в наличии";
  if (list.every((p) => p.status === "preorder")) return "предзаказ";
  return "под заказ";
}

function vkIsOpen(now) {
  const h = new Date((now || Date.now()) + VK_SHOP.utcOffset * 3600 * 1000).getUTCHours();
  return h >= VK_SHOP.openFrom && h < VK_SHOP.openTo;
}

function vkHandoff(now) {
  return vkIsOpen(now)
    ? "Продавец сейчас подключится и ответит на вопросы."
    : `Магазин сейчас закрыт, продавец ответит после ${VK_SHOP.openFrom}:00.`;
}

function vkSeriesAnswer(it, text, opts) {
  const site = String(opts.siteUrl || "https://appleitochka.ru").replace(/\/$/, "");
  const wanted = vkStorageFromText(text);
  let list = it.products;
  let note = "";
  if (wanted) {
    const byStorage = list.filter((p) => p.storage === wanted);
    if (byStorage.length) list = byStorage;
    else note = `На ${wanted} этой модели сейчас нет, вот что есть:\n`;
  }

  const groups = new Map();
  for (const p of list) {
    const k = p.storage && p.storage !== "—" ? p.storage : p.watchSize || "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const keys = [...groups.keys()].sort((a, b) => vkStorageGb(a) - vkStorageGb(b) || String(a).localeCompare(String(b)));
  const lines = keys.map((k) => {
    const g = groups.get(k);
    const min = Math.min(...g.map((p) => Number(p.priceCash)));
    const max = Math.max(...g.map((p) => Number(p.priceCash)));
    const price = min === max ? vkMoney(min) : `от ${vkMoney(min)}`;
    return `${k ? k + ": " : ""}${price}, ${vkStockWord(g)}`;
  });

  const many = list.length > 1;
  const phone = it.category === "iPhone" || it.category === "Samsung";
  const out = [
    `${it.series}, цены на сегодня:`,
    note + lines.join("\n"),
  ];
  if (many) out.push(phone ? "Цена зависит от цвета и версии (SIM или eSIM)." : "Цена зависит от цвета и комплектации.");
  if (phone) out.push("Можно в кредит или с зачётом вашего старого телефона (трейд-ин).");
  out.push(`Все варианты и фото: ${site}/catalog/${vkSlug(it.category)}/${vkSlug(it.series)}/`);
  out.push(vkHandoff(opts.now));
  return out.join("\n\n");
}

function vkListAnswer(list, intro, opts) {
  const rows = list
    .map((it) => ({ it, min: Math.min(...it.products.map((p) => Number(p.priceCash))) }))
    .sort((a, b) => b.min - a.min)
    .slice(0, 12)
    .map((r) => `${r.it.series}: от ${vkMoney(r.min)}`);
  return [intro, rows.join("\n"), "Напишите модель и объём памяти, например «iPhone 17 Pro 256», и я пришлю точные цены.", vkHandoff(opts.now)].join("\n\n");
}

// Кнопки под приветствием: человеку проще нажать, чем печатать, а нажатие
// отправляет текст кнопки обычным сообщением, которое разбирается как любое другое.
function vkKeyboard(catalog) {
  const top = vkSeriesIndex(catalog)
    .filter((it) => it.category === "iPhone")
    .map((it) => ({ it, min: Math.min(...it.products.map((p) => Number(p.priceCash))) }))
    .sort((a, b) => b.min - a.min)
    .slice(0, 6)
    .map((r) => r.it.series);
  const btn = (label) => ({ action: { type: "text", label: String(label).slice(0, 40) } });
  const rows = [];
  for (let i = 0; i < top.length; i += 2) rows.push(top.slice(i, i + 2).map(btn));
  rows.push([btn("Трейд-ин"), btn("Адрес и часы работы")]);
  return { inline: true, buttons: rows };
}

const VK_START = /^(начать|start|старт|привет|приветствую|здравствуйте|здраствуйте|добрый (день|вечер)|доброе утро|доброго времени суток|hi|hello)[\s!.,)]*$/i;

// Главная функция: текст покупателя → что ответить.
// kind: start | price | list | clarify | info | stub
function vkAnswer(text, payload, catalog, opts = {}) {
  const t = String(text || "").trim();
  let cmd = null;
  try { cmd = payload ? (typeof payload === "string" ? JSON.parse(payload) : payload).command : null; } catch {}

  if (cmd === "start" || VK_START.test(t)) {
    return {
      kind: "start",
      text:
        "Здравствуйте! Это магазин «Apple и точка», " + VK_SHOP.address + ".\n\n" +
        "Напишите модель, например «iPhone 17 Pro 256», или нажмите кнопку ниже. Сразу пришлю цену и наличие.",
      keyboard: vkKeyboard(catalog),
    };
  }

  const found = vkFindSeries(t, catalog);
  if (found.series.length === 1 && !found.brandOnly) {
    return { kind: "price", series: found.series[0].series, text: vkSeriesAnswer(found.series[0], t, opts) };
  }
  if (found.series.length > 1 && !found.brandOnly) {
    return { kind: "clarify", text: vkListAnswer(found.series, "Уточните, пожалуйста, какая модель интересует:", opts) };
  }

  // Вопросы не про конкретную модель. Только то, что магазин подтвердил.
  const low = t.toLowerCase().replace(/ё/g, "е");
  const info = [];
  if (/рассрочк/.test(low)) info.push("Рассрочки у нас нет. Есть кредит от банка-партнёра, оформляется в магазине.");
  else if (/кредит/.test(low)) info.push("Да, оформляем кредит от банка-партнёра прямо в магазине. Условия подскажет продавец.");
  if (/трейд|trade|обмен|зач[её]т|сдать (старый|свой)/.test(low)) info.push("Да, принимаем старый телефон в зачёт нового (трейд-ин). Напишите модель, объём памяти и состояние, продавец назовёт оценку.");
  if (/гарант/.test(low)) info.push("Гарантия магазина: 12 месяцев на новую технику, 3 месяца на наушники и б/у.");
  if (/(^|[^а-я])б\/?у([^а-я]|$)|подержан|с рук/.test(low)) info.push("Б/у техника бывает в наличии, на неё гарантия магазина 3 месяца. Что есть сейчас, подскажет продавец.");
  if (/адрес|где вы|где наход|как (доехать|добраться|найти)|часы работы|до скольки|во сколько|график|режим работы|работаете/.test(low)) {
    info.push(`Мы находимся: ${VK_SHOP.address}. Работаем ${VK_SHOP.hours}.`);
  }
  if (info.length) return { kind: "info", text: info.join("\n\n") + "\n\n" + vkHandoff(opts.now) };

  if (found.brandOnly) {
    return { kind: "list", text: vkListAnswer(found.series, "Вот что есть сейчас:", opts) };
  }

  const site = String(opts.siteUrl || "https://appleitochka.ru").replace(/\/$/, "");
  return {
    kind: "stub",
    text:
      "Спасибо за сообщение! " + vkHandoff(opts.now) + "\n\n" +
      "Чтобы узнать цену сразу, напишите модель, например «iPhone 17 Pro 256».\n" +
      `Каталог с ценами: ${site}`,
  };
}

// ---------------------------------------------------------------------------
// 3. Обмен с ВКонтакте
// ---------------------------------------------------------------------------
async function vkSend(env, peerId, text, keyboard) {
  const body = new URLSearchParams({
    access_token: String(env.VK_GROUP_TOKEN || ""),
    v: VK_API_VERSION,
    peer_id: String(peerId),
    random_id: String(Math.floor(Math.random() * 2000000000) + 1),
    message: text,
  });
  if (keyboard) body.set("keyboard", JSON.stringify(keyboard));
  try {
    const r = await fetch(VK_API + "messages.send", { method: "POST", body });
    const j = await r.json();
    if (j && j.error) console.error(`[vk-bot] messages.send: ${j.error.error_code} ${j.error.error_msg}`);
    return j;
  } catch (e) {
    console.error(`[vk-bot] messages.send: ${e}`);
    return { error: { error_msg: String(e) } };
  }
}

async function vkPeerState(env, peerId) {
  try { return JSON.parse((await env.PRODUCTS.get(`vk:peer:${peerId}`)) || "{}"); } catch { return {}; }
}
async function vkSavePeer(env, peerId, st) {
  try { await env.PRODUCTS.put(`vk:peer:${peerId}`, JSON.stringify(st), { expirationTtl: VK_PEER_TTL }); } catch {}
}

// Сообщение ОТ сообщества. Его присылают и когда пишет продавец, и когда
// отвечает сам бот. Продавца узнаём по admin_author_id, а если поля нет, по
// тому, что бот в последние секунды ничего в этот диалог не отправлял.
async function vkOnReply(env, msg, now) {
  const peerId = msg.peer_id;
  if (!peerId) return;
  const st = await vkPeerState(env, peerId);
  const byAdmin = !!msg.admin_author_id;
  const botEcho = st.botAt && now - st.botAt < VK_BOT_ECHO_WINDOW;
  if (!byAdmin && botEcho) return;
  st.humanAt = now;
  await vkSavePeer(env, peerId, st);
}

async function vkOnMessage(env, msg, deps, now) {
  const peerId = msg.peer_id;
  // Только личные диалоги с людьми: не беседы и не другие сообщества.
  if (!peerId || peerId >= 2000000000 || !(msg.from_id > 0)) return { skipped: "not_user" };
  if (String(env.VK_BOT || "").toLowerCase() === "off") return { skipped: "off" };

  const st = await vkPeerState(env, peerId);
  if (st.humanAt && now - st.humanAt < VK_HUMAN_TTL) return { skipped: "human" };

  // Счётчик ответов за час.
  if (!st.hourAt || now - st.hourAt > 3600 * 1000) { st.hourAt = now; st.n = 0; }
  if ((st.n || 0) >= VK_MAX_PER_HOUR) return { skipped: "limit" };

  let catalog = { products: [] };
  try { catalog = JSON.parse((await env.PRODUCTS.get(deps.catalogKey)) || '{"products":[]}'); } catch {}

  const ans = vkAnswer(msg.text, msg.payload, catalog, { siteUrl: env.SITE_URL, now });
  if (ans.kind === "stub" && st.stubAt && now - st.stubAt < VK_STUB_GAP) return { skipped: "stub_repeat" };

  // Отметку ставим ДО отправки: событие message_reply о нашем же ответе может
  // прийти раньше, чем вернётся messages.send.
  st.botAt = now;
  st.n = (st.n || 0) + 1;
  if (ans.kind === "stub") st.stubAt = now;
  await vkSavePeer(env, peerId, st);

  await vkSend(env, peerId, ans.text, ans.keyboard);

  if (deps.notify && String(env.VK_NOTIFY_TG || "").toLowerCase() !== "off") {
    const what = { start: "приветствие", price: `цена ${ans.series}`, list: "список моделей", clarify: "уточнение модели", info: "справка", stub: "заглушка" }[ans.kind];
    const q = String(msg.text || "").slice(0, 300) || "(без текста)";
    await deps.notify(`💬 ВКонтакте: ${q}\nБот ответил: ${what}\nДиалог: https://vk.com/gim${env.VK_GROUP_ID}?sel=${peerId}`);
  }
  return { sent: ans.kind };
}

// Точка входа: POST /api/vk/callback. ВКонтакте ждёт в ответ строку "ok"
// (или строку подтверждения) и повторяет событие, если не дождался.
async function handleVkCallback(request, env, ctx, deps) {
  const plain = (s, status = 200) => new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const body = await request.json().catch(() => null);
  if (!body || !body.type) return plain("bad_request", 400);
  if (!env.VK_GROUP_ID || String(body.group_id) !== String(env.VK_GROUP_ID)) return plain("wrong_group", 403);

  if (body.type === "confirmation") return plain(String(env.VK_CONFIRM_CODE || ""));

  const secret = String(env.VK_CALLBACK_SECRET || "");
  if (!secret || !deps.safeEqual(String(body.secret || ""), secret)) return plain("forbidden", 403);

  // Повтор события: мы на него уже отвечали (или отвечаем прямо сейчас).
  if (request.headers.get("X-Retry-Counter")) return plain("ok");

  const now = Date.now();
  let job = null;
  if (body.type === "message_new") {
    const msg = (body.object && body.object.message) || body.object || {};
    job = vkOnMessage(env, msg, deps, now);
  } else if (body.type === "message_reply") {
    job = vkOnReply(env, body.object || {}, now);
  }
  if (job) {
    const safe = job.catch((e) => console.error(`[vk-bot] ${e && e.stack ? e.stack : e}`));
    // С ctx отвечаем ВКонтакте сразу, а работу доделываем после ответа.
    if (ctx && ctx.waitUntil) ctx.waitUntil(safe);
    else await safe;
  }
  return plain("ok");
}

export { handleVkCallback, vkAnswer, vkFindSeries, vkTokens, vkSeriesTokens, vkStorageFromText, vkKeyboard, vkIsOpen };
