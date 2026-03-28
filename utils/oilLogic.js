"use strict";
const axios  = require("axios");
const OpenAI = require("openai");
const { matchOil } = require("../oils");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Приоритет вязкостей для умеренного климата RU/СНГ ──
const VISCOSITY_PRIORITY = ["5W-30","5W-40","10W-40","10W-30","0W-30","0W-40","0W-20","5W-50"];

function pickViscosity(bestItems, altItems) {
  const all = [];
  for (const item of [...bestItems, ...altItems]) {
    for (const v of (item.viscosity || [])) {
      const n = v.replace(/\s/g, "").toUpperCase();
      if (!all.includes(n)) all.push(n);
    }
  }
  if (!all.length) return null;
  for (const pref of VISCOSITY_PRIORITY) {
    if (all.includes(pref)) return pref;
  }
  return bestItems[0]?.viscosity?.[0] || all[0] || null;
}

// ── Подбор из каталога ──
function buildRecommendations(oil) {
  try {
    const specs     = [];
    const oilData   = oil?.oil || {};
    const bestItems = oilData?.best        || [];
    const altItems  = oilData?.alternative || [];

    for (const item of bestItems) {
      specs.push(...(item.specs     || []));
      specs.push(...(item.viscosity || []));
    }

    const oilVolume = oil?.volume ?? null;           // объём заливки (л), НЕ рабочий объём мотора
    const viscosity = pickViscosity(bestItems, altItems);

    console.log(`[oil] matchOil: viscosity=${viscosity} oilVolume=${oilVolume}л`);
    return matchOil({ specs, volume: oilVolume, viscosity });
  } catch (e) {
    console.error("[oil] matchOil error:", e.message);
    return [];
  }
}

// ── Определяем URL страницы на podbormasla.ru по дереву + GPT ──
async function resolveUrl(car, tree) {
  const brand = car.brand?.toLowerCase();
  const model = car.model?.toLowerCase();

  if (!brand || !model || !tree[brand] || !tree[brand][model]) return null;

  const generations = tree[brand][model].generations || [];
  if (!generations.length) return null;
  if (generations.length === 1) {
    return `https://podbormasla.ru/${brand}/${model}/${generations[0]}/`;
  }

  const prompt = `
У меня есть машина:
brand: ${car.brand}
model: ${car.model}
generation: ${car.generation}
year: ${car.year}

Вот список поколений (с индексами):
${generations.map((g, i) => `${i}: ${g}`).join("\n")}

Верни ТОЛЬКО индекс (число), который лучше всего подходит. Без текста, только число.
`.trim();

  const response = await openai.responses.create({ model: "gpt-4o-mini", input: prompt });
  let index = parseInt(response.output_text.trim());
  if (isNaN(index) || index < 0 || index >= generations.length) index = 0;
  return `https://podbormasla.ru/${brand}/${model}/${generations[index]}/`;
}

// ── Фоллбэк 1: GPT по HTML страницы ──
async function fallbackFromPage(url, car) {
  console.log(`[fallbackFromPage] url=${url} engine=${car.engine.code}`);
  const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });

  const prompt = `
Ты автоэксперт по маслам.

Вот HTML страницы подбора масла (первые 15000 символов):
${data.slice(0, 15000)}

Найди данные для двигателя: ${car.engine.code}

Верни строго JSON без markdown:
{
  "found": true,
  "volume": 5.3,
  "best": [{ "specs": ["ACEA A3"], "viscosity": ["5W-40"] }],
  "alternative": [{ "specs": [], "viscosity": ["5W-30"] }]
}

Если двигатель не найден — верни: { "found": false }
`.trim();

  const response = await openai.responses.create({ model: "gpt-4o-mini", input: prompt });
  try {
    return JSON.parse(response.output_text.replace(/```json|```/g, "").trim());
  } catch (e) {
    console.error("[fallbackFromPage] JSON parse error:", e.message);
    return null;
  }
}

// ── Фоллбэк 2: GPT по знаниям ──
async function fallbackGlobal(car) {
  console.log(`[fallbackGlobal] ${car.brand} ${car.model} engine=${car.engine.code}`);

  const prompt = `
Ты автоэксперт по моторным маслам.

Автомобиль:
- Марка: ${car.brand}
- Модель: ${car.model}
- Год: ${car.year}
- Двигатель: ${car.engine.code}, ${car.engine.volume}л, ${car.engine.type}
- Мощность: ${car.power_hp} л.с.

Подбери моторное масло. Верни строго JSON без markdown:
{
  "found": true,
  "volume": 4.5,
  "best": [{ "specs": ["ACEA A3/B4", "VW 502.00"], "viscosity": ["5W-40"] }],
  "alternative": [{ "specs": ["ACEA A3/B4"], "viscosity": ["5W-30"] }]
}

Если не можешь подобрать — верни: { "found": false }
Только JSON, никакого текста вокруг.
`.trim();

  const response = await openai.responses.create({ model: "gpt-4o-mini", input: prompt });
  try {
    return JSON.parse(response.output_text.replace(/```json|```/g, "").trim());
  } catch (e) {
    console.error("[fallbackGlobal] JSON parse error:", e.message);
    return null;
  }
}

module.exports = { buildRecommendations, resolveUrl, fallbackFromPage, fallbackGlobal };
