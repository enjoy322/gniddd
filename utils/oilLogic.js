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

// ─────────────────────────────────────────────────────────────
// GPT DOUBLE-CHECK — проверка кандидатов через ИИ
// ─────────────────────────────────────────────────────────────

/**
 * Проверяет массив кандидатов через GPT.
 * Возвращает массив объектов с добавленным _gptScore (1-10).
 *
 * @param {Array} candidates — массив из matchOil
 * @param {Object} car — данные авто
 * @param {Array} requiredSpecs — требуемые допуски
 * @returns {Array} candidates с _gptScore
 */
async function validateWithGPT(candidates, car, requiredSpecs) {
  if (!candidates.length) return [];

  const engineInfo = [
    car.brand, car.model, car.year,
    `двигатель: ${car.engine?.code || "?"}`,
    `${car.engine?.volume || "?"}л`,
    car.engine?.type || "",
  ].filter(Boolean).join(", ");

  const specsStr = requiredSpecs.length
    ? requiredSpecs.join(", ")
    : "не определены";

  const oilsList = candidates.map((c, i) => {
    const allSpecs = [
      ...(c.specs?.api || []),
      ...(c.specs?.acea || []),
      ...(c.specs?.ilsac || []),
      ...(c.specs?.oem || []),
    ].join(", ");
    return `${i + 1}. ${c.brand} ${c.article} — ${c.description || ""} | Вязкость: ${c.viscosity || "?"} | Допуски: ${allSpecs || "не указаны"}`;
  }).join("\n");

  const prompt = `
Ты автоэксперт по моторным маслам. Оцени каждое масло из списка: подходит ли оно для данного автомобиля?

АВТОМОБИЛЬ: ${engineInfo}
ТРЕБУЕМЫЕ ДОПУСКИ ПРОИЗВОДИТЕЛЯ: ${specsStr}

МАСЛА ДЛЯ ПРОВЕРКИ:
${oilsList}

ПРАВИЛА ОЦЕНКИ:
- 10: идеальное совпадение — масло имеет ВСЕ требуемые OEM-допуски
- 8-9: масло имеет основные допуски, подходит отлично
- 7: масло подходит, допуски совместимы (например API SP покрывает SN)
- 5-6: масло условно подходит, но не оптимально (нет OEM-допусков, только общие стандарты)
- 3-4: масло не рекомендуется — допуски не совпадают
- 1-2: масло НЕ подходит категорически (другой класс, другие допуски)

ВАЖНО:
- OEM-допуски (RN0700, VW 502.00, MB 229.5 и т.д.) — самое важное
- Масло с допуском Ford WSS-M2C913 НЕ подходит для Renault (RN0700) — это разные стандарты
- Масло с ACEA A3/B4 БЕЗ OEM-допуска Renault — максимум 6 для Renault

Верни СТРОГО JSON без markdown, без пояснений:
[{"index": 1, "score": 8, "reason": "краткое пояснение"}, ...]
`.trim();

  try {
    console.log(`[gptCheck] checking ${candidates.length} candidates for ${car.brand} ${car.model}`);

    const response = await openai.responses.create({
      model: "gpt-5.4-mini",
      input: prompt,
    });

    const text = response.output_text.replace(/```json|```/g, "").trim();
    const results = JSON.parse(text);

    // Проставляем _gptScore каждому кандидату
    for (const r of results) {
      const idx = r.index - 1;
      if (idx >= 0 && idx < candidates.length) {
        candidates[idx]._gptScore = r.score;
        candidates[idx]._gptReason = r.reason || "";
        console.log(`[gptCheck] ${candidates[idx].brand} ${candidates[idx].article}: GPT=${r.score}/10 — ${r.reason || ""}`);
      }
    }

    // Тем кто не получил оценку — ставим 0
    for (const c of candidates) {
      if (c._gptScore === undefined) c._gptScore = 0;
    }

    return candidates;
  } catch (e) {
    console.error("[gptCheck] error:", e.message);
    // При ошибке GPT — возвращаем без фильтрации (fallback)
    for (const c of candidates) {
      c._gptScore = null; // null = не проверялось
    }
    return candidates;
  }
}

/**
 * Полный пайплайн: matchOil → GPT double-check → отбор топ-3
 *
 * @param {Object} oil — данные масла (parsed/gpt)
 * @param {Object} car — данные авто
 * @param {Object} prefs — предпочтения клиента
 * @param {number|null} fillVolume — заправочный объём
 * @param {boolean} gptCheckEnabled — включён ли double-check
 * @returns {Array} 3 рекомендации
 */
