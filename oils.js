"use strict";
const fs   = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");

const CATALOG_PATH    = path.join(__dirname, "oil-catalog.json");
const OVERRIDE_PATH   = path.join(__dirname, "override.json");
const AC_CATALOG_PATH = path.join(__dirname, "areol-comma-specs.json");

/* ══════════════════════════════════════════════════════════════
   БРЕНДЫ
   ══════════════════════════════════════════════════════════════ */
const TOP_BRANDS = ["AREOL", "COMMA", "ZIC"];
const MID_BRANDS = ["LUKOIL", "SINTEC"];

/* ══════════════════════════════════════════════════════════════
   ИЕРАРХИИ
   ══════════════════════════════════════════════════════════════ */
const API_GAS = ["SA","SB","SC","SD","SE","SF","SG","SH","SJ","SL","SM","SN","SP","SQ"];
const API_DSL = ["CA","CB","CC","CD","CE","CF","CF2","CG4","CH4","CI4","CJ4","CK4","FA4"];
const ILSAC   = ["GF-1","GF-2","GF-3","GF-4","GF-5","GF-6A","GF-6B","GF-7A"];
const ACEA_A  = ["A1","A3","A5","A7"];
const ACEA_B  = ["B1","B3","B4","B5","B7"];
const ACEA_C  = ["C1","C2","C3","C4","C5","C6"];

/* ══════════════════════════════════════════════════════════════
   НОРМАЛИЗАЦИЯ
   ══════════════════════════════════════════════════════════════ */
function norm(s)  { return (s || "").trim().toUpperCase().replace(/[\s\-_.]/g, ""); }
function clean(v) { return (v || "").trim(); }
function splitSpecs(raw) {
  if (!raw) return [];
  return raw.split(";").map(s => s.trim()).filter(Boolean);
}
function isViscosity(s) { return /^\d+W\d+$/i.test(norm(s)); }

/* ══════════════════════════════════════════════════════════════
   ENRICH — ищем допуски в description через regex
   ══════════════════════════════════════════════════════════════ */
const OEM_PATTERNS = [
  { rx: /RN\s*0700/i,              spec: "RN0700" },
  { rx: /RN\s*0710/i,              spec: "RN0710" },
  { rx: /RN\s*0720/i,              spec: "RN0720" },
  { rx: /VW\s*502[\s.]*00/i,       spec: "VW502.00" },
  { rx: /VW\s*504[\s.]*00/i,       spec: "VW504.00" },
  { rx: /VW\s*505[\s.]*00/i,       spec: "VW505.00" },
  { rx: /VW\s*505[\s.]*01/i,       spec: "VW505.01" },
  { rx: /VW\s*507[\s.]*00/i,       spec: "VW507.00" },
  { rx: /MB\s*229[\s.]*3\b/i,      spec: "MB229.3" },
  { rx: /MB\s*229[\s.]*5\b/i,      spec: "MB229.5" },
  { rx: /MB\s*229[\s.]*31/i,       spec: "MB229.31" },
  { rx: /MB\s*229[\s.]*51/i,       spec: "MB229.51" },
  { rx: /MB\s*229[\s.]*52/i,       spec: "MB229.52" },
  { rx: /MB\s*226[\s.]*5/i,        spec: "MB226.5" },
  { rx: /BMW\s*LL[\s-]*01\b/i,     spec: "BMWLL-01" },
  { rx: /BMW\s*LL[\s-]*04\b/i,     spec: "BMWLL-04" },
  { rx: /Dexos\s*1/i,              spec: "GMDEXOS1" },
  { rx: /Dexos\s*2/i,              spec: "GMDEXOS2" },
  { rx: /WSS[\s-]*M2C[\s-]*913/i,  spec: "FORDWSS-M2C913" },
  { rx: /WSS[\s-]*M2C[\s-]*917/i,  spec: "FORDWSS-M2C917" },
  { rx: /WSS[\s-]*M2C[\s-]*946/i,  spec: "FORDWSS-M2C946" },
  { rx: /PSA\s*B71\s*2290/i,       spec: "PSAB712290" },
  { rx: /GF[\s-]*6A?\b/i,          spec: "ILSACGF-6A" },
  { rx: /GF[\s-]*5\b/i,            spec: "ILSACGF-5" },
];

