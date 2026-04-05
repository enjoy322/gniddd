"use strict";
/**
 * buildAreolCommaSpecs.js
 * Читает areol-comma-source.xlsx (допуски, заполненные вручную),
 * объединяет с oil-catalog.json (цена/наличие из ARMTEK),
 * выдаёт areol-comma-specs.json — эталонный каталог AREOL и COMMA.
 *
 * Запуск: node buildAreolCommaSpecs.js
 */

const XLSX  = require("xlsx");
const fs    = require("fs");
const path  = require("path");

const SRC_XLSX    = path.join(__dirname, "areol-comma-source.xlsx");
const OIL_CATALOG = path.join(__dirname, "oil-catalog.json");
const OUT_JSON    = path.join(__dirname, "areol-comma-specs.json");

// ── Нормализация ──────────────────────────────────────────────────────────────
function splitSemi(s) {
  return String(s || "").split(";").map(x => x.trim().replace(/\s+/g, " ")).filter(Boolean);
}

function fixDotSpaces(s) {
  // "504 00" → "504.00"
  return s.replace(/(\d+)\s+(\d{2})$/g, "$1.$2");
}

function prefixOem(prefix, raw) {
  return splitSemi(raw).map(v => {
    v = fixDotSpaces(v.trim());
    return v ? `${prefix} ${v}` : null;
  }).filter(Boolean);
}

function normGm(raw) {
  // "dexos2" → "GM Dexos 2", "GM-LL-B-025" → "GM LL-B-025"
  return splitSemi(raw).map(v => {
    v = v.trim();
    if (!v) return null;
    if (/^dexos/i.test(v)) return `GM Dexos ${v.replace(/^dexos\s*/i,"").trim()}`;
    if (/^gm/i.test(v)) return v.replace(/^gm[\s-]*/i, "GM ");
    return `GM ${v}`;
  }).filter(Boolean);
}

// ── Парсинг xlsx ──────────────────────────────────────────────────────────────
function parseXlsx() {
  const wb   = XLSX.readFile(SRC_XLSX);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  // Строка 0 — заголовок-описание, строка 1 — заголовки колонок, строки 2+ — данные
  const header = rows[1]; // ["Бренд","Артикул","Название","Вязкость","Объём","Тип","API","ACEA ← ЗАПОЛНИТЬ","VW","BMW","MB","Ford","OPEL/GM","Renault","Прочие допуски","URL","Кол-во","Цена"]
  console.log("Header:", header);

  const items = [];

  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    const brand   = String(r[0] || "").trim();
    const article = String(r[1] || "").trim();
    if (!brand || !article || !["AREOL","COMMA"].includes(brand)) continue;

    const visc   = String(r[3] || "").trim();
    const vol    = parseFloat(r[4]) || null;
    const oilTyp = String(r[5] || "").trim();
    const url    = String(r[15] || "").trim();

    const api    = splitSemi(r[6]);
    const acea   = splitSemi(r[7]);
    const vw     = prefixOem("VW",   r[8]);
    const bmw    = prefixOem("BMW",  r[9]);
    const mb     = prefixOem("MB",   r[10]);
    const ford   = prefixOem("Ford", r[11]);
    const gm     = normGm(r[12]);
    const renault= splitSemi(r[13]).map(v => v.trim()).filter(Boolean);
    const other  = splitSemi(r[14]);

    // Нормализуем Renault: RN0720 → "RN0720"
    const renNorm = renault.map(v => v.replace(/RN\s*/i, "RN").replace(/\s+/g, ""));

    const all_specs = [
      ...api, ...acea,
      ...vw, ...bmw, ...mb, ...ford, ...gm, ...renNorm, ...other,
    ].filter(Boolean);

    items.push({
      brand, article, viscosity: visc,
      volume: vol, oil_type: oilTyp, url,
      api, acea,
      oem: [...vw, ...bmw, ...mb, ...ford, ...gm, ...renNorm, ...other],
      all_specs,
    });
  }
  return items;
}

// ── Объединение с oil-catalog.json (цена / наличие / описание) ───────────────
function mergeWithCatalog(items) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(OIL_CATALOG, "utf-8"));
  } catch (e) {
    console.error("oil-catalog.json not found:", e.message);
    catalog = [];
  }

  const catMap = new Map(catalog.map(c => [c.article.toUpperCase(), c]));

  return items.map(item => {
    const catEntry = catMap.get(item.article.toUpperCase());
    if (!catEntry) {
      console.warn(`  [warn] ${item.brand} ${item.article} not in oil-catalog`);
    }
    return {
      brand:       item.brand,
      article:     item.article,
      sku:         catEntry?.sku         || item.article + "_" + item.brand.slice(0,3),
      description: catEntry?.description || "",
      price:       catEntry?.price       || 0,
      stock:       catEntry?.stock       || 0,
      volume:      item.volume           ?? catEntry?.volume ?? null,
      viscosity:   item.viscosity        || catEntry?.viscosity || "",
      oil_type:    item.oil_type         || catEntry?.oil_type || "синтетическое",
      url:         item.url              || "",
      api:         item.api,
      acea:        item.acea,
      oem:         item.oem,
      all_specs:   item.all_specs,
    };
  });
}

// ── main ─────────────────────────────────────────────────────────────────────
const parsed = parseXlsx();
console.log(`Parsed ${parsed.length} items from xlsx`);

const merged = mergeWithCatalog(parsed);
console.log(`Merged with catalog: ${merged.filter(i => i.stock > 0).length} in stock`);

fs.writeFileSync(OUT_JSON, JSON.stringify(merged, null, 2), "utf-8");
console.log(`Written: ${OUT_JSON}`);
