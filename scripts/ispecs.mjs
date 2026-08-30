// ispecs.mjs — подробные характеристики iPhone (уровень маркетплейса).
// Значения выверены по GSMArena/Apple (сентябрь 2025 / 2024). Используется и
// генератором каталога (gen-catalog.mjs), и скриптом применения к каталогу (apply-specs.mjs).

export const SENS = "акселерометр, гироскоп, барометр, датчик приближения, датчик освещённости, компас";
export const SENS_PRO = SENS + ", сканер LiDAR";
export const FEAT_CAM = "Apple Intelligence, Dynamic Island, кнопка действия, кнопка управления камерой, Siri";
export const FEAT_BASIC = "Apple Intelligence, кнопка действия, Siri";

export function iSpec(m) {
  const tech = m.tech || (m.refresh >= 120 ? "Super Retina XDR OLED (LTPO)" : "Super Retina XDR OLED");
  const camWord = m.camN >= 3 ? "тройная" : (m.camN === 2 ? "двойная" : "одинарная");
  return {
    "Тип": "смартфон",
    "Производитель": "Apple",
    "Год выхода": String(m.year),
    "Операционная система": "iOS",
    "Версия ОС": m.os,
    "Диагональ экрана (дюйм)": m.diag,
    "Технология изготовления экрана": tech,
    "Разрешение дисплея": m.res,
    "Плотность пикселей (ppi)": String(m.ppi),
    "Частота обновления экрана (Гц)": String(m.refresh),
    "Вид защитного покрытия": m.shield,
    "Производитель процессора": "Apple",
    "Модель процессора": m.chip,
    "Количество ядер": String(m.cores || 6),
    "Техпроцесс (нм)": String(m.nm || 3),
    "Оперативная память": m.ram,
    "Слот для карты памяти": "нет",
    "Материал корпуса": m.frame,
    "Материал задней панели": m.back || "стекло",
    "Степень защиты": "IP68",
    "Ёмкость батареи (mAh)": String(m.battery),
    "Воспроизведение видео (ч)": String(m.video),
    "Быстрая зарядка": "да",
    "Беспроводная зарядка": "MagSafe, Qi2",
    "Зарядное устройство в комплекте": "нет",
    "Количество основных камер": String(m.camN),
    "Основная камера": `${camWord}, ${m.mp} Мп`,
    "Конфигурация камер (Мп)": m.camCfg,
    "Оптический зум (фото)": m.optZoom,
    "Цифровой зум (фото)": m.digZoom,
    "Оптическая стабилизация основной камеры": "да",
    "Автофокусировка основной камеры": "да",
    "Тип вспышки": "True Tone (светодиодная)",
    "Формат видеосъёмки": "Full HD, HD, Ultra HD 4K",
    "Фронтальная камера (Мп)": String(m.front),
    "Автофокусировка селфи-камеры": "да",
    "Поддержка NFC": "да",
    "Поддержка 2G": "да",
    "Поддержка 3G": "да",
    "Поддержка 4G (LTE)": "да",
    "Поддержка 5G": "да",
    "Формат SIM-карт": "Nano-SIM, eSIM",
    "Количество SIM-карт, шт": "2 (Nano-SIM + eSIM)",
    "Поддержка eSIM": "да",
    "Разъём": "USB-C",
    "Стереодинамики": "да",
    "Версия Bluetooth": m.bt || "5.3",
    "Стандарт Wi-Fi": m.wifi,
    "Поддержка GPS": "да",
    "Поддержка ГЛОНАСС": "да",
    "Поддержка OTG": "да",
    "Распознавание лица": "да (Face ID)",
    "Датчики": m.sensors,
    "Голосовой помощник": "Siri",
    "Особенности": m.features,
    "Комплектация": "документация, кабель USB-C",
    "Ширина (мм)": String(m.w),
    "Высота (мм)": String(m.h),
    "Толщина (мм)": String(m.t),
    "Вес (г)": String(m.weight),
    "Гарантия": "12 мес.",
  };
}

