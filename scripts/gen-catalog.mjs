// gen-catalog.mjs — генератор SKU-каталога (products.json + products.js)
// Каждая строка — конкретная модификация: категория, бренд, серия, цвет, память/размер, SIM, цена, статус.
import { writeFileSync } from "node:fs";

const rub = (n) => Math.round(n / 10) * 10;
const card = (cash) => rub(cash * 1.05);

// slug
const tr = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"c",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya"," ":"-","/":"-" };
const slug = (s) => s.toLowerCase().split("").map(c=>tr[c]??c).join("").replace(/[^a-z0-9-]+/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"");

const rows = [];
let SEQ = 0;
function add(o) {
  const parts = [o.series, o.color, o.storage||o.watchSize||"", o.sim||""].filter(Boolean).join("-");
  const id = slug(o.category+"-"+parts) + "-" + (SEQ++);
  rows.push({
    id,
    category: o.category, brand: o.brand, series: o.series, seriesOrder: o.order,
    name: o.series,
    color: o.color, colorHex: o.colorHex,
    storage: o.storage || "—",
    watchSize: o.watchSize || null,
    sim: o.sim || "—",
    image: o.image || null,
    priceCash: o.cash, priceCard: card(o.cash),
    status: o.status, badge: o.badge || "",
    specs: o.specs || {},
  });
}

// helper: cartesian for phones (colors × storages × sims), с точечной недоступностью
function phone({category, brand, series, order, colors, storages, sims, base, specs, badge}) {
  colors.forEach((c, ci) =>
    storages.forEach((st, si) =>
      sims.forEach((sim, mi) => {
        // цена растёт со storage
        const cash = base + si * Math.round(base * 0.12) + (sim.includes("2 eSIM") ? 1500 : 0);
        // немного недоступных комбинаций для демонстрации динамики
        const outOfStock = (ci === colors.length - 1 && si === storages.length - 1) || (mi === sims.length - 1 && si === 0 && ci === 1);
        add({ category, brand, series, order, color: c.n, colorHex: c.h, storage: st, sim,
              cash, status: outOfStock ? "on_order" : "in_stock", badge: badge && ci===0 && si===0 && mi===0 ? badge : "", specs });
      })
    )
  );
}

const SIM2 = ["eSIM", "2 eSIM"];
const SIM_DUAL = ["eSIM", "SIM + eSIM"];

// ---------------- iPhone ----------------
const iSpecsPro = { "Экран":"LTPO OLED 120 Гц","Чип":"A19 Pro","Камера":"48+48+48 Мп","Материал":"Титан" };
const iSpecs = { "Экран":"OLED","Чип":"A19","Камера":"48+12 Мп","Материал":"Алюминий" };
phone({category:"iPhone",brand:"Apple",series:"iPhone 17 Pro Max",order:1718,badge:"Новинка",
  colors:[{n:"Титановый чёрный",h:"#3b3b3d"},{n:"Титановый белый",h:"#e6e3dd"},{n:"Титановый пустынный",h:"#b89a7e"}],
  storages:["256 ГБ","512 ГБ","1 ТБ"],sims:SIM2,base:139990,specs:iSpecsPro});
phone({category:"iPhone",brand:"Apple",series:"iPhone 17 Pro",order:1717,
  colors:[{n:"Титановый чёрный",h:"#3b3b3d"},{n:"Титановый белый",h:"#e6e3dd"},{n:"Титановый синий",h:"#2f4a6d"}],
  storages:["256 ГБ","512 ГБ"],sims:SIM2,base:124990,specs:iSpecsPro});
phone({category:"iPhone",brand:"Apple",series:"iPhone 17",order:1715,
  colors:[{n:"Чёрный",h:"#2b2b2d"},{n:"Белый",h:"#ededed"},{n:"Голубой",h:"#a7c7e7"}],
  storages:["128 ГБ","256 ГБ"],sims:SIM2,base:89990,specs:iSpecs});
phone({category:"iPhone",brand:"Apple",series:"iPhone Air",order:1714,badge:"Тонкий",
  colors:[{n:"Титановый чёрный",h:"#3b3b3d"},{n:"Титановый золотой",h:"#cbb489"}],
  storages:["256 ГБ","512 ГБ"],sims:["2 eSIM"],base:114990,specs:{...iSpecsPro,"Толщина":"5.6 мм"}});
phone({category:"iPhone",brand:"Apple",series:"iPhone 16 Pro Max",order:1616,
  colors:[{n:"Титановый чёрный",h:"#3b3b3d"},{n:"Титановый пустынный",h:"#b89a7e"}],
  storages:["256 ГБ","512 ГБ"],sims:SIM2,base:119990,specs:{...iSpecsPro,"Чип":"A18 Pro"}});
