"use strict";
const fs      = require("fs");
const path    = require("path");
const JSZip   = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");

const CATALOG_PATH = path.join(__dirname, "oil-catalog.json");
const OVERRIDE_PATH = path.join(__dirname, "brand-specs-override.json");

// ─────────────────────────────────────────────────────────────
// ПРИОРИТЕТНЫЕ БРЕНДЫ (первая тройка — главные, остальные по убыванию)
// ─────────────────────────────────────────────────────────────
const BRAND_PRIORITY = [
  "AREOL",          // #1 — всегда первый
  "COMMA",          // #2
  "ZIC",            // #3
  "LUKOIL",         // #4
  "SINTEC",         // #5
  "LIQUI MOLY", "CASTROL", "MOBIL", "SHELL", "TOTACHI",
  "ROLF", "MANNOL", "REPSOL", "BARDAHL", "TAKAYAMA", "HYUNDAI XTEER",
  "TOYOTA", "LEXUS", "MOBIS", "NISSAN", "MITSUBISHI", "VAG", "GM",
  "IDEMITSU", "REINWELL", "PROFI-CAR", "FURO", "PEXOL",
  "HI-GEAR", "LAVR", "ВМПАВТО",
];

// Топ-бренды (получают макс. бонус, но ТОЛЬКО если допуски совпали)
const TOP_BRANDS    = ["AREOL", "COMMA", "ZIC"];
// Средне-приоритетные
const MID_BRANDS    = ["LUKOIL", "SINTEC"];

// ─────────────────────────────────────────────────────────────
// ИЕРАРХИЯ API
// ─────────────────────────────────────────────────────────────
const API_GASOLINE_HIERARCHY = ["SA", "SB", "SC", "SD", "SE", "SF", "SG", "SH", "SJ", "SL", "SM", "SN", "SP"];
const API_DIESEL_HIERARCHY   = ["CA", "CB", "CC", "CD", "CE", "CF", "CF2", "CG4", "CH4", "CI4", "CJ4", "CK4", "FA4"];

// ─────────────────────────────────────────────────────────────
// ИЕРАРХИЯ ILSAC
// ─────────────────────────────────────────────────────────────
const ILSAC_HIERARCHY = ["GF-1", "GF-2", "GF-3", "GF-4", "GF-5", "GF-6A", "GF-6B"];

// ─────────────────────────────────────────────────────────────
// ИЕРАРХИЯ ACEA
// ─────────────────────────────────────────────────────────────
const ACEA_A_HIERARCHY = ["A1", "A3", "A5"];
const ACEA_B_HIERARCHY = ["B1", "B3", "B4", "B5"];
const ACEA_C_HIERARCHY = ["C1", "C2", "C3", "C4", "C5"];

