const axios = require("axios");
const cheerio = require("cheerio");


// --------------------
// 🔧 ENGINE CODES
// --------------------
function extractCodes(left) {
  const part = left.split("Модель:")[1];
  if (!part) return [];

  const clean = part.split("Тип топлива")[0];

  const matches = [...clean.matchAll(/\b[A-Z0-9]{3,6}\b/g)]
    .map(m => m[0]);

  return [...new Set(matches)]
    .filter(c => !/^\d+$/.test(c)); // убираем числа (типа 107)
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
  const vag = [...text.matchAll(/[A-Z]{2,}\s?\d{2,3}\.\d{2}/g)].map(m => m[0]);

  const acea = [...text.matchAll(/ACEA\s?[A-Z]\d/g)].map(m => m[0]);

  const api = [...text.matchAll(/API\s?[A-Z]{2}/g)].map(m => m[0]);

  const ilsac = [...text.matchAll(/ILSAC\s?GF-\d/g)].map(m => m[0]);

  const renault = [...text.matchAll(/RN\s?\d{4}/g)].map(m => m[0]);

  const bmw = [...text.matchAll(/LL-\d{2}/g)].map(m => m[0]);

  const mb = [...text.matchAll(/\b\d{3}\.\d\b/g)].map(m => m[0]); // 229.5

  return [...new Set([...vag, ...acea, ...api, ...ilsac, ...renault, ...bmw, ...mb])];
}


// --------------------
// 🔧 PARSE OIL BLOCK
// --------------------
function parseOilInfo(right) {
  const result = {
    best: [],
    alternative: [],
    raw: right
  };

 function parseBlock(text) {
  const pairs = [];

  // --------------------
  // 1. кейс "для SAE"
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
  // 2. fallback (ВСЁ В ОДНОЙ СТРОКЕ — Renault и др.)
  // --------------------
  const specs = extractSpecs(text);
  const viscosity = extractViscosity(text);

  if (specs.length || viscosity.length) {
    pairs.push({
      specs,
      viscosity
    });

    return pairs;
  }

  return pairs;
}

  // лучший выбор
  const bestMatch = right.match(/Лучший выбор:(.*?)(Альтернатива:|$)/s);
  if (bestMatch) {
    result.best = parseBlock(bestMatch[1]);
  }

  // альтернатива
  const altMatch = right.match(/Альтернатива:(.*)/s);
  if (altMatch) {
    result.alternative = parseBlock(altMatch[1]);
  }

  // fallback если нет структуры (как у Kia)
  if (result.best.length === 0 && result.alternative.length === 0) {
    result.best = parseBlock(right);
  }

  return result;
}


// --------------------
// 🚀 MAIN PARSER
// --------------------
async function parseEngineBlocks(url) {
  const { data } = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  const $ = cheerio.load(data);

  const blocks = [];

  let rows = $("tr.flexbe-table__row");

  // fallback на обычные таблицы
  if (rows.length === 0) {
    rows = $("table tr");
  }

  rows.each((i, el) => {
    const th = $(el).find("th").first();
    const tds = $(el).find("td");

    let left, middle, right;

    // flex-таблица
    if (th.length) {
      if (tds.length < 2) return;

      left = th.text().trim();
      middle = $(tds[0]).text().trim();
      right = $(tds[1]).text().trim();
    }

    // обычная таблица
    else {
      if (tds.length < 3) return;

      left = $(tds[0]).text().trim();
      middle = $(tds[1]).text().trim();
      right = $(tds[2]).text().trim();
    }

    if (!left.includes("МАСЛО") || !left.includes("ДВИГАТЕЛЬ")) return;

    const codes = extractCodes(left);
    if (!codes.length) return;

    const volumeMatch = left.match(/(\d\.\d)\s*л/);
    const oil = parseOilInfo(right);

    blocks.push({
      codes,
      volume: volumeMatch ? volumeMatch[1] : null,
      oil: {
        best: oil.best,
        alternative: oil.alternative
      }
    });
  });

  // удаляем дубли
  const unique = new Map();

  for (let b of blocks) {
    const key = b.codes.join("-");
    unique.set(key, b);
  }

  return Array.from(unique.values());
}


// --------------------
// 🔍 FIND ENGINE
// --------------------
function findEngineBlock(blocks, car) {
  const code = car.engine.code?.toUpperCase();
  if (!code) return null;

  return blocks.find(b => b.codes.includes(code)) || null;
}


module.exports = {
  parseEngineBlocks,
  findEngineBlock
};