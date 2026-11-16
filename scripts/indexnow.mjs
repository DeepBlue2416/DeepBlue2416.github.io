// scripts/indexnow.mjs — сообщает Яндексу (и Bing) об изменённых страницах.
//
// IndexNow — открытый протокол, который Яндекс принимает официально: вместо
// того чтобы ждать, пока робот сам дойдёт до страницы по sitemap, мы сразу
// говорим «вот эти адреса новые или изменились». Это та же «ручная отправка на
// переобход» из Вебмастера, только автоматическая и без дневного лимита
// интерфейса (протокол принимает до 10 000 адресов за запрос).
//
// Google IndexNow не поддерживает — для него остаются sitemap с честными датами
// и ручной «Запросить индексирование» в Search Console.
//
// Какие адреса отправлять, решает сборка: scripts/build.js → writeSitemap()
// кладёт в indexnow-urls.json только страницы, чей HTML изменился с прошлой
// сборки. Поэтому после правки цены в CRM улетает несколько карточек, а не все
// 400 страниц — рассылать неизменённое протокол просит не делать.
//
// Запуск: в GitHub Actions ПОСЛЕ публикации сайта (поисковик сразу проверит
// файл ключа и сами страницы — они должны уже лежать на хостинге).
//   node scripts/indexnow.mjs            — отправить
//   node scripts/indexnow.mjs --dry-run  — только показать, что ушло бы

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Ключ публичный по замыслу протокола: он лежит файлом в корне сайта, и
// поисковик сверяет, что запрос пришёл от владельца домена.
const KEY = "93c43aaa81f3c927b50cef1351e64ab5";
const HOST = "appleitochka.ru";
const ENDPOINTS = [
  "https://yandex.com/indexnow",
  "https://api.indexnow.org/indexnow", // раздаёт Bing и остальным участникам
];

const dry = process.argv.includes("--dry-run");

let urls = [];
try { urls = JSON.parse(await readFile(path.join(root, "indexnow-urls.json"), "utf8")); } catch {}
urls = urls.filter((u) => typeof u === "string" && u.startsWith(`https://${HOST}/`));

if (!urls.length) {
  console.log("IndexNow: изменённых страниц нет — отправлять нечего");
  process.exit(0);
}

const body = { host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls.slice(0, 10000) };
console.log(`IndexNow: ${body.urlList.length} адресов${dry ? " (пробный запуск, ничего не отправляю)" : ""}`);
body.urlList.slice(0, 8).forEach((u) => console.log("   ", u));
if (body.urlList.length > 8) console.log(`    … и ещё ${body.urlList.length - 8}`);
if (dry) process.exit(0);

// Ответы по протоколу: 200/202 — принято; 400 — ошибка в запросе; 403 — ключ
// не найден на сайте; 422 — адреса не с этого домена; 429 — слишком часто.
// Сбой отправки деплой не валит: сайт уже опубликован, а страницы поисковик
// всё равно найдёт по sitemap — просто медленнее.
for (const ep of ENDPOINTS) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20000);
    const r = await fetch(ep, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(t);
    const txt = (await r.text()).slice(0, 200);
    const verdict = r.status === 200 || r.status === 202 ? "принято" : "ОШИБКА";
    console.log(`  ${ep} → ${r.status} ${verdict}${txt ? " · " + txt.replace(/\s+/g, " ") : ""}`);
  } catch (e) {
    console.log(`  ${ep} → не удалось отправить: ${e.message}`);
  }
}
