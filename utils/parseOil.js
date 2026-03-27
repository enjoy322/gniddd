const axios = require("axios");
const cheerio = require("cheerio");

async function parseEngineBlocks(url) {
  const { data } = await axios.get(url);
  const $ = cheerio.load(data);

  const blocks = [];

  $("table tr").each((i, el) => {
    const rowText = $(el).text();

    // ✅ только двигатель
    if (!rowText.includes("МАСЛО в ДВИГАТЕЛЬ")) return;

    const tds = $(el).find("td");

if (tds.length < 3) return;

const left = $(tds[0]).text();   // двигатель
const middle = $(tds[1]).text(); // объем
const right = $(tds[2]).text();  // масло

    // ✅ коды двигателей (4 буквы)
    let codes = [...blockText.matchAll(/\b[A-Z]{4}\b/g)]
      .map(m => m[0])
      .filter(c => !["SAE", "VAG"].includes(c));

    if (codes.length === 0) return;

    // ✅ объем
    const volumeMatch = blockText.match(/(\d\.\d)\s*л/);

    // ✅ вязкость
    const viscosity = [...blockText.matchAll(/\d{1,2}W-\d{2}/g)]
      .map(m => m[0]);

    // ✅ допуски
    const specs = [...blockText.matchAll(/[A-Z]{2,}\s?\d{2,3}\.\d{2}/g)]
      .map(m => m[0]);

    blocks.push({
      codes,
      volume: volumeMatch ? volumeMatch[1] : null,
      viscosity: [...new Set(viscosity)],
      specs: [...new Set(specs)],
      raw: blockText
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