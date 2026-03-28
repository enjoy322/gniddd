"use strict";
const fs      = require("fs");
const path    = require("path");
const JSZip   = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");

const CATALOG_PATH = path.join(__dirname, "oil-catalog.json");

// ─────────────────────────────────────────────────────────────
// ПРИОРИТЕТНЫЕ БРЕНДЫ (первая тройка — главные, остальные по убыванию)
// ─────────────────────────────────────────────────────────────
const BRAND_PRIORITY = [
  "AREOL",          // #1 — всегда первый
  "COMMA",          // #2
  "ZIC",            // #3
  "LUKOIL",         // #4
  "LIQUI MOLY", "CASTROL", "MOBIL", "SHELL", "TOTACHI", "SINTEC",
  "ROLF", "MANNOL", "REPSOL", "BARDAHL", "TAKAYAMA", "HYUNDAI XTEER",
  "TOYOTA", "LEXUS", "MOBIS", "NISSAN", "MITSUBISHI", "VAG", "GM",
  "IDEMITSU", "REINWELL", "PROFI-CAR", "FURO", "PEXOL",
  "HI-GEAR", "LAVR", "ВМПАВТО",
];

// Топ-бренды для витрины (первая тройка получает макс. бонус)
const TOP_BRANDS = ["AREOL", "COMMA", "ZIC", "LUKOIL"];

// ─────────────────────────────────────────────────────────────
// ИЕРАРХИЯ API (обратная совместимость: SP заменяет SN, SN заменяет SM и т.д.)
// ─────────────────────────────────────────────────────────────
const API_GASOLINE_HIERARCHY = ["SA", "SB", "SC", "SD", "SE", "SF", "SG", "SH", "SJ", "SL", "SM", "SN", "SP"];
const API_DIESEL_HIERARCHY   = ["CA", "CB", "CC", "CD", "CE", "CF", "CF2", "CG4", "CH4", "CI4", "CJ4", "CK4", "FA4"];

// ─────────────────────────────────────────────────────────────
// ИЕРАРХИЯ ILSAC (обратная совместимость: GF-6A заменяет GF-5 и т.д.)
// ─────────────────────────────────────────────────────────────
const ILSAC_HIERARCHY = ["GF-1", "GF-2", "GF-3", "GF-4", "GF-5", "GF-6A", "GF-6B"];

// ─────────────────────────────────────────────────────────────
// ИЕРАРХИЯ ACEA (сложнее: A/B — обычные, C — low SAPS)
// A3/B4 > A3/B3 > A1/B1
// C5, C3, C2 — low SAPS, совместимы между собой с оговорками
// ─────────────────────────────────────────────────────────────
const ACEA_A_HIERARCHY = ["A1", "A3", "A5"];
const ACEA_B_HIERARCHY = ["B1", "B3", "B4", "B5"];
const ACEA_C_HIERARCHY = ["C1", "C2", "C3", "C4", "C5"];

// Региональный приоритет вязкостей
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

// "ACEAA3/B4" → ["A3", "B4"]
function parseAceaParts(normalized) {
  const m = normalized.match(/^ACEA([A-Z]\d(?:\/[A-Z]\d)*)$/);
  if (!m) return null;
  return m[1].split("/");
}

// "APISP" → ["SP"], "APISN/CF" → ["SN", "CF"]
function parseApiParts(normalized) {
  const m = normalized.match(/^API([A-Z]{2}(?:\d)?(?:\/[A-Z]{2}(?:\d)?)*)$/);
  if (!m) return null;
  return m[1].split("/");
}

// "ILSACGF-5" or "GF-5" → "GF-5"
function parseIlsacLevel(normalized) {
  const m = normalized.match(/(?:ILSAC)?(GF-?\d[A-B]?)$/);
  return m ? m[1].replace(/(\d)([AB])/, "$1$2").replace("GF", "GF-").replace("GF--", "GF-") : null;
}

// ─────────────────────────────────────────────────────────────
// УМНАЯ СОВМЕСТИМОСТЬ ДОПУСКОВ
// ─────────────────────────────────────────────────────────────

/**
 * Возвращает score совместимости (0 = не совместим, 1+ = совместим)
 * Чем выше score — тем лучше совпадение
 */
