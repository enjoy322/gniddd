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

  return [...new Set(matches)];
}


// --------------------
// 🔧 VISCOSITY
// --------------------
function extractViscosity(text) {
  return [...text.matchAll(/\d{1,2}W-\d{2}/g)]
    .map(m => m[0]);
}


// --------------------
// 🔧 SPECS
// --------------------
function extractSpecs(text) {
  const vag = [...text.matchAll(/[A-Z]{2,}\s?\d{2,3}\.\d{2}/g)].map(m => m[0]);
  const acea = [...text.matchAll(/ACEA\s?[A-Z]\d/g)].map(m => m[0]);
  const api = [...text.matchAll(/API\s?[A-Z]{2}/g)].map(m => m[0]);
  const ilsac = [...text.matchAll(/ILSAC\s?GF-\d/g)].map(m => m[0]);

  return [...new Set([...vag, ...acea, ...api, ...ilsac])];
}


// --------------------
// 🔧 PARSE OIL BLOCK
// --------------------
function parseOilInfo(right) {
  const result = {
    best: { viscosity: [], specs: [] },
    alternative: { viscosity: [], specs: [] },
    raw: right
  };

  const bestMatch = right.match(/Лучший выбор:(.*?)(Альтернатива:|$)/s);
  if (bestMatch) {
    const text = bestMatch[1];
    result.best.viscosity = [...new Set(extractViscosity(text))];
    result.best.specs = [...new Set(extractSpecs(text))];
  }

  const altMatch = right.match(/Альтернатива:(.*)/s);
  if (altMatch) {
    const text = altMatch[1];
    result.alternative.viscosity = [...new Set(extractViscosity(text))];
    result.alternative.specs = [...new Set(extractSpecs(text))];
  }

  // fallback
  if (!result.best.specs.length) {
    result.best.specs = extractSpecs(right);
    result.best.viscosity = extractViscosity(right);
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

  console.log("FETCH:", url);
  console.log("TABLES:", $("table").length);
  console.log("FLEX ROWS:", $("tr.flexbe-table__row").length);

  const blocks = [];

  let rows = $("tr.flexbe-table__row");

  // fallback
  if (rows.length === 0) {
    rows = $("table tr");
  }

  rows.each((i, el) => {
    const th = $(el).find("th").first();
    const tds = $(el).find("td");

    let left, middle, right;

    // flex таблица
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
      },
      raw: { left, middle, right }
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