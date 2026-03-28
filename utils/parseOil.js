const axios = require("axios");
const cheerio = require("cheerio");


// --------------------
// 🔧 ENGINE CODES
// --------------------
function extractCodes(text) {
  const part = text.split("Модель:")[1];
  if (!part) return [];

  // Обрезаем до "Тип топлива" или конца
  const clean = part.split("Тип топлива")[0];

  // Коды двигателей: буквенно-цифровые 3–10 символов (GW4G15K, GW4B15D, CWVA и т.д.)
  const matches = [...clean.matchAll(/\b[A-Z0-9][A-Z0-9]{2,9}\b/g)]
    .map(m => m[0]);

  return [...new Set(matches)]
    .filter(c => {
      // убираем чисто числовые (107, 143, 150 — мощность)
      if (/^\d+$/.test(c)) return false;
      // убираем слишком короткие чисто буквенные
      if (/^[A-Z]{1,2}$/.test(c)) return false;
      return true;
    });
}


// --------------------
// 🔧 VISCOSITY
// --------------------
function extractViscosity(text) {
  return [...text.matchAll(/\d{1,2}W-\d{2}/g)]
    .map(m => m[0]);
}


// --------------------
// 🔧 SPECS (ВСЕ ПОПУЛЯРНЫЕ)
// --------------------
function extractSpecs(text) {
  // VAG / OEM specs (VW 502.00, MB 229.5 и т.д.)
  const vag = [...text.matchAll(/[A-Z]{2,}\s?\d{2,3}\.\d{2}/g)].map(m => m[0]);

  // ACEA (A3, C2, A3/B4, C5 и т.д.)
  const acea = [...text.matchAll(/ACEA\s?[A-Z]\d(?:\/[A-Z]\d)*/g)].map(m => m[0]);

  // API (SN, SP, CF и т.д.)
  const api = [...text.matchAll(/API\s?[A-Z]{2}(?:\/[A-Z]{2})*/g)].map(m => m[0]);

  // ILSAC (GF-5, GF-6 и т.д.)
  const ilsac = [...text.matchAll(/ILSAC\s?GF-\d/g)].map(m => m[0]);

  // Renault RN
  const renault = [...text.matchAll(/RN\s?\d{4}/g)].map(m => m[0]);

  // BMW LL
  const bmw = [...text.matchAll(/LL-\d{2}/g)].map(m => m[0]);

  // Mercedes 229.5
  const mb = [...text.matchAll(/\b\d{3}\.\d{1,2}\b/g)].map(m => m[0]);

  return [...new Set([...vag, ...acea, ...api, ...ilsac, ...renault, ...bmw, ...mb])];
}


// --------------------
// 🔧 EXTRACT FILL VOLUME
// --------------------
function extractFillVolume(text) {
  // Ищем паттерны вида "3.8 ± 0.1 л" или "4.0 л" или "3,8 л"
  const match = text.match(/(\d+[.,]?\d*)\s*(?:±\s*[\d.,]+\s*)?л/i);
  if (match) {
    return parseFloat(match[1].replace(",", "."));
  }
  return null;
}


// --------------------
// 🔧 PARSE OIL BLOCK — УЛУЧШЕННЫЙ
// --------------------
function parseOilInfo(specText) {
  const result = {
    best: [],
    alternative: [],
  };

  function parseBlock(text) {
    const pairs = [];

    // --------------------
    // 1. Кейс "для SAE" — основной
    // --------------------
    const matches = [...text.matchAll(/(.+?)для\s*SAE\s*([\dW\-,\s]+)/gi)];

    if (matches.length) {
      for (let m of matches) {
        const left = m[1];
        const right = m[2];

        const specs = extractSpecs(left);
        const viscosity = extractViscosity(right);

        if (specs.length || viscosity.length) {
          pairs.push({ specs, viscosity });
        }
      }
      return pairs;
    }

    // --------------------
    // 2. Кейс "или" — ILSAC GF-5 или ACEA C2 для SAE
    // Уже покрыт выше, но если "для" без SAE
    // --------------------

    // --------------------
    // 3. fallback — всё в одной строке (Renault, Kia и др.)
    // --------------------
    const specs = extractSpecs(text);
    const viscosity = extractViscosity(text);

    if (specs.length || viscosity.length) {
      pairs.push({ specs, viscosity });
      return pairs;
    }

    return pairs;
  }

  // Лучший выбор
  const bestMatch = specText.match(/Лучший выбор:(.*?)(Альтернатива:|$)/s);
  if (bestMatch) {
    result.best = parseBlock(bestMatch[1]);
  }

  // Альтернатива
  const altMatch = specText.match(/Альтернатива:(.*)/s);
  if (altMatch) {
    result.alternative = parseBlock(altMatch[1]);
  }

  // Если нет структуры "Лучший/Альтернатива" — парсим всё как best
  if (result.best.length === 0 && result.alternative.length === 0) {
    // Разбиваем по температурным условиям если есть
    const tempBlocks = [...specText.matchAll(/(Ниже|Выше)\s*-?\d+\s*°?C\s*:\s*(.*?)(?=(?:Ниже|Выше)\s*-?\d+|Периодичность|$)/gsi)];

    if (tempBlocks.length) {
      for (const tb of tempBlocks) {
        const blockText = tb[2];
        const items = parseBlock(blockText);
        result.best.push(...items);
      }
    } else {
      result.best = parseBlock(specText);
    }
  }

  return result;
}


