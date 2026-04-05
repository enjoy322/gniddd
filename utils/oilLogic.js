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

/* ══════════════════════════════════════════════════════════════
   GPT DOUBLE-CHECK
   ══════════════════════════════════════════════════════════════ */
async function validateWithGPT(candidates, car, requiredSpecs) {
  if (!candidates.length) return [];

  const engineInfo = [
    car.brand, car.model, car.year,
    `двигатель: ${car.engine?.code || "?"}`,
    `${car.engine?.volume || "?"}л`,
    car.engine?.type || "",
  ].filter(Boolean).join(", ");

  const specsStr = requiredSpecs.length ? requiredSpecs.join(", ") : "не определены";

  const oilsList = candidates.map((c, i) => {
    const allSpecs = [
      ...(c.specs?.api || []),
      ...(c.specs?.acea || []),
      ...(c.specs?.ilsac || []),
      ...(c.specs?.oem || []),
    ].join(", ");
    return `${i + 1}. ${c.brand} ${c.article} — ${c.description || ""} | Вязкость: ${c.viscosity || "?"} | Допуски: ${allSpecs || "не указаны"}`;
  }).join("\n");

  const prompt = `Ты автоэксперт по моторным маслам. Оцени каждое масло: подходит ли оно для автомобиля?

АВТОМОБИЛЬ: ${engineInfo}
ТРЕБУЕМЫЕ ДОПУСКИ: ${specsStr}

МАСЛА:
${oilsList}

ПРАВИЛА:
- 10: идеальное — ВСЕ OEM-допуски совпадают
- 8-9: основные допуски есть, подходит отлично
- 7: допуски совместимы (API SP покрывает SN и т.п.)
- 5-6: условно подходит, нет OEM-допусков
- 3-4: не рекомендуется
- 1-2: не подходит категорически

ВАЖНО:
- OEM-допуски (RN0700, VW 502.00, MB 229.5) — самое важное
- Ford WSS-M2C913 НЕ подходит для Renault RN0700
- ACEA A3/B4 БЕЗ OEM Renault — максимум 6 для Renault

Верни СТРОГО JSON: [{"index": 1, "score": 8, "reason": "краткое пояснение"}, ...]`;

  try {
    console.log(`[gptCheck] checking ${candidates.length} candidates for ${car.brand} ${car.model}`);
    const response = await openai.responses.create({
      model: "gpt-5.4-mini",
      input: prompt,
    });
    const text = response.output_text.replace(/```json|```/g, "").trim();
    const results = JSON.parse(text);

    for (const r of results) {
      const idx = r.index - 1;
      if (idx >= 0 && idx < candidates.length) {
        candidates[idx]._gptScore = r.score;
        candidates[idx]._gptReason = r.reason || "";
        console.log(`[gptCheck] ${candidates[idx].brand} ${candidates[idx].article}: GPT=${r.score}/10 — ${r.reason || ""}`);
      }
    }
    for (const c of candidates) {
      if (c._gptScore === undefined) c._gptScore = 0;
    }
    return candidates;
  } catch (e) {
    console.error("[gptCheck] error:", e.message);
    for (const c of candidates) c._gptScore = null;
    return candidates;
  }
}

/* ══════════════════════════════════════════════════════════════
   collectSpecs — извлекает допуски из oil-объекта (без вязкости)
   ══════════════════════════════════════════════════════════════ */
function collectSpecs(oil) {
  const oilData = oil?.oil || {};
  const all = [...(oilData.best || []), ...(oilData.alternative || [])];
  const set = new Set();
  for (const block of all) {
    for (const s of (block.specs || [])) {
      if (!/^\d+W-?\d+$/i.test(s.replace(/\s/g, ""))) set.add(s);
    }
  }
  return Array.from(set);
}

