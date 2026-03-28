"use strict";
const express = require("express");
const multer  = require("multer");
const fs      = require("fs");
const axios   = require("axios");
const https   = require("https");

const { parseEngineBlocks, findEngineBlock } = require("./utils/parseOil");
const { extractVIN, normalizeVIN }           = require("./utils/ocr");
const { buildRecommendations, resolveUrl, fallbackFromPage, fallbackGlobal } = require("./utils/oilLogic");
const { findFilters }                        = require("./utils/parseFilters");
const { getOriginalFilters }                 = require("./utils/getFilters");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const upload   = multer({ dest: "uploads/" });
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

app.post("/manual/:id", (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: "session not found" });
  const vin = normalizeVIN(req.body.vin);
  if (!vin || vin.length !== 17) return res.status(400).json({ error: "invalid VIN" });
  saveVIN(s, vin);
  console.log(`[manual] session=${req.params.id} vin=${vin}`);
  res.json({ vin });
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

    const tree = require("./tree.json");
    console.log(`[oil] ${car.brand} ${car.model} ${car.year} engine=${car.engine.code}`);

    const filtersPromise = getOriginalFilters(car);

    const url = await resolveUrl(car, tree);

    // ── Нет URL в дереве — только GPT ────────────────────────────────────────
    if (!url) {
      console.log("[oil] no url → gpt only");
      const [gptResult, filters] = await Promise.all([
        fallbackGlobal(car),
        filtersPromise
      ]);

      // GPT-объём — это заправочный объём масла (НЕ рабочий объём двигателя)
      const gptFillVolume = gptResult?.found ? (gptResult.volume || null) : null;

      const oilGpt = gptResult?.found
        ? { volume: gptFillVolume, oil: { best: gptResult.best || [], alternative: gptResult.alternative || [] } }
        : null;

      return res.json({
        car, url: null,
        source: gptResult?.found ? "gpt_global" : "not_found",
        oil: null,
        oil_gpt: oilGpt,
        recommendations: buildRecommendations(oilGpt, prefs, gptFillVolume),
        filters
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

    // GPT fill volume
    const gptFillVolume = gptResult?.found ? (gptResult.volume || null) : null;

    // Правый блок «ИИ» — всегда из fallbackGlobal
    const oilGpt = gptResult?.found
      ? { volume: gptFillVolume, oil: { best: gptResult.best || [], alternative: gptResult.alternative || [] } }
      : null;

    // ── Парсер нашёл двигатель ────────────────────────────────────────────────
    if (engine) {
      // ЗАПРАВОЧНЫЙ объём берём из парсера (engine.volume), НЕ из car.engine.volume!
      // engine.volume = 3.8 (заправочный, из столбца "Объём заливки")
      // car.engine.volume = 1.5 (рабочий объём двигателя из UPEC API)
      const parsedFillVolume = engine.volume || gptFillVolume || null;

      console.log(`[oil] source=parsed, parsedFillVolume=${parsedFillVolume} (engine.volume=${engine.volume}, gptFillVolume=${gptFillVolume})`);

      const oilParsed = {
        volume: parsedFillVolume,
        oil: { best: engine.oil.best, alternative: engine.oil.alternative }
      };

      return res.json({
        car, url,
        source: "parsed",
        oil: oilParsed,
        oil_gpt: oilGpt,
        recommendations: buildRecommendations(oilParsed, prefs, parsedFillVolume),
        filters
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

      return res.json({
        car, url,
        source: "gpt_html",
        oil: oilPage,
        oil_gpt: oilGpt,
        recommendations: buildRecommendations(oilPage, prefs, pageFillVolume),
        filters
      });
    }

    // ── Всё упало → только GPT global ────────────────────────────────────────
    console.log("[oil] source=gpt_global only");

    return res.json({
      car, url,
      source: gptResult?.found ? "gpt_global" : "not_found",
      oil: null,
      oil_gpt: oilGpt,
      recommendations: buildRecommendations(oilGpt, prefs, gptFillVolume),
      filters
    });

  } catch (e) {
    console.error("[oil] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/:id", (req, res) => res.sendFile(__dirname + "/public/index.html"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));