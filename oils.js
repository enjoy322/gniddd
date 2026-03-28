"use strict";
const fs   = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");

const CATALOG_PATH  = path.join(__dirname, "oil-catalog.json");
const OVERRIDE_PATH = path.join(__dirname, "brand-specs-override.json");

/* ══════════════════════════════════════════════════════════════
   БРЕНДЫ
   ══════════════════════════════════════════════════════════════ */
const TOP_BRANDS = ["AREOL", "COMMA", "ZIC"];
const MID_BRANDS = ["LUKOIL", "SINTEC"];

/* ══════════════════════════════════════════════════════════════
   ИЕРАРХИИ ДОПУСКОВ
   ══════════════════════════════════════════════════════════════ */
const API_GAS   = ["SA","SB","SC","SD","SE","SF","SG","SH","SJ","SL","SM","SN","SP","SQ"];
const API_DSL   = ["CA","CB","CC","CD","CE","CF","CF2","CG4","CH4","CI4","CJ4","CK4","FA4"];
const ILSAC     = ["GF-1","GF-2","GF-3","GF-4","GF-5","GF-6A","GF-6B","GF-7A"];
const ACEA_A    = ["A1","A3","A5","A7"];
const ACEA_B    = ["B1","B3","B4","B5","B7"];
const ACEA_C    = ["C1","C2","C3","C4","C5","C6"];

/* ══════════════════════════════════════════════════════════════
   НОРМАЛИЗАЦИЯ
   ══════════════════════════════════════════════════════════════ */
function norm(s)  { return (s || "").trim().toUpperCase().replace(/\s+/g, ""); }
function clean(v) { return (v || "").trim(); }

function splitSpecs(raw) {
  if (!raw) return [];
  return raw.split(";").map(s => s.trim()).filter(Boolean);
}

/* ══════════════════════════════════════════════════════════════
   ОБЪЁМ КАНИСТРЫ — строго 4л или 5л
   ══════════════════════════════════════════════════════════════ */
function pickCanisterVolume(fillVol) {
  if (!fillVol) return 4;
  return fillVol > 4.3 ? 5 : 4;
}

/* ══════════════════════════════════════════════════════════════
   OVERRIDE — ручные допуски для топ-брендов
   ══════════════════════════════════════════════════════════════ */
let _ovr = null;

function loadOverrides() {
  if (_ovr !== null) return _ovr;
  try {
    _ovr = fs.existsSync(OVERRIDE_PATH)
      ? JSON.parse(fs.readFileSync(OVERRIDE_PATH, "utf-8"))
      : {};
    const n = Object.keys(_ovr).filter(k => k !== "_comment").length;
    if (n) console.log(`[oils] loaded ${n} overrides`);
  } catch (e) {
    console.error("[oils] override error:", e.message);
    _ovr = {};
  }
  return _ovr;
}

function resetOverrideCache() { _ovr = null; }

/**
 * Мержит override в item. Возвращает { item, excluded }.
 * excluded=true → товар запрещён для этих requiredSpecs.
 */
function applyOverride(item, requiredSpecs) {
  const overrides = loadOverrides();
  // Ищем по артикулу (точно), потом по SKU, потом upper-trim
  const key = Object.keys(overrides).find(k =>
    k === item.article ||
    k === item.sku ||
    norm(k) === norm(item.article) ||
    norm(k) === norm(item.sku)
  );
  if (!key || key === "_comment") return { item, excluded: false };
  const ovr = overrides[key];

  // 1) Проверяем oem_exclude_for ПЕРВЫМ
  if (ovr.oem_exclude_for && ovr.oem_exclude_for.length && requiredSpecs.length) {
    const excSet = new Set(ovr.oem_exclude_for.map(norm));
    for (const req of requiredSpecs) {
      if (excSet.has(norm(req))) {
        return { item, excluded: true };
      }
    }
  }

  // 2) Добавляем oem_add в oem и all_specs
  if (ovr.oem_add && ovr.oem_add.length) {
    const existing = new Set((item.all_specs || []).map(norm));
    const fresh = ovr.oem_add.filter(s => !existing.has(norm(s)));
    item = {
      ...item,
      oem:       [...(item.oem || []), ...fresh],
      all_specs: [...(item.all_specs || []), ...fresh],
    };
  }

  return { item, excluded: false };
}