function enrichFromDescription(item) {
  const text = [item.description || "", ...(item.oem || [])].join(" ");
  const existing = new Set((item.all_specs || []).map(norm));
  const enriched = [...(item.all_specs || [])];
  for (const p of OEM_PATTERNS) {
    if (p.rx.test(text) && !existing.has(norm(p.spec))) {
      enriched.push(p.spec);
      existing.add(norm(p.spec));
    }
  }
  return enriched;
}

/* ══════════════════════════════════════════════════════════════
   OVERRIDE — поиск по articles_match (подстрока в артикуле)
   ══════════════════════════════════════════════════════════════ */
let _ovr = null;
let _ovrIndex = null; // article_norm → override entry

function loadOverrides() {
  if (_ovr !== null) return _ovr;
  try {
    _ovr = fs.existsSync(OVERRIDE_PATH)
      ? JSON.parse(fs.readFileSync(OVERRIDE_PATH, "utf-8"))
      : {};
  } catch (e) {
    console.error("[oils] override error:", e.message);
    _ovr = {};
  }

  // Строим индекс: norm(article) → ovr entry
  _ovrIndex = {};
  for (const [key, val] of Object.entries(_ovr)) {
    if (key === "_comment" || !val.articles_match) continue;
    for (const art of val.articles_match) {
      _ovrIndex[norm(art)] = val;
    }
  }

  const n = Object.keys(_ovrIndex).length;
  if (n) console.log(`[oils] override index: ${n} articles mapped`);
  return _ovr;
}

function findOverride(article) {
  loadOverrides();
  if (!_ovrIndex) return null;

  const na = norm(article);

  // Точное совпадение
  if (_ovrIndex[na]) return _ovrIndex[na];

  // Поиск: артикул товара СОДЕРЖИТ ключ из индекса, или наоборот
  for (const [key, val] of Object.entries(_ovrIndex)) {
    if (na.includes(key) || key.includes(na)) return val;
  }

  return null;
}

/**
 * Применяет override к товару. Возвращает { specs, excluded }.
 */
function applyOverride(article, existingSpecs, requiredSpecs) {
  const ovr = findOverride(article);
  if (!ovr) return { addSpecs: [], excluded: false };

  // Проверяем oem_exclude_for
  if (ovr.oem_exclude_for && ovr.oem_exclude_for.length && requiredSpecs.length) {
    const excSet = new Set(ovr.oem_exclude_for.map(norm));
    for (const req of requiredSpecs) {
      if (excSet.has(norm(req))) {
        return { addSpecs: [], excluded: true };
      }
    }
  }

  // Добавляем oem_add
  const existing = new Set(existingSpecs.map(norm));
  const fresh = (ovr.oem_add || []).filter(s => !existing.has(norm(s)));
  return { addSpecs: fresh, excluded: false };
}

/* ══════════════════════════════════════════════════════════════
   ОБЪЁМ
   ══════════════════════════════════════════════════════════════ */
function pickCanisterVolume(fillVol) {
  if (!fillVol) return 4;
  return fillVol > 4.3 ? 5 : 4;
}

/* ══════════════════════════════════════════════════════════════
   SPEC COMPAT
   ══════════════════════════════════════════════════════════════ */
function hierarchyMatch(r, c, list) {
  const ri = list.indexOf(r), ci = list.indexOf(c);
  if (ri < 0 || ci < 0) return 0;
  if (ci === ri) return 10;
  if (ci > ri) return 8;
  return 0;
}

function specCompat(reqRaw, candRaw) {
  const r = norm(reqRaw), c = norm(candRaw);
  if (r === c) return 10;

  // Частичное OEM (FORDWSSM2C913 ⊂ FORDWSSM2C913C)
  if (r.length > 4 && c.length > 4) {
    if (c.startsWith(r) || r.startsWith(c)) return 9;
  }

  // API
  const rParts = r.replace(/^API/, "").split("/");
  const cParts = c.replace(/^API/, "").split("/");
  let best = 0;
  for (const rp of rParts) {
    for (const cp of cParts) {
      if (rp === cp) { best = Math.max(best, 10); continue; }
      best = Math.max(best, hierarchyMatch(rp, cp, API_GAS));
      best = Math.max(best, hierarchyMatch(rp, cp, API_DSL));
    }
  }
  if (best > 0) return best;

  // ILSAC
  const ilsac = s => { const m = s.match(/(GF\d[AB]?)/i); return m ? "GF-" + m[1].replace(/^GF-?/i,"") : null; };
  const rI = ilsac(r), cI = ilsac(c);
  if (rI && cI) return hierarchyMatch(rI, cI, ILSAC);

  // ACEA
  const acea = s => (s.replace(/^ACEA/,"").match(/[A-C]\d/g)) || [];
  const rA = acea(r), cA = acea(c);
  if (rA.length && cA.length) {
    let matches = 0;
    for (const rp of rA) {
      for (const cp of cA) {
        if (rp === cp) { matches++; break; }
        if (rp[0] === cp[0]) {
          const list = rp[0]==="A"?ACEA_A:rp[0]==="B"?ACEA_B:ACEA_C;
          if (hierarchyMatch(rp, cp, list) > 0) { matches++; break; }
        }
      }
    }
    if (matches > 0) return Math.round((matches / rA.length) * 10);
  }

  return 0;
}

