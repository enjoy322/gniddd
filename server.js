"use strict";
const express = require("express");
const multer  = require("multer");
const fs      = require("fs");
const path    = require("path");
const axios   = require("axios");
const https   = require("https");

const { parseEngineBlocks, findEngineBlock } = require("./utils/parseOil");
const { extractVIN, normalizeVIN }           = require("./utils/ocr");
const { buildRecommendationsWithCheck, resolveUrl, fallbackFromPage, fallbackGlobal } = require("./utils/oilLogic");
const { findFilters }                        = require("./utils/parseFilters");
const { getOriginalFilters }                 = require("./utils/getFilters");

const app = express();

// CORS для браузерного расширения
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static("public"));

const upload     = multer({ dest: "uploads/" });
const uploadXfer = multer({ dest: "uploads/xfer/", limits: { fileSize: 200 * 1024 * 1024 } });

// Создаём папку xfer если нет
if (!fs.existsSync("uploads/xfer")) fs.mkdirSync("uploads/xfer", { recursive: true });
const sessions = {};

const UPEC_TOKEN = "32e33ef47960cdf8b9503c2cd241d20e2893b17623b3c916e829620bcfdf177d";
const UPEC_URL   = "https://podbor.upec.pro/api/v1/public/find-car";
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function saveVIN(session, vin) {
  session.vin = vin;
  if (!session.history.includes(vin)) session.history.unshift(vin);
}

// Маркетинговое обозначение объёма — отличается от технического округления API
// (напр. D4F: 1149cc → API даёт 1.1, но Renault маркетинг — 1.2)
const ENGINE_VOLUME_MARKETING = {
  "D4F": 1.2, "D7F": 1.2,   // Renault 1149cc → 1.2
};

function normalizeCar(data) {
  const code = data.engine_code || "";
  const rawVol = parseFloat((data.engine_volume || "").replace(",", ".")) || null;
  const volume = ENGINE_VOLUME_MARKETING[code.toUpperCase()] ?? rawVol;
  return {
    brand: data.brand, model: data.model, generation: data.generation,
    year: data.year_manufactured,
    engine: { code, volume, type: data.engine_type },
    transmission: data.transmission, drive: data.drive, power_hp: parseInt(data.power)
  };
}

// Глобальный кэш: vin → { brand, model, year } (переживает смену сессии)
const vinInfoCache = {};

function cleanupFile(p) { try { fs.unlinkSync(p); } catch (_) {} }

function makeBreadcrumb(car) {
  const parts = [car.brand, car.model, car.year];
  if (car.engine?.volume) parts.push(car.engine.volume + "л");
  if (car.engine?.code)   parts.push(car.engine.code);
  return parts.filter(Boolean).join(" → ");
}

class CarNotFoundError extends Error {
  constructor(vin) { super(`Car not found for VIN: ${vin}`); this.name = "CarNotFoundError"; }
}

async function fetchCarInfo(vin) {
  const response = await axios.get(UPEC_URL, {
    params: { vin, token: UPEC_TOKEN, transportType: "CAR", source: "vin" },
    headers: { "User-Agent": "Mozilla/5.0" }, httpsAgent,
    validateStatus: s => s < 500
  });
  if (response.status !== 200 || !response.data?.brand) throw new CarNotFoundError(vin);
  return normalizeCar(response.data);
}

// ── ROUTES ──

app.get("/new-session", (req, res) => {
  const id = Math.random().toString(36).substring(2, 8).toUpperCase();
  sessions[id] = { vin: null, history: [] };
  console.log(`[session] created: ${id}`);
  res.json({ session_id: id });
});

app.get("/data/:id", (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: "session not found" });
  res.json(s);
});

