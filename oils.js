"use strict";
const fs   = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");

const CATALOG_PATH = path.join(__dirname, "oil-catalog.json");

// ─────────────────────────────────────────────────────────────
// ПРИОРИТЕТНЫЕ БРЕНДЫ (первые три — главные)
// ─────────────────────────────────────────────────────────────
const PRIORITY_BRANDS = ["AREOL", "COMMA", "ZIC"];

const BRAND_PRIORITY = [
  "AREOL","COMMA","ZIC",
  "LIQUI MOLY","CASTROL","MOBIL","SHELL","TOTACHI","SINTEC","LUKOIL",
  "ROLF","MANNOL","REPSOL","BARDAHL","TAKAYAMA","HYUNDAI XTEER",
  "TOYOTA","LEXUS","MOBIS","NISSAN","MITSUBISHI","VAG","GM",
  "IDEMITSU","REINWELL","PROFI-CAR","FURO","PEXOL","COMMA",
  "HI-GEAR","LAVR","ВМПАВТО",
];

// Региональный приоритет вязкостей (RU/СНГ)
const VISCOSITY_PRIORITY = ["5W-30","5W-40","10W-40","10W-30","0W-30","0W-40","0W-20","5W-50","15W-40"];

// ─────────────────────────────────────────────────────────────
// ОБЪЁМ КАНИСТРЫ
// ≤ 4.25л → 4л, > 4.25л → 5л (стандартные объёмы)
// ─────────────────────────────────────────────────────────────
function pickCanisterVolume(oilVolume) {
  if (!oilVolume) return null;
  const standard = [1, 2, 3, 4, 5, 6, 7, 8, 10, 20];
  // Граница 4.25: 4.25 → 4л, 4.26 → 5л
  // Общее правило: округляем вниз если дробная часть <= 0.25, иначе вверх
  for (let i = 0; i < standard.length; i++) {
    const cur  = standard[i];
    const next = standard[i + 1];
    if (oilVolume <= cur) return cur;
    if (next && oilVolume <= cur + 0.25) return cur;   // 4.25 → 4
    if (next && oilVolume < next) return next;           // 4.26..4.99 → 5
  }
  return standard[standard.length - 1];
}

// ─────────────────────────────────────────────────────────────
// НОРМАЛИЗАЦИЯ
// ─────────────────────────────────────────────────────────────
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
  return raw.split(";").map(s => s.trim()).filter(Boolean);
}

function clean(v) { return (v || "").trim(); }

// ─────────────────────────────────────────────────────────────
// MATCHOIL — основная функция подбора
//
// Параметры:
//   specs      — допуски из источника (OEM, ACEA, API)
//   volume     — объём заливки масла (л), например 4.4
//   viscosity  — рекомендованная вязкость из источника (или null)
//   prefs      — предпочтения клиента:
//     prefs.viscosity — выбранная клиентом вязкость (или null)
//     prefs.brand     — выбранный клиентом бренд (или null)
// ─────────────────────────────────────────────────────────────
function matchOil({ specs = [], volume = null, viscosity = null, prefs = {} } = {}) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));
  } catch (e) {
    console.error("[oils] catalog not found");
    return [];
  }

  const normalizedSpecs    = specs.map(s => normalizeSpec(s));
  const targetVolume       = pickCanisterVolume(volume);

  // ── Определяем рабочую вязкость ──────────────────────────────
  // Если клиент указал предпочтение — используем его
  // Иначе — региональный приоритет из допущенных вязкостей
  const clientViscosity = prefs?.viscosity ? normalizeViscosity(prefs.viscosity) : null;
  const autoViscosity   = viscosity ? normalizeViscosity(viscosity) : null;

  // autoViscosity — уже выбранная региональным приоритетом вязкость из источника
  const workingViscosity = clientViscosity || autoViscosity;

  // Флаг: клиент выбрал вязкость которой нет в допусках источника
  const viscosityNotRecommended = !!(
    clientViscosity && autoViscosity && clientViscosity !== autoViscosity
  );

  // ── Предпочтение бренда ──────────────────────────────────────
  const preferredBrand = prefs?.brand ? prefs.brand.toUpperCase() : null;

  // ── Скоринг ──────────────────────────────────────────────────
  const scored = catalog.map(item => {
    const itemViscosity = normalizeViscosity(item.viscosity);

    // Жёсткий фильтр по вязкости (если определена)
    if (workingViscosity && itemViscosity && itemViscosity !== workingViscosity) {
      return null;
    }

    let score = 0;

    // Вязкость совпала
    if (workingViscosity && itemViscosity === workingViscosity) score += 50;

    // Совпадение допусков
    const itemSpecs = (item.all_specs || []).map(s => normalizeSpec(s));

    let oemMatches  = 0;
    let aceaMatches = 0;
    let apiMatches  = 0;

    for (const s of normalizedSpecs) {
      if (!s) continue;
      const matched = itemSpecs.some(is => is.includes(s) || s.includes(is));
      if (!matched) continue;

      // Определяем тип допуска
      if (/^[A-Z]{2}\d{4}$|^\d{3}\.\d{2}$|RN|MB|BMW|VW|GM/.test(s)) {
        oemMatches++;   // OEM: RN0710, 229.5, VW50200 и т.д.
      } else if (s.startsWith("ACEA")) {
        aceaMatches++;
      } else if (s.startsWith("API")) {
        apiMatches++;
      } else {
        oemMatches++;   // неизвестный формат — считаем OEM
      }
    }

    score += oemMatches  * 100;  // OEM — высший приоритет
    score += aceaMatches * 40;
    score += apiMatches  * 30;

    // Пессимизация если ни одного допуска не совпало
    if (normalizedSpecs.length > 0 && (oemMatches + aceaMatches + apiMatches) === 0) {
      score -= 50;
    }

    // Объём канистры
    if (targetVolume && item.volume != null) {
      if (item.volume === targetVolume)      score += 40;
      else if (item.volume > targetVolume)   score += 10;
      else                                   score -= 20;
    }

    // Приоритетный бренд клиента
    const itemBrand = (item.brand || "").toUpperCase();
    if (preferredBrand && itemBrand === preferredBrand) score += 200;

    // Системные приоритетные бренды (AREOL, COMMA, ZIC)
    if (PRIORITY_BRANDS.includes(itemBrand)) score += 60;

    // Остальные бренды по списку
    const brandIdx = BRAND_PRIORITY.indexOf(itemBrand);
    if (brandIdx >= 0) score += Math.max(0, 30 - brandIdx);

    // Мягкий штраф за цену
    score -= item.price / 10000;

    return { ...item, _score: score, _oem: oemMatches, _acea: aceaMatches, _api: apiMatches };
  }).filter(Boolean);

  scored.sort((a, b) => b._score - a._score);

  // ── Выбираем топ-3 с разными брендами ────────────────────────
  // Если есть предпочтение бренда — он идёт первым
  const result     = [];
  const usedBrands = new Set();

  // Сначала preferred brand
  if (preferredBrand) {
    const preferred = scored.find(i => i.brand.toUpperCase() === preferredBrand);
    if (preferred) {
      result.push(preferred);
      usedBrands.add(preferred.brand.toUpperCase());
    }
  }

  // Затем разные бренды по score
  for (const item of scored) {
    if (result.length >= 3) break;
    const b = item.brand.toUpperCase();
    if (!usedBrands.has(b)) {
      result.push(item);
      usedBrands.add(b);
    }
  }

  // Добираем если не набрали 3
  if (result.length < 3) {
    for (const item of scored) {
      if (result.length >= 3) break;
      if (!result.includes(item)) result.push(item);
    }
  }

  // ── Определяем предупреждения для каждой позиции ─────────────
  return result.map(item => {
    const hasSpecMatch = (item._oem + item._acea + item._api) > 0;
    let warning = null;

    if (viscosityNotRecommended) {
      warning = "не рекомендовано производителем";
    } else if (!hasSpecMatch && normalizedSpecs.length > 0) {
      warning = "требует перепроверки";
    }

    return formatResult(item, warning);
  });
}