/* ══════════════════════════════════════════════════════════════
   buildRecommendations — теперь принимает primaryOil + fallbackOil (ИИ)
   primaryOil  = данные из каталога (источник, вес 1.5×)
   fallbackOil = данные ИИ (вес 1×, добавляются только если нет в primary)
   ══════════════════════════════════════════════════════════════ */
function buildRecommendations(primaryOil, fallbackOil = null, prefs = {}, fillVolume = null) {
  try {
    const primaryData = primaryOil?.oil || {};
    const bestItems   = primaryData?.best        || [];
    const altItems    = primaryData?.alternative || [];

    const viscosity = pickViscosity(bestItems, altItems);
    const specs     = collectSpecs(primaryOil);
    const aiSpecs   = fallbackOil ? collectSpecs(fallbackOil) : [];

    const oilVolume = fillVolume || primaryOil?.volume || null;

    console.log(`[buildRec] specs=[${specs.join(", ")}] aiSpecs=[${aiSpecs.join(", ")}] visc=${viscosity} vol=${oilVolume}`);
    return matchOil({ specs, aiSpecs, volume: oilVolume, viscosity, prefs });
  } catch (e) {
    console.error("[oil] matchOil error:", e.message);
    return [];
  }
}

/* ══════════════════════════════════════════════════════════════
   buildRecommendationsWithCheck — matchOil → GPT → top3
   primaryOil  — данные из каталога (parsed / gpt_html / gpt_global)
   aiOil       — данные ИИ (oilGpt из fallbackGlobal), может быть null
   ══════════════════════════════════════════════════════════════ */
async function buildRecommendationsWithCheck(primaryOil, aiOil = null, car, prefs = {}, fillVolume = null, gptCheckEnabled = true) {
  // Шаг 1: подбор 3 позиций (AREOL + COMMA + прочий)
  const candidates = buildRecommendations(primaryOil, aiOil, prefs, fillVolume);
  if (!candidates.length) return [];

  // Шаг 2: без GPT — возвращаем как есть (всегда 3: AREOL+COMMA+прочий)
  if (!gptCheckEnabled) {
    return candidates;
  }

  // Шаг 3: GPT double-check — проверяем всех 3
  const allSpecs = extractAllSpecs(primaryOil);
  const checked  = await validateWithGPT(candidates, car, allSpecs);

  // Отмечаем предупреждения для low-score, но НЕ выбрасываем позиции
  // (гарантируем AREOL+COMMA+прочий независимо от оценки GPT)
  return checked.map(item => {
    if (item._gptScore !== null && item._gptScore < 7) {
      item.warning = item.warning || `требует перепроверки (ИИ: ${item._gptScore}/10)`;
    }
    return item;
  });
}

/* ══════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════ */
function extractAllSpecs(oil) {
  const oilData = oil?.oil || {};
  const specs = [];
  for (const block of [...(oilData.best || []), ...(oilData.alternative || [])]) {
    for (const s of (block.specs || [])) {
      if (!/^\d+W-?\d+$/i.test(s.replace(/\s/g, ""))) {
        specs.push(s);
      }
    }
  }
  return [...new Set(specs)];
}

/* ══════════════════════════════════════════════════════════════
   resolveUrl
   ══════════════════════════════════════════════════════════════ */
async function resolveUrl(car, tree) {
  const brand = car.brand?.toLowerCase();
  const model = car.model?.toLowerCase();
  if (!brand || !model || !tree[brand] || !tree[brand][model]) return null;
  const generations = tree[brand][model].generations || [];
  if (!generations.length) return null;
  if (generations.length === 1) return `https://podbormasla.ru/${brand}/${model}/${generations[0]}/`;

  const prompt = `У меня есть машина:
brand: ${car.brand}, model: ${car.model}, generation: ${car.generation}, year: ${car.year}

Вот список поколений (с индексами):
${generations.map((g, i) => `${i}: ${g}`).join("\n")}

Верни ТОЛЬКО индекс (число). Без текста.`;

  const response = await openai.responses.create({ model: "gpt-5.4-mini", input: prompt });
  let index = parseInt(response.output_text.trim());
  if (isNaN(index) || index < 0 || index >= generations.length) index = 0;
  return `https://podbormasla.ru/${brand}/${model}/${generations[index]}/`;
}