app.post("/manual/:id", async (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: "session not found" });
  const raw = (req.body.vin || "").trim();

  // Сначала пробуем как VIN (17 символов)
  const vin = normalizeVIN(raw);
  if (vin && vin.length === 17) {
    saveVIN(s, vin);
    console.log(`[manual] session=${req.params.id} vin=${vin}`);
    return res.json({ vin });
  }

  // Иначе пробуем как госномер
  const regnumber = raw.toUpperCase().replace(/\s/g, "")
    .replace(/А/g,"A").replace(/В/g,"B").replace(/Е/g,"E").replace(/К/g,"K")
    .replace(/М/g,"M").replace(/Н/g,"H").replace(/О/g,"O").replace(/Р/g,"P")
    .replace(/С/g,"C").replace(/Т/g,"T").replace(/У/g,"Y").replace(/Х/g,"X");

  if (regnumber.length >= 4) {
    try {
      const response = await axios.get(UPEC_URL, {
        params: { regnumber, token: UPEC_TOKEN, transportType: "CAR", source: "plate" },
        headers: { "User-Agent": "Mozilla/5.0" }, httpsAgent,
        validateStatus: st => st < 500
      });
      const foundVin = normalizeVIN(response.data?.vin);
      if (foundVin && foundVin.length === 17) {
        saveVIN(s, foundVin);
        console.log(`[manual] session=${req.params.id} regnumber=${regnumber} vin=${foundVin}`);
        return res.json({ vin: foundVin, regnumber });
      }
      return res.status(404).json({ error: "Автомобиль по госномеру не найден" });
    } catch (e) {
      console.error("[manual] regnumber error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: "invalid VIN or plate number" });
});

app.post("/upload/:id", upload.single("image"), async (req, res) => {
  const s = sessions[req.params.id];
  if (!s)        return res.status(404).json({ error: "session not found" });
  if (!req.file) return res.status(400).json({ error: "no file" });
  console.log(`[upload] session=${req.params.id} file=${req.file.path}`);
  try {
    const vin = await extractVIN(req.file.path);
    console.log(`[upload] final VIN: ${vin}`);
    if (vin) saveVIN(s, vin);
    res.json({ vin: vin || null });
  } catch (e) {
    console.error("[upload] error:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    cleanupFile(req.file.path);
  }
});

app.get("/car-info/:vin", async (req, res) => {
  try {
    res.json(await fetchCarInfo(req.params.vin));
  } catch (e) {
    if (e.name === "CarNotFoundError")
      return res.status(404).json({ error: "not_found", message: "Автомобиль не найден" });
    console.error("[car-info] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/oil/:vin", async (req, res) => {
  try {
    let car;
    try { car = await fetchCarInfo(req.params.vin); }
    catch (e) {
      if (e.name === "CarNotFoundError")
        return res.json({
          car: null, url: null, source: "car_not_found",
          oil: null, oil_gpt: null,
          recommendations: [], filters: null
        });
      throw e;
    }

    const prefs = {};
    if (req.query.viscosity) prefs.viscosity = req.query.viscosity;
    if (req.query.brand)     prefs.brand     = req.query.brand;

    // ── GPT double-check тумблер ──
    // По умолчанию включён (gptCheck !== '0')
    const gptCheckEnabled = req.query.gptCheck !== "0";

    const tree = require("./tree.json");
    console.log(`[oil] ${car.brand} ${car.model} ${car.year} engine=${car.engine.code} gptCheck=${gptCheckEnabled}`);
    vinInfoCache[req.params.vin] = { brand: car.brand, model: car.model, year: car.year };

    const filtersPromise = getOriginalFilters(car);

    // filtersUrl — ссылка на каталог ТО (источник данных — getcat.net)
    const filtersUrl = "https://getcat.net/";

    const url = await resolveUrl(car, tree);

    // ── Нет URL в дереве — только GPT ────────────────────────────────────────
    if (!url) {
      console.log("[oil] no url → gpt only");
      const [gptResult, filters] = await Promise.all([
        fallbackGlobal(car),
        filtersPromise
      ]);

      const gptFillVolume = gptResult?.found ? (gptResult.volume || null) : null;

      const oilGpt = gptResult?.found
        ? { volume: gptFillVolume, oil: { best: gptResult.best || [], alternative: gptResult.alternative || [] } }
        : null;

      const recommendations = await buildRecommendationsWithCheck(
        oilGpt, null, car, prefs, gptFillVolume, gptCheckEnabled
      );

      return res.json({
        car, url: null,
        source: gptResult?.found ? "gpt_global" : "not_found",
        oil: null,
        oil_gpt: oilGpt,
        recommendations,
        filters,
        breadcrumb: makeBreadcrumb(car),
        filtersBreadcrumb: filters?.catalogBreadcrumb || null,
        filtersUrl
      });
    }

    // ── URL найден → парсер + GPT параллельно ────────────────────────────────
    console.log(`[oil] parsing ${url}`);

    const [blocks, gptResult, filters] = await Promise.all([
      parseEngineBlocks(url),
      fallbackGlobal(car),
      filtersPromise
    ]);

    const engine = findEngineBlock(blocks, car);

    const gptFillVolume = gptResult?.found ? (gptResult.volume || null) : null;

    const oilGpt = gptResult?.found
      ? { volume: gptFillVolume, oil: { best: gptResult.best || [], alternative: gptResult.alternative || [] } }
      : null;

    // ── Парсер нашёл двигатель ────────────────────────────────────────────────
    if (engine) {
      const parsedFillVolume = engine.volume || gptFillVolume || null;

      console.log(`[oil] source=parsed, parsedFillVolume=${parsedFillVolume}`);

      const oilParsed = {
        volume: parsedFillVolume,
        oil: { best: engine.oil.best, alternative: engine.oil.alternative }
      };

      const recommendations = await buildRecommendationsWithCheck(
        oilParsed, oilGpt, car, prefs, parsedFillVolume, gptCheckEnabled
      );

      return res.json({
        car, url,
        source: "parsed",
        oil: oilParsed,
        oil_gpt: oilGpt,
        recommendations,
        filters,
        breadcrumb: makeBreadcrumb(car),
        filtersBreadcrumb: filters?.catalogBreadcrumb || null,
        filtersUrl
      });
    }

    // ── Парсер не нашёл → GPT читает HTML страницы ───────────────────────────
    console.log("[oil] engine not found → fallbackFromPage");
    const gptPage = await fallbackFromPage(url, car);

    if (gptPage?.found) {
      const pageFillVolume = gptPage.volume || gptFillVolume || null;
      console.log(`[oil] source=gpt_html, pageFillVolume=${pageFillVolume}`);

      const oilPage = {
        volume: pageFillVolume,
        oil: { best: gptPage.best || [], alternative: gptPage.alternative || [] }
      };

      const recommendations = await buildRecommendationsWithCheck(
        oilPage, oilGpt, car, prefs, pageFillVolume, gptCheckEnabled
      );

      return res.json({
        car, url,
        source: "gpt_html",
        oil: oilPage,
        oil_gpt: oilGpt,
        recommendations,
        filters,
        breadcrumb: makeBreadcrumb(car),
        filtersBreadcrumb: filters?.catalogBreadcrumb || null,
        filtersUrl
      });
    }

    // ── Всё упало → только GPT global ────────────────────────────────────────
    console.log("[oil] source=gpt_global only");

    const recommendations = await buildRecommendationsWithCheck(
      oilGpt, null, car, prefs, gptFillVolume, gptCheckEnabled
    );

    return res.json({
      car, url,
      source: gptResult?.found ? "gpt_global" : "not_found",
      oil: null,
      oil_gpt: oilGpt,
      recommendations,
      filters,
      breadcrumb: makeBreadcrumb(car),
      filtersBreadcrumb: filters?.catalogBreadcrumb || null,
      filtersUrl
    });

  } catch (e) {
    console.error("[oil] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── XFER — передача файлов телефон ↔ ПК ──────────────────────────────────
app.get("/xfer", (req, res) => res.sendFile(__dirname + "/public/xfer.html"));

app.post("/xfer/upload", uploadXfer.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file" });
  const origName = req.file.originalname || "file";
  const safeName = path.basename(origName).replace(/[^a-zA-Z0-9._\-а-яёА-ЯЁ ]/gu, "_");
  const dest = path.join("uploads/xfer", Date.now() + "_" + safeName);
  fs.renameSync(req.file.path, dest);
  console.log(`[xfer] uploaded: ${dest}`);
  res.json({ name: path.basename(dest) });
});

app.get("/xfer/files", (req, res) => {
  const dir = "uploads/xfer";
  const files = fs.readdirSync(dir).map(name => {
    const stat = fs.statSync(path.join(dir, name));
    return { name, size: stat.size, mtime: stat.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});

app.get("/xfer/dl/:name", (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(__dirname, "uploads/xfer", name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not found" });
  res.download(file, name.replace(/^\d+_/, ""));
});

app.delete("/xfer/del/:name", (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(__dirname, "uploads/xfer", name);
  try { fs.unlinkSync(file); } catch (_) {}
  res.json({ ok: true });
});

// ── ARMTEK VIN/PLATE LOOKUP ───────────────────────────────────────────────────
const ARMTEK_VIN_URL      = "https://armtek.ru/rest/ru/laximo-microservice/v1/search/get-data-by-vin-or-plate-number";
const ARMTEK_GUEST_URL    = "https://armtek.ru/rest/ru/auth-microservice/v1/guest";
const ARMTEK_AUTH_SYSTEM  = "AUTH_MICROSERVICE_V1_ARMTEK_RU";
const ARMTEK_AUTH_TOKEN   = "nJhNK87gJOOU6dfr";

// In-memory token state (overridable at runtime via /vin/set-token or /vin/refresh-token)
let armtekState = {
  bearer:  process.env.ARMTEK_TOKEN  ||
    "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MDU3NjQyNjYsImtleSI6IjcxZDY2YWIxMjk4OThhM2RkZWIxYTI1M2VjZGQ5N2Y5IiwidHlwZSI6Imc5WCIsImRhdGEiOnsibG9naW4iOiJHVUVTVF8xNzc0NjYwMjY2MDMyMTUzIiwidXVpZCI6IkdlN2U0ZGZhYmYzMjI4NzA4MDQxNDA2NTM4NjJiYjY4MCIsInV0eXBlIjoiRyIsInVmdW5jdGlvbiI6bnVsbCwiYWNsU2NoZW1lVHlwZSI6IltcImYwOGI3YzdkLTkxMGQtNDE5MC0zMWVhLWYxOGRmNGIzMTBjMlwiXSJ9fQ==.pNo5QPM73TrJ5+B0pZn76ftD79wswVJp9Ns+s742FYo=",
  captcha: process.env.ARMTEK_CAPTCHA || "c92e38c27cc86fc28c04c3b1b6327239",
  updatedAt: null,
};

function parseArmtekResult(data) {
  // Laximo возвращает массив вариантов или объект
  const items = Array.isArray(data?.data) ? data.data
    : data?.data ? [data.data]
    : Array.isArray(data) ? data : [];

  return items.map(v => ({
    vin:          v.vin        || v.Vin        || null,
    plate:        v.plateNum   || v.plate      || null,
    brand:        v.brand      || v.Brand      || v.mark   || null,
    model:        v.model      || v.Model      || null,
    year:         v.year       || v.Year       || v.modelYear || null,
    engine_code:  v.engineCode || v.engine     || null,
    engine_vol:   v.engineCapacity || v.engineVolume || null,
    body:         v.bodyType   || v.body       || null,
    color:        v.color      || null,
    generation:   v.generation || null,
    raw:          v,
  }));
}

app.get("/vin", (req, res) => res.sendFile(__dirname + "/public/vin.html"));

app.get("/vin/lookup", async (req, res) => {
  const q = (req.query.q || req.query.vin || req.query.plate || "").trim().toUpperCase().replace(/\s/g, "");
  if (!q) return res.status(400).json({ error: "q (vin or plate) required" });

  try {
    console.log(`[vin/lookup] q=${q}`);
    const r = await axios.get(ARMTEK_VIN_URL, {
      params: { vin: q },
      headers: {
        "accept":               "application/json, text/plain, */*",
        "accept-language":      "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "authorization":        armtekState.bearer,
        "content-type":         "application/json",
        "x-app-version":        "1.0.12",
        "x-auth-captcha-hash":  armtekState.captcha,
        "x-ca-external-system": "IM_RU",
        "x-ca-vkorg":           "4000",
        "user-agent":           "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        "referer":              `https://armtek.ru/search?text=${encodeURIComponent(q)}`,
      },
      timeout: 12000,
      validateStatus: s => s < 600,
    });

    if (r.status !== 200) {
      console.warn(`[vin/lookup] armtek status=${r.status}`);
      return res.status(r.status).json({ error: `armtek returned ${r.status}`, raw: r.data });
    }

    const parsed = parseArmtekResult(r.data);
    console.log(`[vin/lookup] q=${q} → ${parsed.length} results`);
    res.json({ q, results: parsed, raw: r.data });

  } catch (e) {
    console.error("[vin/lookup] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Автогенерация гостевого токена Armtek
app.post("/vin/refresh-token", async (req, res) => {
  try {
    const r = await axios.post(ARMTEK_GUEST_URL, {}, {
      headers: {
        "X-AUTH-SYSTEM":  ARMTEK_AUTH_SYSTEM,
        "X-AUTH-TOKEN":   ARMTEK_AUTH_TOKEN,
        "content-type":   "application/json",
        "user-agent":     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        "origin":         "https://armtek.ru",
        "referer":        "https://armtek.ru/",
      },
      timeout: 10000,
    });
    const token = r.data?.data?.accessToken;
    if (!token) return res.status(502).json({ error: "no accessToken in response", raw: r.data });
    armtekState.bearer    = `Bearer ${token}`;
    armtekState.updatedAt = new Date().toISOString();
    console.log("[vin/refresh-token] new guest token obtained");
    res.json({ ok: true, bearer: armtekState.bearer, updatedAt: armtekState.updatedAt });
  } catch (e) {
    console.error("[vin/refresh-token] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Ручная установка токена / captcha hash
app.post("/vin/set-token", (req, res) => {
  const { bearer, captcha } = req.body || {};
  if (bearer)  { armtekState.bearer  = bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}`; }
  if (captcha) { armtekState.captcha = captcha; }
  armtekState.updatedAt = new Date().toISOString();
  console.log("[vin/set-token] token updated manually");
  res.json({ ok: true, bearer: armtekState.bearer, captcha: armtekState.captcha, updatedAt: armtekState.updatedAt });
});

// Получить текущее состояние токена (без секретных данных)
app.get("/vin/token-status", (req, res) => {
  const preview = armtekState.bearer.substring(0, 30) + "…";
  res.json({ preview, captcha: armtekState.captcha, updatedAt: armtekState.updatedAt });
});

// ── ИСТОРИЯ ВИНОВ ─────────────────────────────────────────────────────────────
app.get("/history/:id", (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: "session not found" });
  const list = (s.history || []).map(vin => ({
    vin,
    ...(vinInfoCache[vin] || {})
  }));
  res.json(list);
});

// ── СКАЧАТЬ РАСШИРЕНИЕ CHROME ─────────────────────────────────────────────────
app.get("/extension.zip", async (req, res) => {
  try {
    const JSZip   = require("jszip");
    const extDir  = path.join(__dirname, "extension");
    if (!fs.existsSync(extDir)) return res.status(404).json({ error: "extension folder not found" });
    const zip = new JSZip();
    for (const file of fs.readdirSync(extDir)) {
      const fp = path.join(extDir, file);
      if (fs.statSync(fp).isFile()) zip.file(file, fs.readFileSync(fp));
    }
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    res.set({ "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=vinoil-extension.zip" });
    res.send(buf);
  } catch (e) {
    console.error("[extension.zip]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ЧАТ — обмен текстом ───────────────────────────────────────────────────────
const chatMessages = [];
app.get("/chat", (req, res) => res.sendFile(__dirname + "/public/chat.html"));
app.get("/chat/messages", (req, res) => res.json(chatMessages.slice(-100)));
app.post("/chat/send", (req, res) => {
  const text = (req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "empty" });
  if (text === "/clear") {
    chatMessages.length = 0;
    return res.json({ ok: true, cleared: true });
  }
  chatMessages.push({ text, ts: Date.now() });
  if (chatMessages.length > 200) chatMessages.splice(0, chatMessages.length - 200);
  res.json({ ok: true });
});

app.get("/:id", (req, res) => res.sendFile(__dirname + "/public/index.html"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));