function isOem(raw) {
  const n = norm(raw);
  return /^(VW|MB|RN|BMW|FORD|GM|PSA|FIAT|PORSCHE|DEXOS|CHRYSLER|JLR|VOLVO|RENAULT|OPEL|HYUNDAI|TOYOTA|NISSAN)/i.test(n);
}

function specWeight(raw) {
  if (isOem(raw)) return 15;
  const n = norm(raw);
  if (/^ACEA/.test(n)) return 8;
  if (/GF/.test(n) || /ILSAC/.test(n)) return 8;
  if (/^API/.test(n) || API_GAS.includes(n) || API_DSL.includes(n)) return 6;
  return 5;
}

/* ══════════════════════════════════════════════════════════════
   MATCHOIL v4 — гарантия AREOL + COMMA + прочий бренд
   Принимает specs (из каталога) и aiSpecs (из ИИ) раздельно,
   объединяет их с весовыми коэффициентами.
   ══════════════════════════════════════════════════════════════ */

/**
 * Объединяет два массива допусков. sourceSpecs имеют вес 1.5×,
 * aiSpecs — 1× (если уже есть в source, не дублируются).
 */
function mergeSpecsWeighted(sourceSpecs, aiSpecs) {
  const srcNorm = new Set(sourceSpecs.map(norm));
  const merged = [...sourceSpecs];
  for (const s of aiSpecs) {
    if (s && !isViscosity(s) && !srcNorm.has(norm(s))) {
      merged.push(s);
    }
  }
  return merged;
}

/**
 * Загружает AREOL+COMMA каталог (с ручными допусками из xlsx).
 */
let _acCatalog = null;
function loadAreolCommaCatalog() {
  if (_acCatalog) return _acCatalog;
  try {
    _acCatalog = JSON.parse(fs.readFileSync(AC_CATALOG_PATH, "utf-8"));
    console.log(`[oils] areol-comma catalog: ${_acCatalog.length} items`);
  } catch (e) {
    console.warn("[oils] areol-comma-specs.json not found, falling back to main catalog");
    _acCatalog = [];
  }
  return _acCatalog;
}

/**
 * Скоринг одного товара против набора требуемых допусков.
 * Возвращает { score, matchCount, oemMatch }.
 */
function scoreItem(raw, reqSpecs, hasReqOem, workVisc, target, allSpecsArr) {
  const itemSpecs  = allSpecsArr.map(norm);
  const iv         = norm(raw.viscosity);

  // Жёсткие фильтры
  if (workVisc && iv && iv !== workVisc) return null;
  const ot = (raw.oil_type || "").toLowerCase();
  if (ot.includes("полусинт") || ot.includes("минерал")) return null;
  if (raw.volume == null || raw.volume < 2) return null;
  // Допуск ±1.5л: 4L и 5L обе подходят для любого fill_volume ≤ 4.3л
  if (target && Math.abs(raw.volume - target) > 1.5) return null;

  let score = 0;
  if (workVisc && iv === workVisc) score += 30;

  let matchCount = 0, oemMatch = 0, specScore = 0;
  for (const req of reqSpecs) {
    let bestC = 0;
    for (const cand of itemSpecs) bestC = Math.max(bestC, specCompat(req, cand));
    if (bestC > 0) {
      matchCount++;
      if (isOem(req)) oemMatch++;
      specScore += bestC * specWeight(req);
    }
  }

  if (reqSpecs.length > 0 && matchCount === 0) return null;
  if (hasReqOem && oemMatch === 0) score -= 100;

  score += specScore;
  if (matchCount > 0 && reqSpecs.length > 0) score += (matchCount / reqSpecs.length) * 50;
  score += oemMatch * 30;
  if (raw.volume === target) score += 15;
  score -= (raw.price || 0) / 50000;

  return { score: Math.round(score * 100) / 100, matchCount, oemMatch };
}

