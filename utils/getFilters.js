"use strict";
const axios = require("axios");

const ACH = "65bd6a2de6721de8429054adb39cdc92";
const BASE = "https://getcat.net/maintenance";

// ── Ключевые слова для фильтрации нужных деталей ──────────────────────────────
// Масляный фильтр, воздушный, салонный, свечи зажигания
const PART_KEYWORDS = [
  { key: "oil_filter",    ru: "Фильтр масляный",    words: ["масл"] },
  { key: "air_filter",    ru: "Фильтр воздушный",   words: ["воздуш"] },
  { key: "cabin_filter",  ru: "Фильтр салона",       words: ["салон"] },
  { key: "spark_plug",    ru: "Свечи зажигания",     words: ["свеч", "зажига"] },
];

function classifyPart(name) {
  const lower = name.toLowerCase();
  for (const p of PART_KEYWORDS) {
    if (p.words.some(w => lower.includes(w))) return p.key;
  }
  return null;
}

// ── GET helpers ───────────────────────────────────────────────────────────────
async function get(path) {
  const url = `${BASE}/${path}${path.includes("?") ? "&" : "?"}ach=${ACH}`;
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 8000,
  });
  return data;
}

// ── 1. Получаем список брендов и ищем нужный ─────────────────────────────────
async function findBrandId(brandName) {
  const brands = await get("default/get-list");
  const q = brandName.toLowerCase().trim();
  const found = brands.find(b =>
    b.name.toLowerCase() === q ||
    b.name.toLowerCase().replace(/\s+/g, "") === q.replace(/\s+/g, "")
  );
  return found ? found.id : null;
}

// ── Скоринг совпадения модели ─────────────────────────────────────────────────
function modScore(m, q) {
  const qWords = q.toLowerCase().split(/\s+/).filter(Boolean);
  const mWords = m.name.toLowerCase().split(/\s+/).filter(w => !/^\d/.test(w));
  const covered = qWords.filter(w => mWords.includes(w)).length;
  const extra   = mWords.filter(w => !qWords.includes(w)).length;
  return covered * 10 - extra;
}

// ── Проверяем совпадение кода двигателя ──────────────────────────────────────
function engineMatches(vehicle, codes) {
  const vCodes = (vehicle.engineCode || "")
    .toUpperCase()
    .split(/[;,\s]+/)
    .map(c => c.trim())
    .filter(Boolean);
  return codes.some(c =>
    vCodes.includes(c) ||
    vCodes.some(vc => vc.startsWith(c) || c.startsWith(vc))
  );
}

// ── 2+3. Ищем лучшую пару (мод + версия) для данного авто ────────────────────
// Логика:
//   1. Собираем все модификации подходящие по году и имени модели
//   2. Сортируем по скорингу имени
//   3. Перебираем по убыванию скора: ищем версию с совпадающим кодом мотора
//   4. Если ни в одной моде нет нашего кода — возвращаем лучшую модель + первую версию
async function findModAndVehicle(brandId, modelName, year, engineCode) {
  const mods = await get(`modifications/get-list?brand=${brandId}`);
  const q = modelName.toLowerCase().trim();

  const candidates = mods.filter(m => {
    const name = m.name.toLowerCase();
    const firstWord = q.split(/\s+/)[0];
    const nameMatch = name.split(/\s+/).includes(firstWord) || name.includes(firstWord);
    if (!nameMatch) return false;
    if (!year) return true;
    const from = m.productionYearFrom || 0;
    const to   = m.productionYearTo   || 9999;
    return year >= from && year <= to;
  });

  if (!candidates.length) return { mod: null, vehicle: null };

  candidates.sort((a, b) => modScore(b, q) - modScore(a, q));

  const codes = engineCode
    ? engineCode.toUpperCase().split(/[;,\s]+/).map(c => c.trim()).filter(Boolean)
    : [];

  // Перебираем кандидатов: ищем тот где есть точное совпадение кода мотора
  if (codes.length) {
    for (const mod of candidates) {
      const vehicles = await get(`vehicles/get-list?mod=${mod.id}`);
      const matched = vehicles.find(v => engineMatches(v, codes));
      if (matched) return { mod, vehicle: matched };
    }
  }

  // Точного совпадения нет — берём лучший мод, первую версию
  const bestMod = candidates[0];
  const fallbackVehicles = await get(`vehicles/get-list?mod=${bestMod.id}`);
  return { mod: bestMod, vehicle: fallbackVehicles[0] || null };
}