async function buildRecommendationsWithCheck(oil, car, prefs = {}, fillVolume = null, gptCheckEnabled = true) {
  // Шаг 1: получаем расширенный список кандидатов (6 штук)
  const allSpecs = extractAllSpecs(oil);
  const viscosity = pickViscosityFromOil(oil);

  const candidates = buildRecommendations(oil, prefs, fillVolume, 6);

  if (!candidates.length) return [];

  // Шаг 2: GPT double-check (если включён)
  if (!gptCheckEnabled) {
    // Без GPT — возвращаем топ-3
    return candidates.slice(0, 3);
  }

  const checked = await validateWithGPT(candidates, car, allSpecs);

  // Шаг 3: фильтруем по GPT score ≥ 7
  const passed = checked.filter(c => c._gptScore === null || c._gptScore >= 7);

  if (passed.length >= 3) {
    return passed.slice(0, 3);
  }

  // Шаг 4: не хватает — запрашиваем ещё кандидатов (итерация 2)
  console.log(`[gptCheck] only ${passed.length}/3 passed, fetching more...`);

  const moreCanidates = buildRecommendations(oil, prefs, fillVolume, 12);
  // Убираем уже проверенных
  const checkedArticles = new Set(checked.map(c => c.article));
  const newOnes = moreCanidates.filter(c => !checkedArticles.has(c.article));

  if (newOnes.length > 0) {
    const checked2 = await validateWithGPT(newOnes.slice(0, 6), car, allSpecs);
    const passed2 = checked2.filter(c => c._gptScore === null || c._gptScore >= 7);
    passed.push(...passed2);
  }

  if (passed.length >= 3) {
    return passed.slice(0, 3);
  }

  // Шаг 5: fallback — если всё ещё < 3, берём лучшее из имеющихся
  // Сортируем все проверенные по GPT-score (desc), потом по _score
  const allChecked = [...checked, ...(newOnes.length ? checked.slice(0) : [])];
  const unique = new Map();
  for (const c of [...passed, ...checked]) {
    if (!unique.has(c.article)) unique.set(c.article, c);
  }
  const fallbackList = Array.from(unique.values());
  fallbackList.sort((a, b) => {
    const gptA = a._gptScore ?? 5;
    const gptB = b._gptScore ?? 5;
    if (gptB !== gptA) return gptB - gptA;
    return (b._score || 0) - (a._score || 0);
  });

  const finalResult = fallbackList.slice(0, 3);

  // Помечаем те что < 7 предупреждением
  for (const item of finalResult) {
    if (item._gptScore !== null && item._gptScore < 7) {
      item.warning = item.warning || "требует перепроверки допусков (ИИ: " + item._gptScore + "/10)";
    }
  }

  return finalResult;
}


// ── Хелперы для извлечения данных из oil-объекта ──
function extractAllSpecs(oil) {
  const oilData   = oil?.oil || {};
  const bestItems = oilData?.best        || [];
  const altItems  = oilData?.alternative || [];
  const specs = [];
  for (const item of [...bestItems, ...altItems]) {
    specs.push(...(item.specs || []));
  }
  return [...new Set(specs)];
}

function pickViscosityFromOil(oil) {
  const oilData   = oil?.oil || {};
  const bestItems = oilData?.best        || [];
  const altItems  = oilData?.alternative || [];
  return pickViscosity(bestItems, altItems);
}