function specCompatibilityScore(required, candidate) {
  if (!required || !candidate) return 0;
  if (required === candidate) return 10; // точное совпадение

  // ── API совместимость ──
  const reqApi = parseApiParts(required);
  const candApi = parseApiParts(candidate);
  if (reqApi && candApi) {
    let bestScore = 0;
    for (const r of reqApi) {
      for (const c of candApi) {
        // Бензиновые (S-серия)
        if (r.startsWith("S") && c.startsWith("S")) {
          const reqIdx = API_GASOLINE_HIERARCHY.indexOf(r);
          const candIdx = API_GASOLINE_HIERARCHY.indexOf(c);
          if (reqIdx >= 0 && candIdx >= 0 && candIdx >= reqIdx) {
            // Кандидат равен или выше требуемого — совместим
            bestScore = Math.max(bestScore, candIdx === reqIdx ? 10 : 8);
          }
        }
        // Дизельные (C-серия)
        if (r.startsWith("C") && c.startsWith("C")) {
          const reqIdx = API_DIESEL_HIERARCHY.indexOf(r);
          const candIdx = API_DIESEL_HIERARCHY.indexOf(c);
          if (reqIdx >= 0 && candIdx >= 0 && candIdx >= reqIdx) {
            bestScore = Math.max(bestScore, candIdx === reqIdx ? 10 : 8);
          }
        }
        // Точное совпадение для других
        if (r === c) bestScore = Math.max(bestScore, 10);
      }
    }
    return bestScore;
  }

  // ── ILSAC совместимость ──
  const reqIlsac = parseIlsacLevel(required);
  const candIlsac = parseIlsacLevel(candidate);
  if (reqIlsac && candIlsac) {
    const reqIdx = ILSAC_HIERARCHY.indexOf(reqIlsac);
    const candIdx = ILSAC_HIERARCHY.indexOf(candIlsac);
    if (reqIdx >= 0 && candIdx >= 0 && candIdx >= reqIdx) {
      return candIdx === reqIdx ? 10 : 8;
    }
    return 0;
  }

  // ── ACEA совместимость ──
  const reqAcea = parseAceaParts(required);
  const candAcea = parseAceaParts(candidate);
  if (reqAcea && candAcea) {
    let matches = 0;
    for (const r of reqAcea) {
      const rClass = r[0]; // A, B, or C
      for (const c of candAcea) {
        const cClass = c[0];
        if (rClass !== cClass) continue;

        if (r === c) {
          matches++;
          continue;
        }

        // ACEA C — low SAPS: C5 ≈ C2 (низкозольные), C3 — универсальный
        if (rClass === "C") {
          const reqCIdx = ACEA_C_HIERARCHY.indexOf(r);
          const candCIdx = ACEA_C_HIERARCHY.indexOf(c);
          // C3 совместим с C2 (C3 строже), C5 совместим с C2
          if (reqCIdx >= 0 && candCIdx >= 0) {
            // Если кандидат — C3, а требуется C2 — ОК (C3 более строгий)
            // Если кандидат — C5, а требуется C2 — ОК (C5 modern low SAPS)
            if (candCIdx >= reqCIdx) matches++;
            // C2 запрошен, C5 есть — тоже ОК
            else if (r === "C2" && (c === "C3" || c === "C5")) matches++;
          }
        }

        // ACEA A — обычные бензиновые
        if (rClass === "A") {
          const reqAIdx = ACEA_A_HIERARCHY.indexOf(r);
          const candAIdx = ACEA_A_HIERARCHY.indexOf(c);
          if (reqAIdx >= 0 && candAIdx >= 0 && candAIdx >= reqAIdx) matches++;
        }

        // ACEA B — дизельные
        if (rClass === "B") {
          const reqBIdx = ACEA_B_HIERARCHY.indexOf(r);
          const candBIdx = ACEA_B_HIERARCHY.indexOf(c);
          if (reqBIdx >= 0 && candBIdx >= 0 && candBIdx >= reqBIdx) matches++;
        }
      }
    }
    return matches > 0 ? (matches * 5 + 3) : 0;
  }

  // ── OEM допуски (точное совпадение) ──
  return 0;
}