phone({category:"iPhone",brand:"Apple",series:"iPhone 16 Pro",order:1615,
  colors:[{n:"Титановый чёрный",h:"#3b3b3d"},{n:"Титановый белый",h:"#e6e3dd"}],
  storages:["128 ГБ","256 ГБ"],sims:SIM2,base:99990,specs:{...iSpecsPro,"Чип":"A18 Pro"}});
phone({category:"iPhone",brand:"Apple",series:"iPhone 16",order:1610,
  colors:[{n:"Ультрамарин",h:"#4a5cc4"},{n:"Розовый",h:"#f2c9d4"},{n:"Чёрный",h:"#2b2b2d"}],
  storages:["128 ГБ","256 ГБ"],sims:SIM2,base:74990,specs:{...iSpecs,"Чип":"A18"}});
phone({category:"iPhone",brand:"Apple",series:"iPhone 15",order:1500,badge:"Выгодно",
  colors:[{n:"Чёрный",h:"#2b2b2d"},{n:"Голубой",h:"#bcd4d6"}],
  storages:["128 ГБ","256 ГБ"],sims:SIM_DUAL,base:59990,specs:{...iSpecs,"Чип":"A16"}});

// ---------------- Samsung ----------------
phone({category:"Samsung",brand:"Samsung",series:"Galaxy S24 Ultra",order:2418,badge:"Хит",
  colors:[{n:"Titanium Black",h:"#2c2c2e"},{n:"Titanium Gray",h:"#8a8a8f"},{n:"Titanium Violet",h:"#b7a7d6"}],
  storages:["256 ГБ","512 ГБ"],sims:SIM_DUAL,base:104990,specs:{"Экран":"6.8\" AMOLED 120 Гц","Чип":"Snapdragon 8 Gen 3","Стилус":"S Pen"}});
phone({category:"Samsung",brand:"Samsung",series:"Galaxy S24",order:2410,
  colors:[{n:"Onyx Black",h:"#2c2c2e"},{n:"Marble Gray",h:"#9a9a9f"}],
  storages:["128 ГБ","256 ГБ"],sims:SIM_DUAL,base:69990,specs:{"Экран":"6.2\" AMOLED","Чип":"Exynos 2400"}});
phone({category:"Samsung",brand:"Samsung",series:"Galaxy A55",order:2055,
  colors:[{n:"Awesome Navy",h:"#2b3a55"},{n:"Awesome Lilac",h:"#c9b8e0"}],
  storages:["128 ГБ","256 ГБ"],sims:SIM_DUAL,base:34990,specs:{"Экран":"6.6\" Super AMOLED","Чип":"Exynos 1480"}});

// ---------------- Xiaomi ----------------
phone({category:"Xiaomi",brand:"Xiaomi",series:"Xiaomi 14",order:1400,badge:"Leica",
  colors:[{n:"Чёрный",h:"#2b2b2d"},{n:"Белый",h:"#ededed"},{n:"Зелёный",h:"#3f6f52"}],
  storages:["256 ГБ","512 ГБ"],sims:SIM_DUAL,base:64990,specs:{"Экран":"6.36\" LTPO","Чип":"Snapdragon 8 Gen 3","Камера":"Leica"}});
phone({category:"Xiaomi",brand:"Xiaomi",series:"Redmi Note 13 Pro",order:1313,
  colors:[{n:"Midnight Black",h:"#25252a"},{n:"Ocean Teal",h:"#2f6d78"}],
  storages:["256 ГБ"],sims:SIM_DUAL,base:24990,specs:{"Экран":"6.67\" AMOLED 120 Гц","Камера":"200 Мп"}});

// ---------------- Nothing ----------------
phone({category:"Nothing Phone",brand:"Nothing",series:"Nothing Phone (2)",order:1200,badge:"Glyph",
  colors:[{n:"White",h:"#ededed"},{n:"Dark Gray",h:"#3a3a3c"}],
  storages:["256 ГБ","512 ГБ"],sims:SIM_DUAL,base:49990,specs:{"Экран":"6.7\" LTPO OLED","Особенность":"Glyph Interface"}});
phone({category:"Nothing Phone",brand:"Nothing",series:"Nothing Phone (2a)",order:1120,
  colors:[{n:"Black",h:"#2b2b2d"},{n:"Milk",h:"#f0efe9"}],
  storages:["128 ГБ","256 ГБ"],sims:SIM_DUAL,base:29990,specs:{"Экран":"6.7\" AMOLED 120 Гц"}});

