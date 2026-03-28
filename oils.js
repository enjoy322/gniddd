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
// ─────────────────────────────────────────────────────────────
function pickCanisterVolume(oilVolume) {
  if (!oilVolume) return null;
  const standard = [1, 2, 3, 4, 5, 6, 7, 8, 10, 20];
  for (const vol of standard) {
    if (vol >= oilVolume) return vol;
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
// ФИХ 1: ТОЧНОЕ СОВПАДЕНИЕ ДОПУСКОВ
// Убираем опасный includes() — он матчил A3 внутри A3/B4
// и GF-6 внутри GF-4 (подстрока в обратную сторону).
// Новая логика:
//   - точное совпадение — всегда OK
//   - ILSAC GF-N: кандидат с номером >= требуемого — OK (обратная совместимость)
//   - всё остальное — только точное совпадение
// ─────────────────────────────────────────────────────────────
function isSpecCompatible(required, candidate) {
  if (required === candidate) return true;

  // ILSAC GF-N: GF-5 и GF-6 покрывают GF-4 (обратно совместимы вверх)
  const reqGF  = required.match(/^ILSACGF-(\d+)$/);
  const candGF = candidate.match(/^ILSACGF-(\d+)$/);
  if (reqGF && candGF) {
    return parseInt(candGF[1]) >= parseInt(reqGF[1]);
  }

  // Всё остальное — только точное совпадение
  // ACEA A5 ≠ ACEA A3/B4, ACEA A5 ≠ ACEA A5/B5 — строго
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
    console.error("[oils] catalog not found");
    return [];
  }

  const normalizedSpecs    = specs.map(s => normalizeSpec(s));
  const targetVolume       = pickCanisterVolume(volume);

  // ── Определяем рабочую вязкость ──────────────────────────────
  const clientViscosity = prefs?.viscosity ? normalizeViscosity(prefs.viscosity) : null;
  const autoViscosity   = viscosity ? normalizeViscosity(viscosity) : null;
  const workingViscosity = clientViscosity || autoViscosity;

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

    // ── ФИХ 2: ФИЛЬТР ПОЛУСИНТЕТИКИ И МИНЕРАЛКИ ──────────────
    // Синтетика — единственный тип для современных двигателей.
    // Если клиент явно не просил полусинтетику через prefs — убираем.
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
    // ── конец фикса 2

    let score = 0;

    // Вязкость совпала
    if (workingViscosity && itemViscosity === workingViscosity) score += 50;

    // ── ФИХ 1: ТОЧНЫЙ МАТЧИНГ ДОПУСКОВ ───────────────────────
    const itemSpecs = (item.all_specs || []).map(s => normalizeSpec(s));

    let oemMatches  = 0;
    let aceaMatches = 0;
    let apiMatches  = 0;

    for (const s of normalizedSpecs) {
      if (!s) continue;

      // Используем isSpecCompatible вместо опасного includes()
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

    // ── ФИХ 3: УВЕЛИЧЕННЫЙ ШТРАФ ЗА ПОЛНЫЙ ПРОМАХ ───────────
    // Было -50 — бренд-бонус AREOL (+60) его перекрывал,
    // и AREOL с A3/B4 лез на 2-ю позицию вместо масел с A5.
    // Теперь -300 — никакой бренд-бонус не перекроет несоответствие.
    if (normalizedSpecs.length > 0 && (oemMatches + aceaMatches + apiMatches) === 0) {
      score -= 300;
    }
    // ── конец фикса 3

    // Объём канистры
    if (targetVolume && item.volume != null) {
      if (item.volume === targetVolume)      score += 40;
      else if (item.volume > targetVolume)   score -= 10;
      else                                   score -= 30;
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

  // ── Определяем предупреждения ─────────────────────────────────
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
// НОРМАЛИЗАЦИЯ XLSX
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