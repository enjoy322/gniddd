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

// ── 2. Получаем модификации и ищем подходящую по году/модели ─────────────────
async function findMod(brandId, modelName, year) {
  const mods = await get(`modifications/get-list?brand=${brandId}`);
  const q = modelName.toLowerCase().trim();

  // Прямое совпадение имени модели + попадание в года производства
  const candidates = mods.filter(m => {
    const name = m.name.toLowerCase();
    // Гибкое совпадение: "Sandero II" ≈ "sandero"
    const nameMatch = name.includes(q) || q.includes(name.split(" ")[0]);
    if (!nameMatch) return false;
    if (!year) return true;
    const from = m.productionYearFrom || 0;
    const to   = m.productionYearTo   || 9999;
    return year >= from && year <= to;
  });

  if (!candidates.length) return null;
  // Берём наиболее специфичное (длиннее имя = точнее)
  candidates.sort((a, b) => b.name.length - a.name.length);
  return candidates[0]; // возвращаем объект целиком, не только id
}

// ── 3. Получаем конкретную версию по коду двигателя ──────────────────────────
async function findVehicle(modId, engineCode) {
  const vehicles = await get(`vehicles/get-list?mod=${modId}`);
  if (!engineCode) return vehicles[0] || null;

  const codes = engineCode
    .toUpperCase()
    .split(/[;,\s]+/)
    .map(c => c.trim())
    .filter(Boolean);

  const found = vehicles.find(v => {
    const vCodes = (v.engineCode || "")
      .toUpperCase()
      .split(/[;,\s]+/)
      .map(c => c.trim());
    return codes.some(c => vCodes.includes(c));
  });

  // Фолбэк — первая версия
  return found || vehicles[0] || null; // объект целиком
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

    const mod = await findMod(brandId, car.model, car.year);
    if (!mod) {
      console.log(`[getFilters] modification not found: ${car.model} ${car.year}`);
      return null;
    }

    const vehicle = await findVehicle(mod.id, car.engine?.code);
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

    return { vehicleId, catalogBreadcrumb, ...details };
  } catch (e) {
    console.error("[getFilters] error:", e.message);
    return null;
  }
}

module.exports = { getOriginalFilters };