/**
 * Главная функция подбора масла.
 * Всегда возвращает ровно 3 позиции: 1 AREOL + 1 COMMA + 1 прочий бренд.
 *
 * @param {string[]} specs     — допуски из каталога (источник, вес 1.5×)
 * @param {string[]} aiSpecs   — допуски по данным ИИ (вес 1×)
 * @param {number|null} volume — объём заливки
 * @param {string|null} viscosity — рекомендованная вязкость
 * @param {object} prefs       — { viscosity?, brand? } — пользовательские предпочтения
 */
function matchOil({ specs = [], aiSpecs = [], volume = null, viscosity = null, prefs = {} } = {}) {
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8")); }
  catch (e) { console.error("[oils] catalog not found:", e.message); return []; }

  const acCatalog = loadAreolCommaCatalog();

  // ── Объединяем допуски из двух источников ──────────────────────────────────
  const sourceFilt = specs.filter(s => s && !isViscosity(s));
  const aiFilt     = aiSpecs.filter(s => s && !isViscosity(s));
  const reqSpecs   = mergeSpecsWeighted(sourceFilt, aiFilt).map(norm);
  const hasReqOem  = reqSpecs.some(isOem);
  const target     = pickCanisterVolume(volume);

  const clientVisc = prefs?.viscosity ? norm(prefs.viscosity) : null;
  const autoVisc   = viscosity ? norm(viscosity) : null;
  const workVisc   = clientVisc || autoVisc;
  const prefBrand  = prefs?.brand ? prefs.brand.toUpperCase().trim() : null;

  console.log(`[matchOil] reqSpecs=[${reqSpecs.join(",")}] aiSpecs=[${aiFilt.map(norm).join(",")}] visc=${workVisc} vol=${volume}→${target}л`);

  // ── Функция скоринга пула товаров ──────────────────────────────────────────
  function scoreCatalog(pool, useOverride) {
    const result = [];
    for (const raw of pool) {
      let allSpecs = enrichFromDescription(raw);
      if (useOverride) {
        const { addSpecs, excluded } = applyOverride(raw.article, allSpecs, reqSpecs);
        if (excluded) continue;
        if (addSpecs.length) allSpecs = [...allSpecs, ...addSpecs];
      }
      const s = scoreItem(raw, reqSpecs, hasReqOem, workVisc, target, allSpecs);
      if (!s) continue;
      result.push({ ...raw, all_specs: allSpecs, _score: s.score, _matchCnt: s.matchCount, _oemMatch: s.oemMatch });
    }
    result.sort((a, b) => b._score - a._score);
    return result;
  }

  // ── Подбираем AREOL/COMMA из специального каталога ───────────────────────
  // useOverride: true — чтобы override.json добавлял RN0700/RN0710 и исключал
  // неподходящие масла (oem_exclude_for)
  const areolPool = acCatalog.filter(i => i.brand === "AREOL" && (i.stock || 0) > 0);
  const commaPool = acCatalog.filter(i => i.brand === "COMMA" && (i.stock || 0) > 0);

  const areolScored = scoreCatalog(areolPool, true);
  const commaScored = scoreCatalog(commaPool, true);

  // ── Прочие бренды из основного каталога ───────────────────────────────────
  const otherPool = catalog.filter(i => {
    const b = (i.brand || "").toUpperCase().trim();
    return b !== "AREOL" && b !== "COMMA" && (i.stock || 0) > 0;
  });
  const otherScored = scoreCatalog(otherPool, true);

  // ── Если пользователь выбрал бренд — приоритизировать его ─────────────────
  let prefSlot = null;
  if (prefBrand && prefBrand !== "AREOL" && prefBrand !== "COMMA") {
    prefSlot = otherScored.find(i => (i.brand||"").toUpperCase() === prefBrand) || null;
  }

  // ── Финальная витрина ─────────────────────────────────────────────────────
  // Слот 1: лучший AREOL (или предпочтительный, если пользователь выбрал AREOL)
  const bestAreol = prefBrand === "AREOL"
    ? (areolScored.find(i => i._score > 0) || areolScored[0])
    : areolScored[0];

  // Слот 2: лучший COMMA
  const bestComma = prefBrand === "COMMA"
    ? (commaScored.find(i => i._score > 0) || commaScored[0])
    : commaScored[0];

  // Слот 3: лучший прочий бренд (приоритет предпочтению пользователя)
  const usedArticles = new Set([bestAreol?.article, bestComma?.article]);
  const bestOther = prefSlot ||
    otherScored.find(i => !usedArticles.has(i.article));

  const finalRaw = [bestAreol, bestComma, bestOther].filter(Boolean);

  console.log(`[matchOil] FINAL: ${finalRaw.map(r =>
    `${r.brand} ${r.article} s=${r._score} m=${r._matchCnt}/${reqSpecs.length} oem=${r._oemMatch}`
  ).join(" | ")}`);

  return finalRaw.map(item => {
    let warning = null;
    if (clientVisc && autoVisc && clientVisc !== autoVisc)
      warning = "вязкость не рекомендована производителем";
    if (hasReqOem && item._oemMatch === 0)
      warning = "требует перепроверки допусков";
    return formatResult(item, warning);
  });
}