function formatResult(item, warning = null) {
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
    warning,
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
// НОРМАЛИЗАЦИЯ XLSX (без изменений)
// ─────────────────────────────────────────────────────────────
async function normalizeOilCatalog(xlsxPath = path.join(__dirname, "main.xlsx")) {
  console.log("[oils] reading", xlsxPath);
  const buf  = fs.readFileSync(xlsxPath);
  const zip  = await JSZip.loadAsync(buf);
  const ssXml  = await zip.file("xl/sharedStrings.xml").async("string");
  const strings = parseSharedStrings(ssXml);
  const shXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
  const rows  = parseSheet(shXml, strings);
  const catalog = rows.map(normalizeRow).filter(r => r !== null);
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), "utf-8");
  console.log(`[oils] normalized ${catalog.length} items → ${CATALOG_PATH}`);
  return catalog;
}

function normalizeRow(cells) {
  const brand   = clean(cells["A"]);
  const article = clean(cells["B"]);
  const stock   = parseInt(cells["F"]) || 0;
  if (!article || stock <= 0) return null;

  const volume    = parseFloat(clean(cells["K"])) || null;
  const viscosity = normalizeViscosity(clean(cells["\\"]));
  const api       = splitSpecs(cells["V"]);
  const ilsac     = splitSpecs(cells["W"]);
  const acea      = splitSpecs(cells["X"]);
  const oem       = splitSpecs([cells["Y"], cells["Z"], cells["["], cells["^"]].join(";"));
  const allSpecs  = [...api, ...ilsac, ...acea, ...oem];

  return {
    brand, article,
    sku:         clean(cells["D"]),
    description: clean(cells["C"]),
    price:       parseFloat(cells["G"]) || 0,
    stock, volume, viscosity,
    oil_type:    clean(cells["U"]),
    api, ilsac, acea, oem, all_specs: allSpecs,
  };
}

function parseSharedStrings(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const sis = doc.getElementsByTagName("si");
  const result = [];
  for (let i = 0; i < sis.length; i++) {
    const t = sis[i].getElementsByTagName("t")[0];
    result.push(t ? (t.textContent || "") : "");
  }
  return result;
}

function parseSheet(xml, strings) {
  const doc    = new DOMParser().parseFromString(xml, "application/xml");
  const rowEls = doc.getElementsByTagName("row");
  const rows   = [];
  for (let i = 0; i < rowEls.length; i++) {
    const cells = {};
    const cs    = rowEls[i].getElementsByTagName("c");
    for (let j = 0; j < cs.length; j++) {
      const c   = cs[j];
      const col = c.getAttribute("r").replace(/[0-9]/g, "");
      const t   = c.getAttribute("t");
      const vEl = c.getElementsByTagName("v")[0];
      let val   = "";
      if (vEl) {
        val = t === "s" ? (strings[parseInt(vEl.textContent.trim())] ?? "") : (vEl.textContent || "");
      }
      cells[col] = val;
    }
    rows.push(cells);
  }
  return rows;
}

module.exports = { normalizeOilCatalog, matchOil };