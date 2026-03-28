/**
 * oils.js
 *
 * Модуль каталога масел.
 *
 * Две задачи:
 *  1. normalizeOilCatalog()  — читает main.xlsx, возвращает чистый массив,
 *                              сохраняет в oil-catalog.json.
 *                              Запускать раз в день (cron / скрипт).
 *
 *  2. matchOil(specs, volume) — по допускам и объёму подбирает 3 артикула
 *                              из кешированного каталога.
 */

const fs   = require("fs");
const path = require("path");
const JSZip = require("jszip");          // npm i jszip
const { DOMParser } = require("@xmldom/xmldom"); // npm i @xmldom/xmldom

const CATALOG_PATH = path.join(__dirname, "oil-catalog.json");

// ─────────────────────────────────────────────────────────────
// ПРИОРИТЕТ БРЕНДОВ
// Меняй порядок под себя. Бренд с индексом 0 — самый приоритетный.
// ─────────────────────────────────────────────────────────────
const BRAND_PRIORITY = [
  "LIQUI MOLY",
  "CASTROL",
  "MOBIL",
  "SHELL",
  "ZIC",
  "TOTACHI",
  "SINTEC",
  "LUKOIL",
  "ROLF",
  "AREOL",
  "MANNOL",
  "REPSOL",
  "BARDAHL",
  "TAKAYAMA",
  "HYUNDAI XTEER",
  "TOYOTA",
  "LEXUS",
  "MOBIS",
  "NISSAN",
  "MITSUBISHI",
  "VAG",
  "GM",
  "IDEMITSU",
  "REINWELL",
  "PROFI-CAR",
  "FURO",
  "PEXOL",
  "COMMA",
  "HI-GEAR",
  "LAVR",
  "ВМПАВТО",
];

// ─────────────────────────────────────────────────────────────
// НОРМАЛИЗАЦИЯ
// ─────────────────────────────────────────────────────────────

/**
 * Читает main.xlsx и возвращает массив нормализованных позиций.
 * Сохраняет результат в oil-catalog.json для быстрого доступа.
 *
 * Структура строки каталога:
 *   A  = brand
 *   B  = article (артикул поставщика)
 *   C  = description (полное описание)
 *   D  = sku (внутренний артикул)
 *   F  = stock (остаток, штук)
 *   G  = price (цена, руб)
 *   K  = volume (объём в литрах)
 *   U  = oil_type (синтетическое / полусинтетическое / минеральное)
 *   V  = api (API спецификация, через ;)
 *   W  = ilsac (ILSAC спецификация, через ;)
 *   X  = acea (ACEA спецификация, через ;)
 *   \\ = viscosity (вязкость: 5W-30 и т.д.)
 *   остальные колонки — OEM-допуски (через ;)
 */
async function normalizeOilCatalog(xlsxPath = path.join(__dirname, "main.xlsx")) {
  console.log("[oils] reading", xlsxPath);

  const buf  = fs.readFileSync(xlsxPath);
  const zip  = await JSZip.loadAsync(buf);

  // Shared strings
  const ssXml  = await zip.file("xl/sharedStrings.xml").async("string");
  const strings = parseSharedStrings(ssXml);

  // Sheet data
  const shXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
  const rows  = parseSheet(shXml, strings);

  // Нормализуем каждую строку
  const catalog = rows
    .map(normalizeRow)
    .filter(r => r !== null);

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), "utf-8");
  console.log(`[oils] normalized ${catalog.length} items → ${CATALOG_PATH}`);

  return catalog;
}

function normalizeRow(cells) {
  const brand   = clean(cells["A"]);
  const article = clean(cells["B"]);
  const sku     = clean(cells["D"]);
  const price   = parseFloat(cells["G"]) || 0;
  const stock   = parseInt(cells["F"])   || 0;

  // Пропускаем строки без артикула или нулевым остатком
  if (!article || stock <= 0) return null;

  const volumeRaw = clean(cells["K"]);
  const volume    = parseFloat(volumeRaw) || null;

  const viscosity = normalizeViscosity(clean(cells["\\"]));

  // API: колонка V, через ;
  const api   = splitSpecs(cells["V"]);
  // ILSAC: колонка W
  const ilsac = splitSpecs(cells["W"]);
  // ACEA: колонка X
  const acea  = splitSpecs(cells["X"]);

  // OEM допуски — всё остальное что не пустое в длинных колонках
  // (в вашем файле они разбросаны по Y, Z, [...) — собираем всё в одну строку
  const oem = splitSpecs([
    cells["Y"], cells["Z"], cells["["], cells["^"]
  ].join(";"));

  // Все допуски вместе — для матчинга
  const allSpecs = [...api, ...ilsac, ...acea, ...oem];

  const description = clean(cells["C"]);
  const oilType     = clean(cells["U"]);

  return {
    brand,
    article,
    sku,
    description,
    price,
    stock,
    volume,         // литры (1, 4, 5, ...)
    viscosity,      // "5W-30"
    oil_type: oilType,
    api,
    ilsac,
    acea,
    oem,
    all_specs: allSpecs,
  };
}

// ─────────────────────────────────────────────────────────────
// МАТЧИНГ
// ─────────────────────────────────────────────────────────────

/**
 * Подбирает до 3 позиций масла из каталога.
 *
 * @param {string[]} specs     — допуски из /oil/:vin, например ["ACEA A3/B4", "VW 502.00", "5W-40"]
 * @param {number|null} volume — нужный объём двигателя (литры), например 3.6
 * @param {string|null} viscosity — вязкость, например "5W-30"
 * @returns {object[]}         — до 3 позиций из каталога
 */