// Выверенные значения (GSMArena, сентябрь 2025 / 2024)
export const I_MODELS = {
  "iPhone 17 Pro Max": {year:2025,os:"iOS 26",diag:"6.9",res:"2868x1320",ppi:460,refresh:120,shield:"Ceramic Shield 2",chip:"Apple A19 Pro",cores:6,nm:3,ram:"12 ГБ",frame:"алюминий",battery:4823,video:39,camN:3,mp:48,camCfg:"48+48+48",optZoom:"4x",digZoom:"40x",front:18,bt:"6.0",wifi:"Wi-Fi 7",sensors:SENS_PRO,features:FEAT_CAM,w:78,h:163.4,t:8.8,weight:233},
  "iPhone 17 Pro": {year:2025,os:"iOS 26",diag:"6.3",res:"2622x1206",ppi:460,refresh:120,shield:"Ceramic Shield 2",chip:"Apple A19 Pro",cores:6,nm:3,ram:"12 ГБ",frame:"алюминий",battery:3998,video:33,camN:3,mp:48,camCfg:"48+48+48",optZoom:"4x",digZoom:"40x",front:18,bt:"6.0",wifi:"Wi-Fi 7",sensors:SENS_PRO,features:FEAT_CAM,w:71.9,h:150,t:8.8,weight:206},
  "iPhone 17": {year:2025,os:"iOS 26",diag:"6.3",res:"2622x1206",ppi:460,refresh:120,shield:"Ceramic Shield 2",chip:"Apple A19",cores:6,nm:3,ram:"8 ГБ",frame:"алюминий",battery:3692,video:30,camN:2,mp:48,camCfg:"48+48",optZoom:"2x (оптическое качество)",digZoom:"10x",front:18,bt:"6.0",wifi:"Wi-Fi 7",sensors:SENS,features:FEAT_CAM,w:71.5,h:149.6,t:8.0,weight:177},
  "iPhone 17e": {year:2026,os:"iOS 26.3",diag:"6.1",res:"2532x1170",ppi:460,refresh:60,shield:"Ceramic Shield",chip:"Apple A19",cores:6,nm:3,ram:"8 ГБ",frame:"алюминий",battery:4005,video:26,camN:1,mp:48,camCfg:"48",optZoom:"—",digZoom:"5x",front:12,bt:"5.3",wifi:"Wi-Fi 6",sensors:SENS,features:FEAT_BASIC,w:71.5,h:146.7,t:7.8,weight:169},
  "iPhone Air": {year:2025,os:"iOS 26",diag:"6.5",res:"2736x1260",ppi:460,refresh:120,shield:"Ceramic Shield 2",chip:"Apple A19 Pro",cores:6,nm:3,ram:"12 ГБ",frame:"титан",battery:3149,video:27,camN:1,mp:48,camCfg:"48",optZoom:"—",digZoom:"10x",front:18,bt:"6.0",wifi:"Wi-Fi 7",sensors:SENS_PRO,features:FEAT_CAM,w:74.7,h:156.2,t:5.6,weight:165},
  "iPhone 16 Pro Max": {year:2024,os:"iOS 18",diag:"6.9",res:"2868x1320",ppi:460,refresh:120,shield:"Ceramic Shield",chip:"Apple A18 Pro",cores:6,nm:3,ram:"8 ГБ",frame:"титан",battery:4685,video:33,camN:3,mp:48,camCfg:"48+48+12",optZoom:"5x",digZoom:"25x",front:12,bt:"5.3",wifi:"Wi-Fi 7",sensors:SENS_PRO,features:FEAT_CAM,w:77.6,h:163,t:8.3,weight:227},
  "iPhone 16 Pro": {year:2024,os:"iOS 18",diag:"6.3",res:"2622x1206",ppi:460,refresh:120,shield:"Ceramic Shield",chip:"Apple A18 Pro",cores:6,nm:3,ram:"8 ГБ",frame:"титан",battery:3582,video:27,camN:3,mp:48,camCfg:"48+48+12",optZoom:"5x",digZoom:"25x",front:12,bt:"5.3",wifi:"Wi-Fi 7",sensors:SENS_PRO,features:FEAT_CAM,w:71.5,h:149.6,t:8.25,weight:199},
  "iPhone 16 Plus": {year:2024,os:"iOS 18",diag:"6.7",res:"2796x1290",ppi:460,refresh:60,shield:"Ceramic Shield",chip:"Apple A18",cores:6,nm:3,ram:"8 ГБ",frame:"алюминий",battery:4674,video:27,camN:2,mp:48,camCfg:"48+12",optZoom:"2x (оптическое качество)",digZoom:"10x",front:12,bt:"5.3",wifi:"Wi-Fi 7",sensors:SENS,features:FEAT_CAM,w:77.8,h:160.9,t:7.8,weight:199},
  "iPhone 16": {year:2024,os:"iOS 18",diag:"6.1",res:"2556x1179",ppi:460,refresh:60,shield:"Ceramic Shield",chip:"Apple A18",cores:6,nm:3,ram:"8 ГБ",frame:"алюминий",battery:3561,video:22,camN:2,mp:48,camCfg:"48+12",optZoom:"2x (оптическое качество)",digZoom:"10x",front:12,bt:"5.3",wifi:"Wi-Fi 7",sensors:SENS,features:FEAT_CAM,w:71.6,h:147.6,t:7.8,weight:170},
  "iPhone 16e": {year:2025,os:"iOS 18.3",diag:"6.1",res:"2532x1170",ppi:460,refresh:60,shield:"Ceramic Shield",chip:"Apple A18",cores:6,nm:3,ram:"8 ГБ",frame:"алюминий",battery:4005,video:26,camN:1,mp:48,camCfg:"48",optZoom:"—",digZoom:"10x",front:12,bt:"5.3",wifi:"Wi-Fi 6",sensors:SENS,features:FEAT_BASIC,w:71.5,h:146.7,t:7.8,weight:167},
};
