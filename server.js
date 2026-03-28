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
        return res.json({ car: null, url: null, source: "car_not_found", oil: null, oil_source: null, recommendations: [], filters: null });
      throw e;
    }

    const tree = require("./tree.json");
    console.log(`[oil] ${car.brand} ${car.model} ${car.year} engine=${car.engine.code}`);

    const filtersPromise = Promise.resolve(findFilters(car));

    const url = await resolveUrl(car, tree);

    if (!url) {
      console.log("[oil] no url → fallbackGlobal");
      const gpt = await fallbackGlobal(car);
      const oil = gpt?.found ? { volume: gpt.volume||null, oil: { best: gpt.best||[], alternative: gpt.alternative||[] } } : null;
      const filters = await filtersPromise;
      return res.json({ car, url: null, source: gpt?.found ? "gpt_global" : "not_found", oil, oil_source: null, recommendations: buildRecommendations(oil), filters });
    }

    console.log(`[oil] parsing ${url}`);
    const blocks = await parseEngineBlocks(url);
    const engine = findEngineBlock(blocks, car);

    if (engine) {
      console.log("[oil] found via parser");
      const filters = await filtersPromise;
      // oil_source = данные с сайта (парсер), oil = те же данные (единственный источник)
      return res.json({ car, url, source: "parsed", oil: engine, oil_source: engine, recommendations: buildRecommendations(engine), filters });
    }

    console.log("[oil] engine not found → fallbackFromPage");
    const gptPage = await fallbackFromPage(url, car);
    if (gptPage?.found) {
      const oil = { volume: gptPage.volume||null, oil: { best: gptPage.best||[], alternative: gptPage.alternative||[] } };
      const filters = await filtersPromise;
      return res.json({ car, url, source: "gpt_html", oil, oil_source: null, recommendations: buildRecommendations(oil), filters });
    }

    console.log("[oil] page fallback failed → fallbackGlobal");
    const gptGlobal = await fallbackGlobal(car);
    if (gptGlobal?.found) {
      const oil = { volume: gptGlobal.volume||null, oil: { best: gptGlobal.best||[], alternative: gptGlobal.alternative||[] } };
      const filters = await filtersPromise;
      return res.json({ car, url, source: "gpt_global", oil, oil_source: null, recommendations: buildRecommendations(oil), filters });
    }

    const filters = await filtersPromise;
    res.json({ car, url, source: "not_found", oil: null, oil_source: null, recommendations: [], filters });

  } catch (e) {
    console.error("[oil] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/:id", (req, res) => res.sendFile(__dirname + "/public/index.html"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));