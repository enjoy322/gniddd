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
   MATCHOIL v3 FINAL
   ══════════════════════════════════════════════════════════════ */
function matchOil({ specs = [], volume = null, viscosity = null, prefs = {}, limit = 6 } = {}) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));
  } catch (e) {
    console.error("[oils] catalog not found:", e.message);
    return [];
  }

  // Фильтруем вязкости из specs!
  const reqSpecs  = specs.map(s => s.trim()).filter(s => s && !isViscosity(s)).map(norm);
  const hasReqOem = reqSpecs.some(isOem);
  const target    = pickCanisterVolume(volume);

  const clientVisc = prefs?.viscosity ? norm(prefs.viscosity) : null;
  const autoVisc   = viscosity ? norm(viscosity) : null;
  const workVisc   = clientVisc || autoVisc;
  const prefBrand  = prefs?.brand ? prefs.brand.toUpperCase().trim() : null;

  console.log(`[matchOil] reqSpecs=[${reqSpecs.join(",")}] visc=${workVisc} vol=${volume}→${target}л hasOem=${hasReqOem}`);

  const scored = [];

  for (const raw of catalog) {
    // 1) Enrich from description
    let allSpecs = enrichFromDescription(raw);

    // 2) Override — добавляем OEM + проверяем exclude
    const { addSpecs, excluded } = applyOverride(raw.article, allSpecs, reqSpecs);
    if (excluded) continue;
    if (addSpecs.length) allSpecs = [...allSpecs, ...addSpecs];

    // 3) Фильтр вязкости
    const iv = norm(raw.viscosity);
    if (workVisc && iv && iv !== workVisc) continue;

    // 4) Фильтр синтетика
    const ot = (raw.oil_type || "").toLowerCase();
    if (ot.includes("полусинт") || ot.includes("минерал") || ot === "п/синт" || ot === "п/синтетическое") {
      if (!(prefs?.oilType && !prefs.oilType.toLowerCase().includes("синт"))) continue;
    }

    // 5) Фильтр объёма
    if (raw.volume == null || raw.volume < 2) continue;
    if (Math.abs(raw.volume - target) > 0.5) continue;

    // ── СКОРИНГ ──
    let score = 0;
    if (workVisc && iv === workVisc) score += 30;

    const itemSpecs = allSpecs.map(norm);
    let matchCount = 0, oemMatch = 0, specScore = 0;

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

    // Ноль совпадений при наличии требований → отсев
    if (reqSpecs.length > 0 && matchCount === 0) continue;

    // Штраф за отсутствие OEM
    if (hasReqOem && oemMatch === 0) score -= 100;

    // Бонусы
    if (matchCount > 0 && reqSpecs.length > 0) {
      score += (matchCount / reqSpecs.length) * 50;
    }
    score += oemMatch * 30;
    if (raw.volume === target) score += 15;

    // Бренд
    const ib = (raw.brand || "").toUpperCase().trim();
    if (prefBrand && ib === prefBrand) score += 200;
    if (TOP_BRANDS.includes(ib))      score += 60 - TOP_BRANDS.indexOf(ib) * 10;
    else if (MID_BRANDS.includes(ib)) score += 25 - MID_BRANDS.indexOf(ib) * 5;

    score -= (raw.price || 0) / 50000;

    scored.push({
      ...raw,
      all_specs: allSpecs,
      _score:     Math.round(score * 100) / 100,
      _matchCnt:  matchCount,
      _oemMatch:  oemMatch,
    });
  }

  scored.sort((a, b) => b._score - a._score);

  console.log(`[matchOil] ${scored.length} candidates (top5: ${scored.slice(0,5).map(r =>
    `${r.brand}/${r.article} s=${r._score} m=${r._matchCnt} oem=${r._oemMatch}`).join(", ")})`);

  // ── Витрина: 1 бренд = 1 карточка, каскад ──
  const result = [], usedBrands = new Set();

  function pick(brands) {
    for (const item of scored) {
      if (result.length >= limit) return;
      const b = (item.brand || "").toUpperCase().trim();
      if (usedBrands.has(b)) continue;
      if (brands && !brands.includes(b)) continue;
      result.push(item);
      usedBrands.add(b);
    }
  }

  if (prefBrand) {
    const p = scored.find(i => (i.brand||"").toUpperCase().trim() === prefBrand);
    if (p) { result.push(p); usedBrands.add(prefBrand); }
  }

  pick(TOP_BRANDS);
  pick(MID_BRANDS);
  pick(null);

  if (result.length < limit) {
    for (const item of scored) {
      if (result.length >= limit) break;
      if (!result.find(r => r.article === item.article)) result.push(item);
    }
  }

  console.log(`[matchOil] FINAL ${result.length}: ${result.map(r =>
    `${r.brand} ${r.article} s=${r._score} m=${r._matchCnt}/${reqSpecs.length} oem=${r._oemMatch}`
  ).join(" | ")}`);

  return result.map(item => {
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