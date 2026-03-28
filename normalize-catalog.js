/**
 * normalize-catalog.js
 *
 * Запускать руками или по cron раз в день:
 *   node normalize-catalog.js
 *
 * Или добавить в package.json:
 *   "scripts": { "normalize": "node normalize-catalog.js" }
 */

const path = require("path");
const { normalizeOilCatalog } = require("./oils");

const xlsxPath = process.argv[2] || path.join(__dirname, "main.xlsx");

normalizeOilCatalog(xlsxPath)
  .then(catalog => {
    console.log(`Done. ${catalog.length} items saved.`);
    process.exit(0);
  })
  .catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
  });