/* ══════════════════════════════════════════════════════════════
   fallbackFromPage
   ══════════════════════════════════════════════════════════════ */
async function fallbackFromPage(url, car) {
  console.log(`[fallbackFromPage] url=${url} engine=${car.engine.code}`);
  const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });

  const engineCode = car.engine?.code || "неизвестен";

  const prompt = `Ты автоэксперт. Тебе дан HTML-код страницы с таблицей масел.

Автомобиль: ${car.brand} ${car.model} ${car.year}
Код двигателя: ${engineCode}

Найди строку "МАСЛО в ДВИГАТЕЛЬ" для двигателя ${engineCode}.

ВАЖНО:
- volume — ЗАПРАВОЧНЫЙ объём масла (сколько литров заливать). Обычно 2.5-8 л.
  НЕ путай с рабочим объёмом двигателя (${car.engine.volume}л)!
- specs — допуски (ILSAC GF-5, ACEA C2, API SN, VW 502.00, RN0700 и т.д.)
- viscosity — вязкость (5W-30, 0W-20 и т.д.)

Верни строго JSON:
{"found": true, "volume": 3.8, "best": [{"specs": ["RN0700"], "viscosity": ["5W-30"]}], "alternative": []}
Если двигатель не найден: {"found": false}

HTML (первые 15000 символов):
${data.slice(0, 15000)}`;

  const response = await openai.responses.create({ model: "gpt-5.4-mini", input: prompt });
  try {
    const text = response.output_text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);
    console.log(`[fallbackFromPage] found=${parsed.found} volume=${parsed.volume}`);
    return parsed;
  } catch (e) {
    console.error("[fallbackFromPage] parse error:", e.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   fallbackGlobal
   ══════════════════════════════════════════════════════════════ */
async function fallbackGlobal(car) {
  console.log(`[fallbackGlobal] ${car.brand} ${car.model} engine=${car.engine.code}`);

  const prompt = `Ты автоэксперт. Подбери моторное масло для:
Марка: ${car.brand}, Модель: ${car.model}, Год: ${car.year}
Двигатель: ${car.engine?.code || "?"}, ${car.engine?.volume || "?"}л, ${car.engine?.type || "бензин"}, ${car.power_hp || "?"} л.с.

ВАЖНО:
1. volume — ЗАПРАВОЧНЫЙ объём масла (НЕ объём двигателя ${car.engine?.volume}л). Обычно 2.5-8 л.
2. specs — РЕАЛЬНЫЕ допуски. НЕ придумывай!
3. viscosity — рекомендованная вязкость.

Верни СТРОГО JSON:
{"found": true, "volume": 3.8, "best": [{"specs": ["ACEA A3/B4", "RN0700"], "viscosity": ["5W-40"]}], "alternative": []}
Если не можешь: {"found": false}`;

  const response = await openai.responses.create({ model: "gpt-5.4-mini", input: prompt });
  try {
    const text = response.output_text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);

    if (parsed.found && parsed.volume && car.engine?.volume) {
      const eng = parseFloat(car.engine.volume);
      if (Math.abs(parsed.volume - eng) < 0.2) {
        console.log(`[fallbackGlobal] WARNING: volume=${parsed.volume} ≈ engine displacement! Likely wrong.`);
        parsed.volume = null;
      }
    }

    console.log(`[fallbackGlobal] found=${parsed.found} volume=${parsed.volume}`);
    return parsed;
  } catch (e) {
    console.error("[fallbackGlobal] parse error:", e.message);
    return null;
  }
}

module.exports = {
  buildRecommendations,
  buildRecommendationsWithCheck,
  validateWithGPT,
  resolveUrl,
  fallbackFromPage,
  fallbackGlobal,
};