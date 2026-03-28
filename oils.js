"use strict";
const fs      = require("fs");
const path    = require("path");
const JSZip   = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");

const CATALOG_PATH = path.join(__dirname, "oil-catalog.json");

// ─────────────────────────────────────────────────────────────
// ПРИОРИТЕТНЫЕ БРЕНДЫ
// ─────────────────────────────────────────────────────────────
const PRIORITY_BRANDS = ["AREOL", "COMMA", "ZIC"];

const BRAND_PRIORITY = [
  "AREOL", "COMMA", "ZIC",
  "LIQUI MOLY", "CASTROL", "MOBIL", "SHELL", "TOTACHI", "SINTEC", "LUKOIL",
  "ROLF", "MANNOL", "REPSOL", "BARDAHL", "TAKAYAMA", "HYUNDAI XTEER",
  "TOYOTA", "LEXUS", "MOBIS", "NISSAN", "MITSUBISHI", "VAG", "GM",
  "IDEMITSU", "REINWELL", "PROFI-CAR", "FURO", "PEXOL", "COMMA",
  "HI-GEAR", "LAVR", "ВМПАВТО",
];

// Региональный приоритет вязкостей (RU/СНГ)
const VISCOSITY_PRIORITY = [
  "5W-30", "5W-40", "10W-40", "10W-30",
  "0W-30", "0W-40", "0W-20", "5W-50", "15W-40",
];