// ─────────────────────────────────────────────────────────────
// ОБЪЁМ КАНИСТРЫ — СТРОГО 4л или 5л
// ─────────────────────────────────────────────────────────────
function pickCanisterVolume(oilVolume) {
  if (!oilVolume) return 4; // по умолчанию 4л
  return oilVolume > 4.3 ? 5 : 4;
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
// ЗАГРУЗКА OVERRIDE-ФАЙЛА (ручные допуски для топ-брендов)
// ─────────────────────────────────────────────────────────────
let _overrideCache = null;

function loadOverrides() {
  if (_overrideCache !== null) return _overrideCache;
  try {
    if (fs.existsSync(OVERRIDE_PATH)) {
      _overrideCache = JSON.parse(fs.readFileSync(OVERRIDE_PATH, "utf-8"));
      console.log(`[oils] loaded ${Object.keys(_overrideCache).length} overrides from brand-specs-override.json`);
    } else {
      _overrideCache = {};
    }
  } catch (e) {
    console.error("[oils] override load error:", e.message);
    _overrideCache = {};
  }
  return _overrideCache;
}

// Сброс кэша (вызывать если файл обновился)
function resetOverrideCache() {
  _overrideCache = null;
}

// Применяет override к товару: добавляет oem_add, проверяет oem_exclude_for
function applyOverride(item, requiredSpecs) {
  const overrides = loadOverrides();
  const override = overrides[item.article] || overrides[item.sku];
  if (!override) return { item, excluded: false };

  // Добавляем допуски
  if (override.oem_add && override.oem_add.length) {
    const existing = new Set((item.all_specs || []).map(s => normalizeSpec(s)));
    const newSpecs = override.oem_add.filter(s => !existing.has(normalizeSpec(s)));
    item = {
      ...item,
      oem: [...(item.oem || []), ...newSpecs],
      all_specs: [...(item.all_specs || []), ...newSpecs],
    };
  }

  // Проверяем исключения: если требуемый допуск в oem_exclude_for — отсеиваем
  if (override.oem_exclude_for && override.oem_exclude_for.length && requiredSpecs.length) {
    const excludeSet = new Set(override.oem_exclude_for.map(s => normalizeSpec(s)));
    for (const req of requiredSpecs) {
      if (excludeSet.has(normalizeSpec(req))) {
        return { item, excluded: true };
      }
    }
  }

  return { item, excluded: false };
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
  const m = normalized.match(/^API([A-Z]{2}(?:\d)?(?:\/[A-Z]{2}(?:\d)?)*)$/);
  if (!m) return null;
  return m[1].split("/");
}

function parseIlsacLevel(normalized) {
  const m = normalized.match(/(?:ILSAC)?(GF-?\d[A-B]?)$/);
  return m ? m[1].replace(/(\d)([AB])/, "$1$2").replace("GF", "GF-").replace("GF--", "GF-") : null;
}

// ─────────────────────────────────────────────────────────────
// УМНАЯ СОВМЕСТИМОСТЬ ДОПУСКОВ
// ─────────────────────────────────────────────────────────────
function specCompatibilityScore(required, candidate) {
  if (!required || !candidate) return 0;
  if (required === candidate) return 10;

  // ── API совместимость ──
  const reqApi = parseApiParts(required);
  const candApi = parseApiParts(candidate);
  if (reqApi && candApi) {
    let bestScore = 0;
    for (const r of reqApi) {
      for (const c of candApi) {
        if (r.startsWith("S") && c.startsWith("S")) {
          const reqIdx = API_GASOLINE_HIERARCHY.indexOf(r);
          const candIdx = API_GASOLINE_HIERARCHY.indexOf(c);
          if (reqIdx >= 0 && candIdx >= 0 && candIdx >= reqIdx) {
            bestScore = Math.max(bestScore, candIdx === reqIdx ? 10 : 8);
          }
        }
        if (r.startsWith("C") && c.startsWith("C")) {
          const reqIdx = API_DIESEL_HIERARCHY.indexOf(r);
          const candIdx = API_DIESEL_HIERARCHY.indexOf(c);
          if (reqIdx >= 0 && candIdx >= 0 && candIdx >= reqIdx) {
            bestScore = Math.max(bestScore, candIdx === reqIdx ? 10 : 8);
          }
        }
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
      const rClass = r[0];
      for (const c of candAcea) {
        const cClass = c[0];
        if (rClass !== cClass) continue;
        if (r === c) { matches++; continue; }

        if (rClass === "C") {
          const reqCIdx = ACEA_C_HIERARCHY.indexOf(r);
          const candCIdx = ACEA_C_HIERARCHY.indexOf(c);
          if (reqCIdx >= 0 && candCIdx >= 0) {
            if (candCIdx >= reqCIdx) matches++;
            else if (r === "C2" && (c === "C3" || c === "C5")) matches++;
          }
        }
        if (rClass === "A") {
          const reqAIdx = ACEA_A_HIERARCHY.indexOf(r);
          const candAIdx = ACEA_A_HIERARCHY.indexOf(c);
          if (reqAIdx >= 0 && candAIdx >= 0 && candAIdx >= reqAIdx) matches++;
        }
        if (rClass === "B") {
          const reqBIdx = ACEA_B_HIERARCHY.indexOf(r);
          const candBIdx = ACEA_B_HIERARCHY.indexOf(c);
          if (reqBIdx >= 0 && candBIdx >= 0 && candBIdx >= reqBIdx) matches++;
        }
      }
    }
    return matches > 0 ? (matches * 5 + 3) : 0;
  }

  // ── OEM допуски — частичное совпадение ──
  // RN0700 == RN0700, MB229.5 == MB229.5
  // Также: "RN 0700" нормализованный == "RN0700"
  // Уже нормализовано — точное совпадение покрыто выше (return 10)
  return 0;
}


// ─────────────────────────────────────────────────────────────
// ОПРЕДЕЛЕНИЕ ТИПА ДОПУСКА (для весов)
// ─────────────────────────────────────────────────────────────
function isOemSpec(spec) {
  // OEM: VW502.00, MB229.5, RN0700, BMWLL-04, FORDWSS-M2C913 и т.д.
  return /^(VW|MB|RN|BMW|FORD|GM|PSA|FIAT|PORSCHE|DEXOS)/i.test(spec)
    || /^\d{3}\.\d/.test(spec); // 229.5, 502.00
}

function specWeight(spec) {
  if (isOemSpec(spec)) return 15;     // OEM — самый важный
  if (/^ACEA/.test(spec)) return 8;
  if (/GF/.test(spec) || /^ILSAC/.test(spec)) return 7;
  if (/^API/.test(spec)) return 6;
  return 5;
}


// ─────────────────────────────────────────────────────────────
// MATCHOIL — основная функция подбора (v2 — жёсткий фильтр)
// ─────────────────────────────────────────────────────────────
function matchOil({ specs = [], volume = null, viscosity = null, prefs = {}, limit = 6 } = {}) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));
  } catch (e) {
    console.error("[oils] catalog not found:", e.message);
    return [];
  }

  const normalizedSpecs = specs.map(s => normalizeSpec(s)).filter(Boolean);
  const targetVolume    = pickCanisterVolume(volume);
  const hasRequiredSpecs = normalizedSpecs.length > 0;

  // ── Определяем рабочую вязкость ──────────────────────────
  const clientViscosity  = prefs?.viscosity ? normalizeViscosity(prefs.viscosity) : null;
  const autoViscosity    = viscosity ? normalizeViscosity(viscosity) : null;
  const workingViscosity = clientViscosity || autoViscosity;

  const viscosityNotRecommended = !!(
    clientViscosity && autoViscosity && clientViscosity !== autoViscosity
  );

  // ── Предпочтение бренда ───────────────────────────────────
  const preferredBrand = prefs?.brand ? prefs.brand.toUpperCase() : null;

  console.log(`[matchOil] specs=${JSON.stringify(normalizedSpecs)} viscosity=${workingViscosity} volume=${volume}л→canister=${targetVolume}л limit=${limit}`);

  // ── Скоринг ───────────────────────────────────────────────
  const scored = catalog.map(rawItem => {

    // ── Применяем override допусков (для топ-брендов) ─────────
    const { item, excluded } = applyOverride({ ...rawItem }, normalizedSpecs);
    if (excluded) return null;

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

    // ── Фильтр объёма — СТРОГО 4л или 5л ─────────────────────
    if (item.volume == null || item.volume < 2) return null;

    // Допускаем канистры: целевой объём ± 0.5л
    // Т.е. для target=4: от 3.5 до 4.5
    // Для target=5: от 4.5 до 5.5
    if (Math.abs(item.volume - targetVolume) > 0.5) {
      return null;
    }

    // ── СКОРИНГ ───────────────────────────────────────────────
    let score = 0;

    // Вязкость — бонус за совпадение
    if (workingViscosity && itemViscosity === workingViscosity) score += 30;

    // ── Матчинг допусков с учётом иерархии ────────────────────
    const itemSpecs = (item.all_specs || []).map(s => normalizeSpec(s));

    let totalSpecScore = 0;
    let specMatchCount = 0;
    let oemMatchCount  = 0;

    for (const reqSpec of normalizedSpecs) {
      if (!reqSpec) continue;

      let bestMatch = 0;
      for (const itemSpec of itemSpecs) {
        const compat = specCompatibilityScore(reqSpec, itemSpec);
        if (compat > bestMatch) bestMatch = compat;
      }

      if (bestMatch > 0) {
        specMatchCount++;
        if (isOemSpec(reqSpec)) oemMatchCount++;

        const weight = specWeight(reqSpec);
        totalSpecScore += bestMatch * weight;
      }
    }

    score += totalSpecScore;

    // ─────────────────────────────────────────────────────────
    // ЖЁСТКИЙ ФИЛЬТР: если есть требуемые допуски, но ни один
    // не совпал — ПОЛНЫЙ ОТСЕВ (не штраф, а null)
    // ─────────────────────────────────────────────────────────
    if (hasRequiredSpecs && specMatchCount === 0) {
      return null; // ← ключевое изменение v2
    }

    // ── Бонус за количество совпавших допусков ────────────────
    if (specMatchCount > 0) {
      const matchRatio = specMatchCount / normalizedSpecs.length;
      score += matchRatio * 50;
    }

    // ── Бонус за OEM-совпадение (самое ценное) ────────────────
    if (oemMatchCount > 0) {
      score += oemMatchCount * 30;
    }

    // ── Объём канистры — бонус за точное попадание ─────────────
    if (item.volume === targetVolume) score += 20;

    // ── Приоритет бренда (работает ТОЛЬКО если допуски совпали) ─
    const itemBrand = (item.brand || "").toUpperCase();

    // Предпочтение клиента — главный приоритет
    if (preferredBrand && itemBrand === preferredBrand) score += 200;

    // Топ-бренды: AREOL=+80, COMMA=+70, ZIC=+60
    const topIdx = TOP_BRANDS.indexOf(itemBrand);
    if (topIdx >= 0) {
      score += 80 - (topIdx * 10);
    }

    // Средне-приоритетные: LUKOIL=+40, SINTEC=+35
    const midIdx = MID_BRANDS.indexOf(itemBrand);
    if (midIdx >= 0) {
      score += 40 - (midIdx * 5);
    }

    // Остальные бренды из списка — маленький бонус
    const brandIdx = BRAND_PRIORITY.indexOf(itemBrand);
    if (brandIdx >= 0 && topIdx < 0 && midIdx < 0) {
      score += Math.max(0, 15 - brandIdx);
    }

    // Небольшой бонус за более низкую цену
    score -= item.price / 50000;

    return {
      ...item,
      _score:          score,
      _specMatchCount: specMatchCount,
      _oemMatchCount:  oemMatchCount,
      _totalSpecScore: totalSpecScore,
    };
  }).filter(Boolean);

  scored.sort((a, b) => b._score - a._score);

  // ── Топ с разными брендами ─────────────────────────────────
  const result     = [];
  const usedBrands = new Set();

  // Каскадный подбор: Топ → Средние → Остальные
  function fillFromTier(tierBrands) {
    for (const item of scored) {
      if (result.length >= limit) break;
      const b = item.brand.toUpperCase();
      if (usedBrands.has(b)) continue;
      if (tierBrands && !tierBrands.includes(b)) continue;
      result.push(item);
      usedBrands.add(b);
    }
  }

  // Если клиент выбрал бренд — он первый
  if (preferredBrand) {
    const preferred = scored.find(i => i.brand.toUpperCase() === preferredBrand);
    if (preferred) {
      result.push(preferred);
      usedBrands.add(preferred.brand.toUpperCase());
    }
  }

  // 1. Топ-бренды (AREOL, COMMA, ZIC)
  fillFromTier(TOP_BRANDS);
  // 2. Средне-приоритетные (LUKOIL, SINTEC)
  fillFromTier(MID_BRANDS);
  // 3. Все остальные
  fillFromTier(null);

  // Дозаполняем если меньше limit (допускаем повтор бренда)
  if (result.length < limit) {
    for (const item of scored) {
      if (result.length >= limit) break;
      if (!result.includes(item)) result.push(item);
    }
  }

  console.log(`[matchOil] results: ${result.map(r => `${r.brand} ${r.article} score=${Math.round(r._score)} specMatch=${r._specMatchCount}/${normalizedSpecs.length} oemMatch=${r._oemMatchCount} vol=${r.volume}л`).join(" | ")}`);

  // ── Формируем предупреждения ──────────────────────────────
  return result.map(item => {
    const hasSpecMatch = item._specMatchCount > 0;
    let warning = null;

    if (viscosityNotRecommended) {
      warning = "вязкость не рекомендована производителем";
    }
    // Больше не нужен warning "требует перепроверки допусков"
    // т.к. товары без совпадения допусков отсеяны полностью

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
    _score:          Math.round(item._score),
    _specMatchCount: item._specMatchCount,
    _oemMatchCount:  item._oemMatchCount,
  };
}

// ─────────────────────────────────────────────────────────────
// НОРМАЛИЗАЦИЯ XLSX → oil-catalog.json (без изменений)
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

module.exports = { normalizeOilCatalog, matchOil, resetOverrideCache };