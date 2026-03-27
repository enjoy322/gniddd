const axios = require("axios");
const cheerio = require("cheerio");

async function parseEngineBlocks(url) {
  const axios = require("axios");
  const cheerio = require("cheerio");

  const { data } = await axios.get(url);
  const $ = cheerio.load(data);

  const blocks = [];

  $("table tr").each((i, el) => {
    const tds = $(el).find("td");

    // нужно минимум 3 колонки
    if (tds.length < 3) return;

    const left = $(tds[0]).text().trim();   // двигатель
    const middle = $(tds[1]).text().trim(); // объем
    const right = $(tds[2]).text().trim();  // масло

    // ✅ только двигатель
    if (!left.includes("МАСЛО в ДВИГАТЕЛЬ")) return;

    // ✅ коды двигателей
    let codes = [...left.matchAll(/\b[A-Z]{4}\b/g)]
      .map(m => m[0])
      .filter(c => !["SAE", "VAG"].includes(c));

    if (codes.length === 0) return;

    // ✅ объем
    const volumeMatch = left.match(/(\d\.\d)\s*л/);

    // ✅ вязкость (ИЩЕМ В ПРАВОЙ КОЛОНКЕ!)
    const viscosity = [...right.matchAll(/\d{1,2}W-\d{2}/g)]
      .map(m => m[0]);

    // ✅ допуски
    const specs = [...right.matchAll(/[A-Z]{2,}\s?\d{2,3}\.\d{2}/g)]
      .map(m => m[0]);

    blocks.push({
      codes,
      volume: volumeMatch ? volumeMatch[1] : null,
      viscosity: [...new Set(viscosity)],
      specs: [...new Set(specs)],
      raw: { left, middle, right }
    });
  });

  // ✅ убираем дубли
  const unique = new Map();

  for (let b of blocks) {
    const key = b.codes.join("-");
    unique.set(key, b);
  }

  return Array.from(unique.values());
}


// 🔍 поиск нужного двигателя
function findEngineBlock(blocks, car) {
  const code = car.engine.code?.toUpperCase();

  if (!code) return null;

  return blocks.find(b => b.codes.includes(code)) || null;
}

module.exports = {
  parseEngineBlocks,
  findEngineBlock
};