// ─────────────────────────────────────────────────────────────
// ОБЪЁМ КАНИСТРЫ — целевой объём для подбора
// ─────────────────────────────────────────────────────────────
function pickCanisterVolume(oilVolume) {
  if (!oilVolume) return null;
  const standard = [1, 2, 3, 4, 5, 6, 7, 8, 10, 20];
  for (const vol of standard) {
    if (vol >= oilVolume) return vol;
  }
  return 10;
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

function clean(v) {
  return (v || "").trim();
}

// ─────────────────────────────────────────────────────────────
// РАЗБОР ДОПУСКА НА СОСТАВНЫЕ ЧАСТИ
// ─────────────────────────────────────────────────────────────
function parseAceaParts(normalized) {
  const m = normalized.match(/^ACEA([A-Z]\d(?:\/[A-Z]\d)*)$/);
  if (!m) return null;
  return m[1].split("/");
}

function parseApiParts(normalized) {
  const m = normalized.match(/^API([A-Z]{2}(?:\/[A-Z]{2})*)$/);
  if (!m) return null;
  return m[1].split("/");
}

// ─────────────────────────────────────────────────────────────
// СОВМЕСТИМОСТЬ ДОПУСКОВ
// ─────────────────────────────────────────────────────────────
function isSpecCompatible(required, candidate) {
  if (!required || !candidate) return false;
  if (required === candidate) return true;

  const reqAcea  = parseAceaParts(required);
  const candAcea = parseAceaParts(candidate);

  if (reqAcea && candAcea) {
    const reqClasses  = reqAcea.map(p => p[0]);
    const candClasses = candAcea.map(p => p[0]);

    const reqHasA  = reqClasses.some(c => c === "A");
    const reqHasC  = reqClasses.some(c => c === "C");
    const candHasA = candClasses.some(c => c === "A");
    const candHasC = candClasses.some(c => c === "C");

    if ((reqHasA && candHasC && !candHasA) || (reqHasC && candHasA && !candHasC)) {
      return false;
    }

    return reqAcea.some(r => candAcea.includes(r));
  }

  const reqGF  = required.match(/^(?:ILSAC)?GF-?(\d+)$/);
  const candGF = candidate.match(/^(?:ILSAC)?GF-?(\d+)$/);
  if (reqGF && candGF) {
    return parseInt(candGF[1]) >= parseInt(reqGF[1]);
  }

  const reqApi  = parseApiParts(required);
  const candApi = parseApiParts(candidate);
  if (reqApi && candApi) {
    return reqApi.some(r => candApi.includes(r));
  }

  return false;
}

// ─────────────────────────────────────────────────────────────
// MATCHOIL — основная функция подбора
// ─────────────────────────────────────────────────────────────
function matchOil({ specs = [], volume = null, viscosity = null, prefs = {} } = {}) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));
  } catch (e) {
    console.error("[oils] catalog not found:", e.message);
    return [];
  }

  const normalizedSpecs = specs.map(s => normalizeSpec(s));
  const targetVolume    = pickCanisterVolume(volume);

  // ── Определяем рабочую вязкость ──────────────────────────
  const clientViscosity  = prefs?.viscosity ? normalizeViscosity(prefs.viscosity) : null;
  const autoViscosity    = viscosity ? normalizeViscosity(viscosity) : null;
  const workingViscosity = clientViscosity || autoViscosity;

  const viscosityNotRecommended = !!(
    clientViscosity && autoViscosity && clientViscosity !== autoViscosity
  );

  // ── Предпочтение бренда ───────────────────────────────────
  const preferredBrand = prefs?.brand ? prefs.brand.toUpperCase() : null;

  // ── Допустимый диапазон объёма канистры ──────────────────
  // Заправочный объём 4.2л → targetVolume=5л → minVol=4, maxVol=7
  // ВАЖНО: если targetVolume известен — позиции с volume==null тоже отсекаем
  let minVol = null;
  let maxVol = null;
  if (targetVolume) {
    minVol = Math.max(3, targetVolume - 1);
    maxVol = Math.min(10, targetVolume + 2);
  }

  console.log(`[matchOil] specs=${JSON.stringify(normalizedSpecs)} viscosity=${workingViscosity} volume=${volume}л→target=${targetVolume}л min=${minVol} max=${maxVol}`);

  // ── Скоринг ───────────────────────────────────────────────
  const scored = catalog.map(item => {

    // ── Фильтр по вязкости (строгий) ─────────────────────────
    const itemViscosity = normalizeViscosity(item.viscosity);
    if (workingViscosity && itemViscosity && itemViscosity !== workingViscosity) {
      return null;
    }

    // ── Фильтр: только синтетика ──────────────────────────────
    const itemOilType = (item.oil_type || "").toLowerCase();
    const clientWantsNonSynth = !!(
      prefs?.oilType && !prefs.oilType.toLowerCase().includes("синт")
    );
    if (!clientWantsNonSynth) {
      if (
        itemOilType.includes("полусинт") ||
        itemOilType.includes("минерал") ||
        itemOilType === "п/синт" ||
        itemOilType === "п/синтетическое"
      ) {
        return null;
      }
    }

    // ── Фильтр объёма канистры ────────────────────────────────
    // Всегда убираем <2л (доливочные), даже без targetVolume
    if (item.volume != null && item.volume < 2) {
      return null;
    }

    // ── ФИКС: если заправочный объём известен —
    //    отсекаем позиции с неизвестным объёмом И вне диапазона
    if (minVol !== null) {
      if (item.volume == null || item.volume < minVol || item.volume > maxVol) {
        return null;
      }
    }

    // ── Скоринг ───────────────────────────────────────────────
    let score = 0;

    if (workingViscosity && itemViscosity === workingViscosity) score += 50;

    // ── Матчинг допусков ──────────────────────────────────────
    const itemSpecs = (item.all_specs || []).map(s => normalizeSpec(s));

    let oemMatches  = 0;
    let aceaMatches = 0;
    let apiMatches  = 0;

    for (const s of normalizedSpecs) {
      if (!s) continue;
      const matched = itemSpecs.some(is => isSpecCompatible(s, is));
      if (!matched) continue;

      if (/^[A-Z]{2}\d{4}$|^\d{3}\.\d{2}$|RN|MB|BMW|VW|GM/.test(s)) {
        oemMatches++;
      } else if (s.startsWith("ACEA")) {
        aceaMatches++;
      } else if (s.startsWith("API")) {
        apiMatches++;
      } else {
        oemMatches++;
      }
    }

    score += oemMatches  * 100;
    score += aceaMatches * 40;
    score += apiMatches  * 30;

    if (normalizedSpecs.length > 0 && (oemMatches + aceaMatches + apiMatches) === 0) {
      score -= 300;
    }

    // ── Объём канистры — бонус ────────────────────────────────
    if (targetVolume && item.volume != null) {
      if (item.volume === targetVolume)          score += 40;
      else if (item.volume === targetVolume + 1) score += 20;
      else                                       score += 5;
    }

    // ── Приоритет бренда ──────────────────────────────────────
    const itemBrand = (item.brand || "").toUpperCase();
    if (preferredBrand && itemBrand === preferredBrand) score += 200;
    if (PRIORITY_BRANDS.includes(itemBrand)) score += 60;
    const brandIdx = BRAND_PRIORITY.indexOf(itemBrand);
    if (brandIdx >= 0) score += Math.max(0, 30 - brandIdx);

    score -= item.price / 10000;

    return {
      ...item,
      _score: score,
      _oem:   oemMatches,
      _acea:  aceaMatches,
      _api:   apiMatches,
    };
  }).filter(Boolean);

  scored.sort((a, b) => b._score - a._score);

  // ── Топ-3 с разными брендами ──────────────────────────────
  const result     = [];
  const usedBrands = new Set();

  if (preferredBrand) {
    const preferred = scored.find(i => i.brand.toUpperCase() === preferredBrand);
    if (preferred) {
      result.push(preferred);
      usedBrands.add(preferred.brand.toUpperCase());
    }
  }

  for (const item of scored) {
    if (result.length >= 3) break;
    const b = item.brand.toUpperCase();
    if (!usedBrands.has(b)) {
      result.push(item);
      usedBrands.add(b);
    }
  }

  if (result.length < 3) {
    for (const item of scored) {
      if (result.length >= 3) break;
      if (!result.includes(item)) result.push(item);
    }
  }

  console.log(`[matchOil] results: ${result.map(r => `${r.brand} ${r.article} score=${Math.round(r._score)} oem=${r._oem} acea=${r._acea} vol=${r.volume}л`).join(" | ")}`);

  // ── Формируем предупреждения ──────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// ФОРМАТИРОВАНИЕ РЕЗУЛЬТАТА
