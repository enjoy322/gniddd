"use strict";
const axios = require("axios");
const fs    = require("fs");

const ACH = "65bd6a2de6721de8429054adb39cdc92";
const BASE = "https://getcat.net/maintenance";
const OUT  = "./filter-catalog.json";

// Названия запчастей которые нас интересуют → ключ в результате
const FILTER_MAP = {
  "фильтр масляный":        "oil_filter",
  "фильтр воздушный":       "air_filter",
  "фильтр салона":          "cabin_filter",
  "фильтр топливный":       "fuel_filter",
  "фильтр топлива":         "fuel_filter",
};

function classifyPart(name) {
  const n = name.toLowerCase();
  for (const [key, val] of Object.entries(FILTER_MAP)) {
    if (n.includes(key)) return val;
  }
  return null;
}

async function get(url) {
  const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  return data;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function build() {
  const catalog = {}; // engine_code → { oil_filter, air_filter, ... }

  console.log("[1/4] Загружаю марки...");
  const brands = await get(`${BASE}/default/get-list?ach=${ACH}`);
  console.log(`      ${brands.length} марок`);

  for (const brand of brands) {
    console.log(`\n[brand] ${brand.name} (${brand.id})`);

    const mods = await get(`${BASE}/modifications/get-list?brand=${brand.id}&ach=${ACH}`);
    await sleep(200);

    for (const mod of mods) {
      const vehicles = await get(`${BASE}/vehicles/get-list?mod=${mod.id}&ach=${ACH}`);
      await sleep(200);

      for (const vehicle of vehicles) {
        const details = await get(`${BASE}/details/get-list?vehicle=${vehicle.id}&ach=${ACH}`);
        await sleep(150);

        // engine codes — один vehicle может иметь несколько через ";"
        const codes = (vehicle.engineCode || "")
          .split(";")
          .map(c => c.trim().toUpperCase())
          .filter(Boolean);

        if (!codes.length) continue;

        // собираем фильтры для этого vehicle
        const filters = {};
        for (const item of (details.list || [])) {
          const type = classifyPart(item.name);
          if (type && !filters[type]) {
            filters[type] = item.partCode;
          }
        }

        if (!Object.keys(filters).length) continue;

        // ключ: engine_code|brand|model
        const brandName = brand.name.toLowerCase();
        const modName   = mod.name?.toLowerCase() || mod.id;

        for (const code of codes) {
          const key = `${code}|${brandName}|${modName}`;
          catalog[key] = {
            ...filters,
            brandId:   brand.id,
            modId:     mod.id,
            vehicleId: vehicle.id,
            engineCode: code,
            brand: brand.name,
            model: mod.name,
            modify: vehicle.modify,
          };
        }
      }
    }

    // сохраняем после каждой марки — чтобы не потерять при обрыве
    fs.writeFileSync(OUT, JSON.stringify(catalog, null, 2));
    console.log(`[saved] ${Object.keys(catalog).length} записей`);
  }

  console.log(`\n✅ Готово. Итого: ${Object.keys(catalog).length} записей → ${OUT}`);
}

build().catch(console.error);