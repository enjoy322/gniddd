// ─────────────────────────────────────────────
// ДОБАВИТЬ В НАЧАЛО server.js:
// ─────────────────────────────────────────────
const { matchOil } = require("./oils");


// ─────────────────────────────────────────────
// ИЗМЕНИТЬ В /oil/:vin — добавить matchOil
// после того как получили oil (parsed / gpt):
// ─────────────────────────────────────────────

// Пример — вставить ПЕРЕД финальным res.json({ car, url, source, oil })

/*
  // Собираем все допуски и вязкость из ответа
  const allSpecs = [];
  const oilData  = oil?.oil || oil; // зависит от источника

  const bestItems = oilData?.best || [];
  for (const item of bestItems) {
    allSpecs.push(...(item.specs     || []));
    allSpecs.push(...(item.viscosity || []));
  }

  // Вязкость — берём первую из best
  const viscosity = bestItems[0]?.viscosity?.[0] || null;

  // Объём двигателя из данных авто
  const engineVolume = car.engine?.volume || null;

  // Подбираем из каталога
  const recommendations = matchOil({
    specs:     allSpecs,
    volume:    engineVolume,
    viscosity: viscosity,
  });

  return res.json({
    car,
    url,
    source,
    oil,
    recommendations,   // 👈 3 артикула из вашего склада
  });
*/


// ─────────────────────────────────────────────
// ПРИМЕР ОТВЕТА /oil/:vin с recommendations:
// ─────────────────────────────────────────────
/*
{
  "car": { ... },
  "oil": { ... },
  "recommendations": [
    {
      "article":     "5W30LM007",
      "sku":         "5W30LM007_LQM",
      "brand":       "LIQUI MOLY",
      "description": "Leichtlauf High Tech 5W-30 (4L)",
      "price":       2890,
      "stock":       8,
      "volume":      4,
      "viscosity":   "5W-30",
      "oil_type":    "синтетическое",
      "specs": {
        "api":   ["SN", "CF"],
        "ilsac": ["GF-5"],
        "acea":  ["A3/B4"],
        "oem":   ["MB 229.3", "VW 502.00"]
      },
      "_score": 187
    },
    { ... },
    { ... }
  ]
}
*/