// ---------------- iPad ----------------
function tablet({series,order,colors,storages,base,badge,specs}) {
  colors.forEach((c,ci)=>storages.forEach((st,si)=>{
    add({category:"iPad",brand:"Apple",series,order,color:c.n,colorHex:c.h,storage:st,sim: si%2? "SIM + eSIM":"—",
      cash: base + si*Math.round(base*0.18), status: (ci===colors.length-1&&si===storages.length-1)?"on_order":"in_stock",
      badge: badge&&ci===0&&si===0?badge:"", specs});
  }));
}
tablet({series:"iPad Pro 13 M4",order:404,badge:"OLED",colors:[{n:"Космос",h:"#2f3033"},{n:"Серебристый",h:"#d9dadb"}],storages:["256 ГБ","512 ГБ","1 ТБ"],base:149990,specs:{"Экран":"13\" Ultra Retina XDR OLED","Чип":"Apple M4"}});
tablet({series:"iPad Air 11 M2",order:302,colors:[{n:"Синий",h:"#6b7fa6"},{n:"Серый",h:"#8b8d90"},{n:"Сияющая звезда",h:"#e6ddd0"}],storages:["128 ГБ","256 ГБ"],base:69990,specs:{"Экран":"11\" Liquid Retina","Чип":"Apple M2"}});
tablet({series:"iPad 10",order:100,badge:"Выгодно",colors:[{n:"Серебристый",h:"#d9dadb"},{n:"Синий",h:"#5b8aa6"}],storages:["64 ГБ","256 ГБ"],base:39990,specs:{"Экран":"10.9\" Liquid Retina","Чип":"A14"}});

// ---------------- MacBook ----------------
function laptop({series,order,colors,storages,base,badge,specs}) {
  colors.forEach((c,ci)=>storages.forEach((st,si)=>{
    add({category:"MacBook",brand:"Apple",series,order,color:c.n,colorHex:c.h,storage:st,sim:"—",
      cash: base + si*Math.round(base*0.15), status: (ci===0&&si===storages.length-1)?"on_order":"in_stock",
      badge: badge&&ci===0&&si===0?badge:"", specs});
  }));
}
laptop({series:"MacBook Pro 14 M4",order:504,badge:"Pro",colors:[{n:"Космос",h:"#2f3033"},{n:"Серебристый",h:"#d9dadb"}],storages:["512 ГБ","1 ТБ"],base:199990,specs:{"Экран":"14\" Liquid Retina XDR","Чип":"Apple M4","Память":"16 ГБ"}});
laptop({series:"MacBook Air 15 M3",order:403,colors:[{n:"Тёмная ночь",h:"#2e3641"},{n:"Сияющая звезда",h:"#e6ddd0"},{n:"Серебристый",h:"#d9dadb"}],storages:["256 ГБ","512 ГБ"],base:139990,specs:{"Экран":"15\" Liquid Retina","Чип":"Apple M3"}});
laptop({series:"MacBook Air 13 M3",order:402,badge:"Хит",colors:[{n:"Тёмная ночь",h:"#2e3641"},{n:"Серебристый",h:"#d9dadb"}],storages:["256 ГБ","512 ГБ"],base:114990,specs:{"Экран":"13.6\" Liquid Retina","Чип":"Apple M3"}});

// ---------------- Смарт-часы (Watch) — размер корпуса в мм ----------------
function watch({series,order,colors,sizes,base,badge,specs}) {
  colors.forEach((c,ci)=>sizes.forEach((sz,si)=>{
    add({category:"Смарт-часы",brand:"Apple",series,order,color:c.n,colorHex:c.h,storage:"—",watchSize:sz,sim: si%2?"eSIM":"—",
      cash: base + si*4000, status: (ci===colors.length-1&&si===0)?"on_order":"in_stock", badge: badge&&ci===0&&si===0?badge:"", specs});
  }));
}
watch({series:"Apple Watch Series 10",order:910,badge:"Новинка",colors:[{n:"Чёрный оникс",h:"#1c1c1e"},{n:"Розовое золото",h:"#e2c3b8"},{n:"Серебристый",h:"#d9dadb"}],sizes:["42 мм","46 мм"],base:44990,specs:{"Экран":"LTPO3 OLED","Датчики":"ЭКГ, SpO₂"}});
watch({series:"Apple Watch Ultra 2",order:820,colors:[{n:"Натуральный титан",h:"#b7b2a8"},{n:"Чёрный титан",h:"#2a2a2c"}],sizes:["49 мм"],base:89990,specs:{"Корпус":"Титан","Автономность":"до 36 ч"}});
watch({series:"Apple Watch SE",order:700,badge:"Выгодно",colors:[{n:"Тёмная ночь",h:"#2e3641"},{n:"Серебристый",h:"#d9dadb"}],sizes:["40 мм","44 мм"],base:27990,specs:{"Экран":"Retina OLED"}});