function matchOil({ specs = [], volume = null, viscosity = null } = {}) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));
  } catch (e) {
    console.error("[oils] catalog not found, run normalizeOilCatalog() first");
    return [];
  }

  // Нормализуем входные допуски для сравнения
  const normalizedSpecs     = specs.map(s => normalizeSpec(s));
  const normalizedViscosity = viscosity ? normalizeViscosity(viscosity) : null;

  // Определяем нужный объём канистры: ближайший сверху к объёму двигателя
  const targetVolume = volume ? pickCanisterVolume(volume) : null;

  // ── Скоринг ──
  const scored = catalog.map(item => {
    let score = 0;

    // 1. Вязкость — жёсткий фильтр (если указана)
    if (normalizedViscosity && item.viscosity) {
      if (item.viscosity !== normalizedViscosity) {
        return null; // не подходит совсем
      }
      score += 100;
    }

    // 2. Совпадение допусков
    const itemSpecs = item.all_specs.map(s => normalizeSpec(s));
    let specMatches = 0;
    for (const s of normalizedSpecs) {
      if (itemSpecs.some(is => is.includes(s) || s.includes(is))) {
        specMatches++;
      }
    }
    score += specMatches * 20;

    // Если не совпал ни один допуск и список непустой — пессимизируем
    if (normalizedSpecs.length > 0 && specMatches === 0) {
      score -= 30;
    }

    // 3. Объём канистры
    if (targetVolume && item.volume) {
      if (item.volume === targetVolume) {
        score += 30;
      } else if (item.volume > targetVolume) {
        score += 10; // больше — ещё допустимо
      } else {
        score -= 10; // меньше нужного — хуже
      }
    }

    // 4. Приоритет бренда
    const brandIdx = BRAND_PRIORITY.indexOf(item.brand.toUpperCase());
    if (brandIdx >= 0) {
      score += Math.max(0, 50 - brandIdx * 2);
    }

    // 5. Штраф за дорогое при равных очках (мягкий)
    score -= item.price / 10000;

    return { ...item, _score: score };
  }).filter(Boolean);

  // Сортируем по убыванию score
  scored.sort((a, b) => b._score - a._score);

  // Берём топ-3, но из разных брендов (чтобы не было 3 Liqui Moly)
  const result = [];
  const usedBrands = new Set();

  for (const item of scored) {
    if (result.length >= 3) break;
    if (!usedBrands.has(item.brand)) {
      result.push(item);
      usedBrands.add(item.brand);
    }
  }

  // Если с разными брендами не набрали 3 — добираем любыми
  if (result.length < 3) {
    for (const item of scored) {
      if (result.length >= 3) break;
      if (!result.includes(item)) result.push(item);
    }
  }

  return result.map(formatResult);
}

function formatResult(item) {
  return {
    article:     item.article,
    sku:         item.sku,
    brand:       item.brand,
    description: item.description,
    price:       item.price,
    stock:       item.stock,
    volume:      item.volume,
    viscosity:   item.viscosity,
    oil_type:    item.oil_type,
    specs: {
      api:   item.api,
      ilsac: item.ilsac,
      acea:  item.acea,
      oem:   item.oem,
    },
    _score: Math.round(item._score),
  };
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/** Выбираем объём канистры: ближайший >= объёму двигателя */
function pickCanisterVolume(engineVolume) {
  const standard = [1, 2, 3, 4, 5, 6, 7, 8, 10, 20];
  return standard.find(v => v >= engineVolume) || 5;
}

function normalizeViscosity(v) {
  if (!v) return null;
  return v.trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeSpec(s) {
  if (!s) return "";
  return s.trim().toUpperCase().replace(/\s+/g, "");
}

function splitSpecs(raw) {
  if (!raw) return [];
  return raw.split(";")
    .map(s => s.trim())
    .filter(Boolean);
}

function clean(v) {
  return (v || "").trim();
}

// ─────────────────────────────────────────────────────────────
// XML PARSERS (без openpyxl — чистый JS)
// ─────────────────────────────────────────────────────────────

function parseSharedStrings(xml) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xml, "application/xml");
  const sis    = doc.getElementsByTagName("si");
  const result = [];
  for (let i = 0; i < sis.length; i++) {
    const t = sis[i].getElementsByTagName("t")[0];
    result.push(t ? (t.textContent || "") : "");
  }
  return result;
}

function parseSheet(xml, strings) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xml, "application/xml");
  const rowEls = doc.getElementsByTagName("row");
  const rows   = [];

  for (let i = 0; i < rowEls.length; i++) {
    const cells = {};
    const cs    = rowEls[i].getElementsByTagName("c");

    for (let j = 0; j < cs.length; j++) {
      const c   = cs[j];
      const ref = c.getAttribute("r");                     // "A1", "[1", etc.
      const col = ref.replace(/[0-9]/g, "");               // "A", "[", etc.
      const t   = c.getAttribute("t");
      const vEl = c.getElementsByTagName("v")[0];
      let val   = "";

      if (vEl) {
        if (t === "s") {
          const idx = parseInt(vEl.textContent.trim());
          val = strings[idx] ?? "";
        } else {
          val = vEl.textContent || "";
        }
      }
      cells[col] = val;
    }

    rows.push(cells);
  }

  // Пропускаем строку-заголовок (row[0] содержит бренд первого товара, а не названия колонок)
  // В этом файле нет отдельной строки заголовков — row[0] это уже данные
  return rows;
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = { normalizeOilCatalog, matchOil };