// --------------------
// 🚀 MAIN PARSER — ПОЛНОСТЬЮ ПЕРЕПИСАН
// --------------------
async function parseEngineBlocks(url) {
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 10000,
  });

  const $ = cheerio.load(data);
  const blocks = [];

  // Ищем все строки таблицы
  let rows = $("tr.flexbe-table__row");
  if (rows.length === 0) {
    rows = $("table tr");
  }

  rows.each((i, el) => {
    const th = $(el).find("th").first();
    const tds = $(el).find("td");

    let left, middle, right;

    // flex-таблица (th + 2 td)
    if (th.length && tds.length >= 2) {
      left   = th.text().trim();
      middle = $(tds[0]).text().trim();
      right  = $(tds[1]).text().trim();
    }
    // обычная таблица (3+ td)
    else if (tds.length >= 3) {
      left   = $(tds[0]).text().trim();
      middle = $(tds[1]).text().trim();
      right  = $(tds[2]).text().trim();
    }
    // мобильная раскладка (2 td: заголовок + значение)
    else if (tds.length === 2) {
      const cell0 = $(tds[0]).text().trim();
      const cell1 = $(tds[1]).text().trim();
      // Проверяем — это строка "Объём заливки" / "Спецификация масла"?
      // Пропускаем — они часть другой раскладки
      return;
    }
    else {
      return;
    }

    if (!left) return;

    // Фильтр: только строки с "МАСЛО" И "ДВИГАТЕЛЬ"
    const leftUpper = left.toUpperCase();
    if (!leftUpper.includes("МАСЛО") || !leftUpper.includes("ДВИГАТЕЛЬ")) return;

    // Извлекаем коды двигателей
    const codes = extractCodes(left);
    if (!codes.length) return;

    // Извлекаем заправочный объём из MIDDLE (столбец "Объём заливки")
    const fillVolume = extractFillVolume(middle) || extractFillVolume(right);

    // Извлекаем спецификации масла из RIGHT (столбец "Спецификация масла")
    // Но если right пустой или содержит только рекомендации — пробуем middle
    let specText = right;
    if (!specText || specText.length < 5) {
      specText = middle;
    }

    const oil = parseOilInfo(specText);

    blocks.push({
      codes,
      volume: fillVolume,
      oil: {
        best:        oil.best,
        alternative: oil.alternative,
      }
    });
  });

  // Удаляем дубли по кодам
  const unique = new Map();
  for (let b of blocks) {
    const key = b.codes.join("-");
    unique.set(key, b);
  }

  return Array.from(unique.values());
}


// --------------------
// 🔍 FIND ENGINE — УЛУЧШЕННЫЙ
// --------------------
function findEngineBlock(blocks, car) {
  const code = car.engine?.code?.toUpperCase();
  if (!code) return null;

  // Точное совпадение
  const exact = blocks.find(b => b.codes.includes(code));
  if (exact) return exact;

  // Частичное совпадение (GW4G15 → GW4G15K)
  const partial = blocks.find(b =>
    b.codes.some(c => c.includes(code) || code.includes(c))
  );
  if (partial) return partial;

  // Если только один блок для двигателя — берём его
  if (blocks.length === 1) return blocks[0];

  return null;
}


module.exports = {
  parseEngineBlocks,
  findEngineBlock,
};