/* ══════════════════════════════════════════════════════════════
   СОВМЕСТИМОСТЬ ДОПУСКОВ
   ══════════════════════════════════════════════════════════════ */

/** Проверяет совместимость в рамках одной иерархии. Возвращает score 0-10. */
function hierarchyMatch(reqNorm, candNorm, list) {
  const ri = list.indexOf(reqNorm);
  const ci = list.indexOf(candNorm);
  if (ri < 0 || ci < 0) return 0;
  if (ci === ri) return 10;  // точное
  if (ci > ri)  return 8;   // кандидат новее — обратная совместимость
  return 0;                   // кандидат старее — не подходит
}

/**
 * Сравнивает один требуемый допуск с одним допуском кандидата.
 * Возвращает 0..10 (0 = не совместимы, 10 = точное совпадение).
 */
function specCompat(reqRaw, candRaw) {
  const r = norm(reqRaw);
  const c = norm(candRaw);
  if (r === c) return 10;

  // ── API ──
  // Нормализуем: "APISN" → "SN", "APISN/CF" → ["SN","CF"]
  const rApi = r.replace(/^API/, "");
  const cApi = c.replace(/^API/, "");
  // Проверяем каждую пару через "/" разделитель
  const rParts = rApi.split("/");
  const cParts = cApi.split("/");
  let best = 0;
  for (const rp of rParts) {
    for (const cp of cParts) {
      if (rp === cp) { best = Math.max(best, 10); continue; }
      best = Math.max(best, hierarchyMatch(rp, cp, API_GAS));
      best = Math.max(best, hierarchyMatch(rp, cp, API_DSL));
    }
  }
  if (best > 0) return best;

  // ── ILSAC ──
  function ilsacKey(s) {
    const m = s.match(/(GF-?\d[AB]?)/i);
    return m ? m[1].toUpperCase().replace(/GF(\d)/, "GF-$1") : null;
  }
  const rI = ilsacKey(r), cI = ilsacKey(c);
  if (rI && cI) return hierarchyMatch(rI, cI, ILSAC);

  // ── ACEA ──
  // "ACEAA3/B4" → ["A3","B4"];  "ACEAC2" → ["C2"]
  function aceaParts(s) {
    const m = s.replace(/^ACEA/, "").match(/[A-C]\d/g);
    return m || [];
  }
  const rA = aceaParts(r), cA = aceaParts(c);
  if (rA.length && cA.length) {
    let matches = 0, total = rA.length;
    for (const rp of rA) {
      let pBest = 0;
      for (const cp of cA) {
        if (rp === cp) { pBest = 10; break; }
        if (rp[0] === cp[0]) {
          const list = rp[0] === "A" ? ACEA_A : rp[0] === "B" ? ACEA_B : ACEA_C;
          pBest = Math.max(pBest, hierarchyMatch(rp, cp, list));
        }
      }
      if (pBest > 0) matches++;
    }
    if (matches > 0) return Math.round((matches / total) * 10);
  }

  // OEM — только точное (уже проверено выше через r===c)
  return 0;
}

/** Вес допуска для итогового скора */
function specWeight(raw) {
  const n = norm(raw);
  // OEM-допуски — максимальный вес
  if (/^(VW|MB|RN|BMW|FORD|GM|PSA|FIAT|PORSCHE|DEXOS|CHRYSLER|JLR|VOLVO|RENAULT|OPEL|HYUNDAI)/i.test(n)) return 15;
  if (/^ACEA/.test(n)) return 8;
  if (/GF/.test(n) || /ILSAC/.test(n)) return 8;
  if (/^API/.test(n) || API_GAS.includes(n) || API_DSL.includes(n)) return 6;
  return 5;
}

