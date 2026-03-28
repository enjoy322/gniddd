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
// Это НЕ рабочий объём двигателя (1.5л)
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

    // fillVolume — заправочный объём (3.8л) → используем для подбора канистры
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

    // Валидация: volume не должен быть равен рабочему объёму двигателя
    if (parsed.found && parsed.volume && car.engine?.volume) {
      const eng = parseFloat(car.engine.volume);
      if (parsed.volume === eng || Math.abs(parsed.volume - eng) < 0.2) {
        console.log(`[fallbackGlobal] WARNING: GPT returned volume=${parsed.volume} which equals engine displacement ${eng}! Likely wrong.`);
        // Не доверяем этому volume — ставим null, пусть берётся из парсера
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
  resolveUrl,
  fallbackFromPage,
  fallbackGlobal,
};