// ---------------- Наушники (AirPods) ----------------
function buds({series,order,colors,base,badge,specs}) {
  colors.forEach((c,ci)=>add({category:"Наушники",brand:"Apple",series,order,color:c.n,colorHex:c.h,storage:"—",sim:"—",
    cash: base, status:"in_stock", badge: badge&&ci===0?badge:"", specs}));
}
buds({series:"AirPods Pro 2",order:602,badge:"Хит",colors:[{n:"Белый",h:"#f4f4f5"}],base:22990,specs:{"Шумоподавление":"ANC 2×","Чип":"H2"}});
buds({series:"AirPods 4 ANC",order:601,colors:[{n:"Белый",h:"#f4f4f5"}],base:17990,specs:{"Шумоподавление":"ANC","Чип":"H2"}});
buds({series:"AirPods Max",order:500,colors:[{n:"Тёмная ночь",h:"#2e3641"},{n:"Серебристый",h:"#d9dadb"},{n:"Сиреневый",h:"#c9b8e0"}],base:54990,specs:{"Тип":"Полноразмерные","Звук":"Spatial Audio"}});

// ---------------- Аксессуары ----------------
function acc({series,order,colors,base,specs}) {
  colors.forEach((c,ci)=>add({category:"Аксессуары",brand:"Apple",series,order,color:c.n,colorHex:c.h,storage:"—",sim:"—",
    cash: base, status:"in_stock", specs}));
}
acc({series:"Зарядка MagSafe 25 Вт",order:320,colors:[{n:"Белый",h:"#f4f4f5"}],base:4990,specs:{"Мощность":"25 Вт"}});
acc({series:"Кабель USB-C 1 м",order:310,colors:[{n:"Белый",h:"#f4f4f5"}],base:1990,specs:{"Длина":"1 м"}});
acc({series:"Apple Pencil Pro",order:300,colors:[{n:"Белый",h:"#f4f4f5"}],base:12990,specs:{"Функции":"Нажатие, Find My"}});
acc({series:"Чехол Silicone Case",order:290,colors:[{n:"Чёрный",h:"#2b2b2d"},{n:"Синий",h:"#3a5a8c"},{n:"Розовый",h:"#f2c9d4"}],base:3990,specs:{"Материал":"Силикон"}});

// ---------------- категории (L1) ----------------
const categories = [
  { key: "iPhone", title: "iPhone", brand: "Apple", accent: "#3b3b3d", glyph: "iPhone" },
  { key: "Samsung", title: "Samsung", brand: "Samsung", accent: "#2b3a55", glyph: "iPhone" },
  { key: "Xiaomi", title: "Xiaomi", brand: "Xiaomi", accent: "#ff6900", glyph: "iPhone" },
  { key: "Nothing Phone", title: "Nothing Phone", brand: "Nothing", accent: "#111114", glyph: "iPhone" },
  { key: "iPad", title: "iPad", brand: "Apple", accent: "#2f3033", glyph: "iPad" },
  { key: "MacBook", title: "MacBook", brand: "Apple", accent: "#4b4e57", glyph: "Mac" },
  { key: "Смарт-часы", title: "Смарт-часы", brand: "Apple", accent: "#1c1c1e", glyph: "Watch" },
  { key: "Наушники", title: "Наушники", brand: "Apple", accent: "#0582F6", glyph: "AirPods" },
  { key: "Аксессуары", title: "Аксессуары", brand: "Apple", accent: "#6e6e73", glyph: "accessory" },
];

const catalog = {
  meta: { currency: "₽", city: "Таганрог", updatedAt: "2025-07-28", note: "Каждая строка — конкретная модификация (SKU): цвет + память/размер + SIM." },
  categories,
  products: rows,
};

writeFileSync(new URL("../src/data/products.json", import.meta.url), JSON.stringify(catalog, null, 2));
writeFileSync(new URL("../src/data/products.js", import.meta.url),
  "// Автосгенерировано scripts/gen-catalog.mjs — встроенный каталог (SKU-матрица).\nwindow.__CATALOG__ = " + JSON.stringify(catalog) + ";\n");
console.log("SKU:", rows.length, "категорий:", categories.length);
