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

function normalizeCar(data) {
  return {
    brand: data.brand, model: data.model, generation: data.generation,
    year: data.year_manufactured,
    engine: {
      code:   data.engine_code,
      volume: parseFloat(data.engine_volume?.replace(",", ".")),
      type:   data.engine_type
    },
    transmission: data.transmission, drive: data.drive, power_hp: parseInt(data.power)
  };
}

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

app.get("/:id", (req, res) => res.sendFile(__dirname + "/public/index.html"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));