// ─────────────────────────────────────────────────────────────
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
// НОРМАЛИЗАЦИЯ XLSX → oil-catalog.json
// ─────────────────────────────────────────────────────────────
async function normalizeOilCatalog(xlsxPath = path.join(__dirname, "main.xlsx")) {
  console.log("[oils] reading", xlsxPath);
  const buf    = fs.readFileSync(xlsxPath);
  const zip    = await JSZip.loadAsync(buf);
  const ssXml  = await zip.file("xl/sharedStrings.xml").async("string");
  const strings = parseSharedStrings(ssXml);
  const shXml  = await zip.file("xl/worksheets/sheet1.xml").async("string");
  const rows   = parseSheet(shXml, strings);
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
  const oem       = splitSpecs(
    [cells["Y"], cells["Z"], cells["["], cells["^"]].join(";")
  );
  const allSpecs  = [...api, ...ilsac, ...acea, ...oem];

  return {
    brand,
    article,
    sku:         clean(cells["D"]),
    description: clean(cells["C"]),
    price:       parseFloat(cells["G"]) || 0,
    stock,
    volume,
    viscosity,
    oil_type:    clean(cells["U"]),
    api, ilsac, acea, oem,
    all_specs: allSpecs,
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
        val = t === "s"
          ? (strings[parseInt(vEl.textContent.trim())] ?? "")
          : (vEl.textContent || "");
      }
      cells[col] = val;
    }
    rows.push(cells);
  }
  return rows;
}

module.exports = { normalizeOilCatalog, matchOil };