// ─────────────────────────────────────────────────────────────
// buildRecommendations — обёртка над matchOil (принимает limit)
// ─────────────────────────────────────────────────────────────
function buildRecommendations(oil, prefs = {}, fillVolume = null, limit = 6) {
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

    const oilVolume = fillVolume || oil?.volume || null;

    console.log(`[buildRecommendations] fillVolume=${fillVolume} oil.volume=${oil?.volume} → using=${oilVolume} limit=${limit}`);
    return matchOil({ specs, volume: oilVolume, viscosity, prefs, limit });
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

// ── fallbackFromPage — GPT читает HTML ──
async function fallbackFromPage(url, car) {
  console.log(`[fallbackFromPage] url=${url} engine=${car.engine.code}`);
  const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });

  const engineCode = car.engine?.code || "неизвестен";

  const prompt = `
Ты автоэксперт по подбору моторных масел. Тебе дан HTML-код страницы с таблицей масел.

Автомобиль: ${car.brand} ${car.model} ${car.year}
Код двигателя: ${engineCode}

Найди в таблице строку "МАСЛО в ДВИГАТЕЛЬ" для двигателя ${engineCode}.

ВАЖНО:
- volume — это ЗАПРАВОЧНЫЙ объём масла в двигатель (сколько литров масла заливать при замене). 
  Обычно это значение от 2.5 до 8 литров. Оно указано в столбце "Объём заливки".
  НЕ ПУТАЙ с рабочим объёмом двигателя (${car.engine.volume}л) — это другое!
- specs — допуски/спецификации масла (ILSAC GF-5, ACEA C2, API SN, VW 502.00 и т.д.)
- viscosity — вязкость масла (5W-30, 0W-20, 5W-40 и т.д.)

Если есть разделение "Лучший выбор" / "Альтернатива" — используй его.
Если есть разделение по температуре (Ниже/Выше -30°C) — помести все варианты в best.

Верни строго JSON без markdown, без комментариев:
{
  "found": true,
  "volume": 3.8,
  "best": [{"specs": ["ILSAC GF-5", "ACEA C2"], "viscosity": ["0W-30", "5W-30"]}],
  "alternative": []
}

Если двигатель ${engineCode} не найден на странице — верни: {"found": false}

HTML (первые 15000 символов):
${data.slice(0, 15000)}
`.trim();

  const response = await openai.responses.create({ model: "gpt-5.4-mini", input: prompt });
  try {
    const text = response.output_text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);
    console.log(`[fallbackFromPage] result: found=${parsed.found} volume=${parsed.volume}`);
    return parsed;
  } catch (e) {
    console.error("[fallbackFromPage] parse error:", e.message);
    console.error("[fallbackFromPage] raw:", response.output_text?.slice(0, 300));
    return null;
  }
}

// ── fallbackGlobal — GPT по знаниям ──
async function fallbackGlobal(car) {
  console.log(`[fallbackGlobal] ${car.brand} ${car.model} engine=${car.engine.code}`);

  const engineCode = car.engine?.code || "неизвестен";
  const engineVol  = car.engine?.volume || "?";
  const engineType = car.engine?.type || "бензин";
  const power      = car.power_hp || "?";

  const prompt = `
Ты профессиональный автоэксперт по моторным маслам. Подбери моторное масло для автомобиля:

Марка: ${car.brand}
Модель: ${car.model}
Год: ${car.year}
Двигатель: ${engineCode}, ${engineVol}л, ${engineType}, ${power} л.с.

ЗАДАЧА: определи допуски и вязкость моторного масла по данным производителя.

ВАЖНЫЕ ПРАВИЛА:
1. volume — это ЗАПРАВОЧНЫЙ объём масла при замене (сколько литров масла заливать в двигатель).
   Это НЕ рабочий объём двигателя (${engineVol}л). Заправочный объём обычно от 2.5 до 8 литров.
   Если не уверен точно — укажи наиболее вероятное значение.

2. specs — только РЕАЛЬНЫЕ допуски для этого двигателя. 
   Для китайских авто (Haval, Chery, Geely, Changan) часто: ILSAC GF-5, ACEA C2, ACEA C5, API SP.
   Для VAG: VW 502.00, VW 504.00.
   Для Hyundai/Kia: API SP, ILSAC GF-5/GF-6.
   НЕ ПРИДУМЫВАЙ допуски которых нет у этого двигателя!

3. viscosity — рекомендованная вязкость (5W-30, 0W-20 и т.д.)

4. Если есть несколько вариантов — "Лучший выбор" и "Альтернатива".

Верни СТРОГО JSON, без markdown, без пояснений:
{
  "found": true,
  "volume": 3.8,
  "best": [{"specs": ["ILSAC GF-5", "ACEA C2"], "viscosity": ["5W-30"]}],
  "alternative": [{"specs": ["ILSAC GF-5"], "viscosity": ["0W-30"]}]
}

Если не можешь определить данные — верни: {"found": false}
`.trim();

  const response = await openai.responses.create({ model: "gpt-5.4-mini", input: prompt });
  try {
    const text = response.output_text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);

    if (parsed.found && parsed.volume && car.engine?.volume) {
      const eng = parseFloat(car.engine.volume);
      if (parsed.volume === eng || Math.abs(parsed.volume - eng) < 0.2) {
        console.log(`[fallbackGlobal] WARNING: GPT returned volume=${parsed.volume} which equals engine displacement ${eng}! Likely wrong.`);
        parsed.volume = null;
      }
    }

    console.log(`[fallbackGlobal] result: found=${parsed.found} volume=${parsed.volume}`);
    return parsed;
  } catch (e) {
    console.error("[fallbackGlobal] parse error:", e.message);
    console.error("[fallbackGlobal] raw:", response.output_text?.slice(0, 300));
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