function formatResult(item, warning = null) {
  return {
    article: item.article, sku: item.sku, brand: item.brand,
    description: item.description, price: item.price, stock: item.stock,
    volume: item.volume, viscosity: item.viscosity, oil_type: item.oil_type,
    warning,
    specs: { api: item.api, ilsac: item.ilsac, acea: item.acea, oem: item.oem },
    _score: item._score, _matchCnt: item._matchCnt, _oemMatch: item._oemMatch,
  };
}

/* ══════════════════════════════════════════════════════════════
   XLSX → JSON
   ══════════════════════════════════════════════════════════════ */
async function normalizeOilCatalog(xlsxPath = path.join(__dirname, "main.xlsx")) {
  console.log("[oils] reading", xlsxPath);
  const buf = fs.readFileSync(xlsxPath);
  const zip = await JSZip.loadAsync(buf);
  const ssXml = await zip.file("xl/sharedStrings.xml").async("string");
  const strings = parseSharedStrings(ssXml);
  const shXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
  const rows = parseSheet(shXml, strings);
  const catalog = rows.map(normalizeRow).filter(r => r !== null);
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), "utf-8");
  console.log(`[oils] normalized ${catalog.length} items → ${CATALOG_PATH}`);
  return catalog;
}

function normalizeRow(cells) {
  const brand = clean(cells["A"]), article = clean(cells["B"]);
  const stock = parseInt(cells["F"]) || 0;
  if (!article || stock <= 0) return null;
  const api = splitSpecs(cells["V"]), ilsac = splitSpecs(cells["W"]),
        acea = splitSpecs(cells["X"]),
        oem = splitSpecs([cells["Y"],cells["Z"],cells["["],cells["^"]].join(";"));
  return {
    brand, article, sku: clean(cells["D"]), description: clean(cells["C"]),
    price: parseFloat(cells["G"]) || 0, stock,
    volume: parseFloat(clean(cells["K"])) || null,
    viscosity: clean(cells["\\"]),
    oil_type: clean(cells["U"]),
    api, ilsac, acea, oem,
    all_specs: [...api, ...ilsac, ...acea, ...oem],
  };
}

function parseSharedStrings(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const sis = doc.getElementsByTagName("si");
  const r = [];
  for (let i = 0; i < sis.length; i++) {
    const ts = sis[i].getElementsByTagName("t");
    let t = "";
    for (let j = 0; j < ts.length; j++) t += ts[j].textContent || "";
    r.push(t);
  }
  return r;
}

function parseSheet(xml, strings) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const rowEls = doc.getElementsByTagName("row");
  const rows = [];
  for (let i = 0; i < rowEls.length; i++) {
    const cells = {};
    const cs = rowEls[i].getElementsByTagName("c");
    for (let j = 0; j < cs.length; j++) {
      const c = cs[j], col = c.getAttribute("r").replace(/[0-9]/g, "");
      const t = c.getAttribute("t"), vEl = c.getElementsByTagName("v")[0];
      cells[col] = vEl ? (t === "s" ? (strings[parseInt(vEl.textContent.trim())] ?? "") : (vEl.textContent || "")) : "";
    }
    rows.push(cells);
  }
  return rows;
}

module.exports = { normalizeOilCatalog, matchOil };