/** Является ли допуск OEM-специфичным */
function isOem(raw) {
  return specWeight(raw) === 15;
}

/* ══════════════════════════════════════════════════════════════
   MATCHOIL — основная функция подбора
   ══════════════════════════════════════════════════════════════ */
function matchOil({ specs = [], volume = null, viscosity = null, prefs = {}, limit = 6 } = {}) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));
  } catch (e) {
    console.error("[oils] catalog not found:", e.message);
    return [];
  }

  const reqSpecs  = specs.map(norm).filter(Boolean);
  const hasReqOem = reqSpecs.some(isOem);
  const target    = pickCanisterVolume(volume);

  // Вязкость
  const clientVisc = prefs?.viscosity ? norm(prefs.viscosity) : null;
  const autoVisc   = viscosity ? norm(viscosity) : null;
  const workVisc   = clientVisc || autoVisc;

  const prefBrand = prefs?.brand ? prefs.brand.toUpperCase().trim() : null;

  console.log(`[matchOil] specs=[${reqSpecs.join(",")}] visc=${workVisc} vol=${volume}→${target}л limit=${limit}`);

  // ── Скоринг всех товаров ────────────────────────────────
  const scored = [];

  for (const raw of catalog) {
    // Клонируем и применяем override
    const { item, excluded } = applyOverride({ ...raw }, reqSpecs);
    if (excluded) continue;

    // Фильтр вязкости (жёсткий)
    const iv = norm(item.viscosity);
    if (workVisc && iv && iv !== workVisc) continue;

    // Фильтр: только синтетика (по умолчанию)
    const ot = (item.oil_type || "").toLowerCase();
    if (ot.includes("полусинт") || ot.includes("минерал") || ot === "п/синт" || ot === "п/синтетическое") {
      if (!(prefs?.oilType && !prefs.oilType.toLowerCase().includes("синт"))) continue;
    }

    // Фильтр объёма: целевой ± 0.5л
    if (item.volume == null || item.volume < 2) continue;
    if (Math.abs(item.volume - target) > 0.5) continue;

    // ── СКОРИНГ ─────────────────────────────────────────
    let score = 0;

    // Бонус за совпадение вязкости
    if (workVisc && iv === workVisc) score += 30;

    // Матчинг допусков
    const itemSpecs = (item.all_specs || []).map(norm);
    let matchCount = 0;
    let oemMatch   = 0;
    let specScore  = 0;

    for (const req of reqSpecs) {
      let bestC = 0;
      for (const cand of itemSpecs) {
        bestC = Math.max(bestC, specCompat(req, cand));
      }
      if (bestC > 0) {
        matchCount++;
        if (isOem(req)) oemMatch++;
        specScore += bestC * specWeight(req);
      }
    }

    score += specScore;

    // ─────────────────────────────────────────────────────
    // ФИЛЬТРАЦИЯ ПО ДОПУСКАМ
    // ─────────────────────────────────────────────────────
    // Если есть требуемые OEM-допуски и товар не совпал НИ
    // по одному допуску ВООБЩЕ (даже generic) — отсеиваем.
    // Но если совпали хотя бы generic (API/ACEA/ILSAC) —
    // оставляем, просто со штрафом за отсутствие OEM.
    // ─────────────────────────────────────────────────────
    if (reqSpecs.length > 0 && matchCount === 0) {
      continue; // ноль совпадений — отсев
    }

    // Штраф если есть OEM-требования, но OEM не совпали
    if (hasReqOem && oemMatch === 0) {
      score -= 100;
    }

    // Бонус за полноту совпадений
    if (matchCount > 0 && reqSpecs.length > 0) {
      score += (matchCount / reqSpecs.length) * 50;
    }

    // Бонус за OEM-совпадения
    score += oemMatch * 30;

    // Точный объём канистры
    if (item.volume === target) score += 15;

    // ── БРЕНД-БОНУСЫ (только после прохождения фильтров) ──
    const ib = (item.brand || "").toUpperCase().trim();

    if (prefBrand && ib === prefBrand) score += 200;

    if (TOP_BRANDS.includes(ib)) {
      score += 60 - TOP_BRANDS.indexOf(ib) * 10; // AREOL=60, COMMA=50, ZIC=40
    } else if (MID_BRANDS.includes(ib)) {
      score += 25 - MID_BRANDS.indexOf(ib) * 5;  // LUKOIL=25, SINTEC=20
    }

    // Небольшая поправка на цену (дешевле = чуть лучше)
    score -= (item.price || 0) / 50000;

    scored.push({
      ...item,
      _score:     Math.round(score * 100) / 100,
      _matchCnt:  matchCount,
      _oemMatch:  oemMatch,
      _specScore: specScore,
    });
  }

  // Сортируем по score desc
  scored.sort((a, b) => b._score - a._score);

  console.log(`[matchOil] ${scored.length} candidates after filtering`);

  // ── Витрина: 1 бренд = 1 карточка, каскад по приоритету ──
  const result     = [];
  const usedBrands = new Set();

  function pickFromTier(brands) {
    for (const item of scored) {
      if (result.length >= limit) return;
      const b = (item.brand || "").toUpperCase().trim();
      if (usedBrands.has(b)) continue;
      if (brands && !brands.includes(b)) continue;
      result.push(item);
      usedBrands.add(b);
    }
  }

  // Клиент выбрал бренд — он первый
  if (prefBrand) {
    const pref = scored.find(i => (i.brand || "").toUpperCase().trim() === prefBrand);
    if (pref) { result.push(pref); usedBrands.add(prefBrand); }
  }

  // 1) Топ-бренды
  pickFromTier(TOP_BRANDS);
  // 2) Средние
  pickFromTier(MID_BRANDS);
  // 3) Все остальные
  pickFromTier(null);

  // Если ещё не хватает — добираем любые (даже повторы бренда)
  if (result.length < limit) {
    for (const item of scored) {
      if (result.length >= limit) break;
      if (!result.find(r => r.article === item.article)) {
        result.push(item);
      }
    }
  }

  console.log(`[matchOil] final ${result.length}: ${result.map(r =>
    `${r.brand} ${r.article} score=${r._score} match=${r._matchCnt}/${reqSpecs.length} oem=${r._oemMatch}`
  ).join(" | ")}`);

  // Формируем ответ
  return result.map(item => {
    let warning = null;
    if (clientVisc && autoVisc && clientVisc !== autoVisc) {
      warning = "вязкость не рекомендована производителем";
    }
    if (hasReqOem && item._oemMatch === 0) {
      warning = "требует перепроверки допусков";
    }
    return formatResult(item, warning);
  });
}

/* ══════════════════════════════════════════════════════════════
   ФОРМАТИРОВАНИЕ
   ══════════════════════════════════════════════════════════════ */
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
    _score:     item._score,
    _matchCnt:  item._matchCnt,
    _oemMatch:  item._oemMatch,
  };
}

/* ══════════════════════════════════════════════════════════════
   НОРМАЛИЗАЦИЯ КАТАЛОГА XLSX → JSON
   ══════════════════════════════════════════════════════════════ */
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
  const viscosity = clean(cells["\\"]);
  const api       = splitSpecs(cells["V"]);
  const ilsac     = splitSpecs(cells["W"]);
  const acea      = splitSpecs(cells["X"]);
  const oem       = splitSpecs(
    [cells["Y"], cells["Z"], cells["["], cells["^"]].join(";")
  );
  const allSpecs  = [...api, ...ilsac, ...acea, ...oem];

  return {
    brand, article,
    sku:         clean(cells["D"]),
    description: clean(cells["C"]),
    price:       parseFloat(cells["G"]) || 0,
    stock, volume, viscosity,
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
    const ts = sis[i].getElementsByTagName("t");
    let text = "";
    for (let j = 0; j < ts.length; j++) text += ts[j].textContent || "";
    result.push(text);
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