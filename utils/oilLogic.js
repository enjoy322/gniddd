"use strict";
const axios  = require("axios");
const OpenAI = require("openai");
const { matchOil } = require("../oils");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VISCOSITY_PRIORITY = ["5W-30","5W-40","10W-40","10W-30","0W-30","0W-40","0W-20","5W-50","15W-40"];

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
  return all[0] || null;
}

// fillVolume = заправочный объём масла в литрах (3.8л для Haval Jolion)
// Это НЕ рабочий объём двигателя (1.5л) — берётся из парсера или GPT
function buildRecommendations(oil, prefs = {}, fillVolume = null) {
  try {
    const oilData   = oil?.oil || {};
    const bestItems = oilData?.best        || [];
    const altItems  = oilData?.alternative || [];

    const viscosity   = pickViscosity(bestItems, altItems);
    const workingVisc = viscosity ? viscosity.replace(/\s/g, "").toUpperCase() : null;

    const matchedBlock = workingVisc
      ? bestItems.find(item =>
          (item.viscosity || []).some(v => v.replace(/\s/g, "").toUpperCase() === workingVisc)
        )
      : bestItems[0];

    const targetBlock = matchedBlock || bestItems[0];
    const specs = [];
    if (targetBlock) {
      specs.push(...(targetBlock.specs     || []));
      specs.push(...(targetBlock.viscosity || []));
    }

    // fillVolume — заправочный объём (3.8л) → используем для подбора канистры нужного размера
    // Если нет — берём из oil.volume (тот же заправочный, записанный в объект)
    const oilVolume = fillVolume || oil?.volume || null;

    console.log(`[buildRecommendations] fillVolume=${fillVolume} oil.volume=${oil?.volume} → using=${oilVolume}`);
    return matchOil({ specs, volume: oilVolume, viscosity, prefs });
  } catch (e) {
    console.error("[oil] matchOil error:", e.message);
    return [];
  }
}

// ── resolveUrl ──
async function resolveUrl(car, tree) {
  const brand = car.brand?.toLowerCase();
  const model = car.model?.toLowerCase();
  if (!brand || !model || !tree[brand] || !tree[brand][model]) return null;
  const generations = tree[brand][model].generations || [];
  if (!generations.length) return null;
  if (generations.length === 1) return `https://podbormasla.ru/${brand}/${model}/${generations[0]}/`;

  const prompt = `
У меня есть машина:
brand: ${car.brand}, model: ${car.model}, generation: ${car.generation}, year: ${car.year}

Вот список поколений (с индексами):
${generations.map((g, i) => `${i}: ${g}`).join("\n")}

Верни ТОЛЬКО индекс (число). Без текста.
`.trim();

  const response = await openai.responses.create({ model: "gpt-5.4-mini", input: prompt });
  let index = parseInt(response.output_text.trim());
  if (isNaN(index) || index < 0 || index >= generations.length) index = 0;
  return `https://podbormasla.ru/${brand}/${model}/${generations[index]}/`;
}

// ── fallbackFromPage ──
async function fallbackFromPage(url, car) {
  console.log(`[fallbackFromPage] url=${url} engine=${car.engine.code}`);
  const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });

  const prompt = `
Ты автоэксперт по маслам. Вот HTML страницы (первые 15000 символов):
${data.slice(0, 15000)}

Найди данные для двигателя: ${car.engine.code}

volume — это заправочный объём масла в двигатель в литрах (НЕ рабочий объём двигателя).

Верни строго JSON без markdown:
{
  "found": true,
  "volume": 3.8,
  "best": [{ "specs": ["ACEA A3", "RN 0710"], "viscosity": ["5W-30"] }],
  "alternative": [{ "specs": [], "viscosity": ["5W-40"] }]
}

Если двигатель не найден — верни: { "found": false }
`.trim();

  const response = await openai.responses.create({ model: "gpt-5.4-mini", input: prompt });
  try {
    return JSON.parse(response.output_text.replace(/```json|```/g, "").trim());
  } catch (e) {
    console.error("[fallbackFromPage] parse error:", e.message);
    return null;
  }
}

// ── fallbackGlobal ──
async function fallbackGlobal(car) {
  console.log(`[fallbackGlobal] ${car.brand} ${car.model} engine=${car.engine.code}`);

  const prompt = `
Ты автоэксперт по моторным маслам.
Автомобиль: ${car.brand} ${car.model} ${car.year}, двигатель ${car.engine.code} ${car.engine.volume}л ${car.engine.type}, ${car.power_hp} л.с.

Подбери моторное масло. 
volume — это заправочный объём масла в двигатель в литрах (НЕ рабочий объём двигателя ${car.engine.volume}л).

Верни строго JSON без markdown:
{
  "found": true,
  "volume": 3.8,
  "best": [{ "specs": ["ACEA A3/B4", "VW 502.00"], "viscosity": ["5W-30"] }],
  "alternative": [{ "specs": ["ACEA A3/B4"], "viscosity": ["5W-40"] }]
}

Если не можешь — верни: { "found": false }
`.trim();

  const response = await openai.responses.create({ model: "gpt-5.4-mini", input: prompt });
  try {
    return JSON.parse(response.output_text.replace(/```json|```/g, "").trim());
  } catch (e) {
    console.error("[fallbackGlobal] parse error:", e.message);
    return null;
  }
}

module.exports = {
  buildRecommendations,
  resolveUrl,
  fallbackFromPage,
  fallbackGlobal,
};