// ─────────────────────────────────────────────────────────────
// MATCHOIL — основная функция подбора (ПОЛНОСТЬЮ ПЕРЕПИСАНА)
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

    // ── Фильтр объёма ─────────────────────────────────────────
    if (item.volume != null && item.volume < 2) return null;

    if (minVol !== null) {
      if (item.volume == null || item.volume < minVol || item.volume > maxVol) {
        return null;
      }
    }

    // ── СКОРИНГ ───────────────────────────────────────────────
    let score = 0;

    // Вязкость — бонус за совпадение
    if (workingViscosity && itemViscosity === workingViscosity) score += 30;

    // ── Матчинг допусков с учётом иерархии ────────────────────
    const itemSpecs = (item.all_specs || []).map(s => normalizeSpec(s));

    let totalSpecScore = 0;
    let specMatchCount = 0;

    for (const reqSpec of normalizedSpecs) {
      if (!reqSpec) continue;

      // Ищем лучший match среди всех допусков товара
      let bestMatch = 0;
      for (const itemSpec of itemSpecs) {
        const compat = specCompatibilityScore(reqSpec, itemSpec);
        if (compat > bestMatch) bestMatch = compat;
      }

      if (bestMatch > 0) {
        specMatchCount++;

        // Определяем тип допуска для весов
        if (/^[A-Z]{2}\d{3,4}|^\d{3}\.\d|RN|MB|BMW|VW|GM/i.test(reqSpec)) {
          // OEM допуск — самый важный
          totalSpecScore += bestMatch * 12;
        } else if (reqSpec.startsWith("ACEA")) {
          totalSpecScore += bestMatch * 8;
        } else if (reqSpec.includes("GF") || reqSpec.startsWith("ILSAC")) {
          totalSpecScore += bestMatch * 7;
        } else if (reqSpec.startsWith("API")) {
          totalSpecScore += bestMatch * 6;
        } else {
          totalSpecScore += bestMatch * 5;
        }
      }
    }

    score += totalSpecScore;

    // ── Штраф за полное отсутствие совпадений ─────────────────
    if (normalizedSpecs.length > 0 && specMatchCount === 0) {
      score -= 500;
    }

    // ── Бонус за количество совпавших допусков ────────────────
    if (specMatchCount > 0) {
      const matchRatio = specMatchCount / normalizedSpecs.length;
      score += matchRatio * 50; // до +50 за 100% матч
    }

    // ── Объём канистры — бонус ────────────────────────────────
    if (targetVolume && item.volume != null) {
      if (item.volume === targetVolume)          score += 30;
      else if (item.volume === targetVolume + 1) score += 15;
      else                                       score += 3;
    }

    // ── Приоритет бренда ──────────────────────────────────────
    const itemBrand = (item.brand || "").toUpperCase();

    // Предпочтение клиента — главный приоритет
    if (preferredBrand && itemBrand === preferredBrand) score += 300;

    // Топ-бренды: AREOL=+100, COMMA=+90, ZIC=+80, LUKOIL=+70
    const topIdx = TOP_BRANDS.indexOf(itemBrand);
    if (topIdx >= 0) {
      score += 100 - (topIdx * 10);
    }

    // Остальные бренды из списка
    const brandIdx = BRAND_PRIORITY.indexOf(itemBrand);
    if (brandIdx >= 0) {
      score += Math.max(0, 20 - brandIdx);
    }

    // Небольшой бонус за более низкую цену (при прочих равных)
    score -= item.price / 50000;

    return {
      ...item,
      _score:          score,
      _specMatchCount: specMatchCount,
      _totalSpecScore: totalSpecScore,
    };
  }).filter(Boolean);

  scored.sort((a, b) => b._score - a._score);

  // ── Топ-3 с разными брендами ──────────────────────────────
  const result     = [];
  const usedBrands = new Set();

  // Если клиент выбрал бренд — он первый
  if (preferredBrand) {
    const preferred = scored.find(i => i.brand.toUpperCase() === preferredBrand);
    if (preferred) {
      result.push(preferred);
      usedBrands.add(preferred.brand.toUpperCase());
    }
  }

  // Заполняем до 3 разных брендов
  for (const item of scored) {
    if (result.length >= 3) break;
    const b = item.brand.toUpperCase();
    if (!usedBrands.has(b)) {
      result.push(item);
      usedBrands.add(b);
    }
  }

  // Дозаполняем если меньше 3
  if (result.length < 3) {
    for (const item of scored) {
      if (result.length >= 3) break;
      if (!result.includes(item)) result.push(item);
    }
  }

  console.log(`[matchOil] results: ${result.map(r => `${r.brand} ${r.article} score=${Math.round(r._score)} specMatch=${r._specMatchCount}/${normalizedSpecs.length} specScore=${r._totalSpecScore} vol=${r.volume}л`).join(" | ")}`);

  // ── Формируем предупреждения ──────────────────────────────
  return result.map(item => {
    const hasSpecMatch = item._specMatchCount > 0;
    let warning = null;

    if (viscosityNotRecommended) {
      warning = "вязкость не рекомендована производителем";
    } else if (!hasSpecMatch && normalizedSpecs.length > 0) {
      warning = "требует перепроверки допусков";
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