// ── 4. Получаем список деталей и классифицируем ───────────────────────────────
async function getVehicleDetails(vehicleId) {
  const data = await get(`details/get-list?vehicle=${vehicleId}`);
  const list  = data.list || data || [];

  const result = {
    oil_filter:   [],
    air_filter:   [],
    cabin_filter: [],
    spark_plug:   [],
    other:        [],
  };

  for (const item of list) {
    const key = classifyPart(item.name);
    const entry = {
      name:      item.name,
      partCode:  item.partCode,
      count:     item.count,
      comment:   (item.commentary || "").trim(),
    };
    if (key) result[key].push(entry);
    else     result.other.push(entry);
  }

  return result;
}

// ── MAIN — публичная функция ──────────────────────────────────────────────────
/**
 * Возвращает оригинальные артикулы для автомобиля.
 *
 * @param {object} car  — объект из fetchCarInfo:
 *   { brand, model, year, engine: { code } }
 *
 * @returns {object|null}
 *   {
 *     vehicleId,
 *     oil_filter:   [{ name, partCode, count, comment }],
 *     air_filter:   [...],
 *     cabin_filter: [...],
 *     spark_plug:   [...],
 *     other:        [...],  // остальные детали (тормозные и т.д.)
 *   }
 */
async function getOriginalFilters(car) {
  try {
    console.log(`[getFilters] ${car.brand} ${car.model} ${car.year} engine=${car.engine?.code}`);

    const brandId = await findBrandId(car.brand);
    if (!brandId) {
      console.log(`[getFilters] brand not found: ${car.brand}`);
      return null;
    }

    const { mod, vehicle } = await findModAndVehicle(brandId, car.model, car.year, car.engine?.code);
    if (!mod) {
      console.log(`[getFilters] modification not found: ${car.model} ${car.year}`);
      return null;
    }
    if (!vehicle) {
      console.log(`[getFilters] vehicle not found for engine: ${car.engine?.code}`);
      return null;
    }

    const vehicleId = vehicle.id;
    const details = await getVehicleDetails(vehicleId);

    // Хлебные крошки каталога ТО: "Sandero II 2013–2018 / D4F 1.1"
    const yearRange = [mod.productionYearFrom, mod.productionYearTo]
      .filter(Boolean).join("–");
    const modLabel = [mod.name, yearRange].filter(Boolean).join(" ");
    const engLabel = [vehicle.engineCode, vehicle.engineVolume]
      .filter(Boolean).join(" ");
    const catalogBreadcrumb = [car.brand, modLabel, engLabel]
      .filter(Boolean).join(" / ");

    console.log(
      `[getFilters] ok: vehicleId=${vehicleId} bc="${catalogBreadcrumb}"`,
      `oil=${details.oil_filter.length}`,
      `air=${details.air_filter.length}`,
      `cabin=${details.cabin_filter.length}`,
      `spark=${details.spark_plug.length}`
    );

    const catalogUrl = `https://getcat.net/get/demo-maintenance#brand=${brandId}&mod=${mod.id}&veh=${vehicleId}`;

    return { vehicleId, brandId, modId: mod.id, catalogBreadcrumb, catalogUrl, ...details };
  } catch (e) {
    console.error("[getFilters] error:", e.message);
    return null;
  }
}

module.exports = { getOriginalFilters };