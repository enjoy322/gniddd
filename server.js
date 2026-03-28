const express = require("express");
const multer  = require("multer");
const OpenAI  = require("openai");
const fs      = require("fs");
const axios   = require("axios");
const https   = require("https");
const cheerio = require("cheerio");
const { matchOil } = require("./oils");


const { parseEngineBlocks, findEngineBlock } = require("./utils/parseOil");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const upload   = multer({ dest: "uploads/" });
const sessions = {};

const UPEC_TOKEN = "32e33ef47960cdf8b9503c2cd241d20e2893b17623b3c916e829620bcfdf177d";
const UPEC_URL   = "https://podbor.upec.pro/api/v1/public/find-car";
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function normalizeVIN(vin) {
  return vin
    ?.toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[IOQ]/g, "");
}

function saveVIN(session, vin) {
  session.vin = vin;
  if (!session.history.includes(vin)) {
    session.history.unshift(vin);
  }
}

function normalizeCar(data) {
  return {
    brand:      data.brand,
    model:      data.model,
    generation: data.generation,
    year:       data.year_manufactured,
    engine: {
      code:   data.engine_code,
      volume: parseFloat(data.engine_volume?.replace(",", ".")),
      type:   data.engine_type
    },
    transmission: data.transmission,
    drive:        data.drive,
    power_hp:     parseInt(data.power)
  };
}

// Удаляем временный файл после обработки
function cleanupFile(path) {
  try { fs.unlinkSync(path); } catch (_) {}
}

// ─────────────────────────────────────────────
// CAR INFO (внутренний вызов, без HTTP к себе)
// ─────────────────────────────────────────────

// Специальный класс чтобы отличать "не найдено" от сетевых ошибок
class CarNotFoundError extends Error {
  constructor(vin) {
    super(`Car not found for VIN: ${vin}`);
    this.name = "CarNotFoundError";
  }
}

async function fetchCarInfo(vin) {
  const response = await axios.get(UPEC_URL, {
    params: {
      vin,
      token:         UPEC_TOKEN,
      transportType: "CAR",
      source:        "vin"
    },
    headers:    { "User-Agent": "Mozilla/5.0" },
    httpsAgent,
    // Не бросаем исключение на 404/400 — обработаем сами
    validateStatus: status => status < 500
  });

  // API вернул ошибку — машина не найдена (грузовик, мото, неверный VIN и т.д.)
  if (response.status !== 200 || !response.data?.brand) {
    throw new CarNotFoundError(vin);
  }

  return normalizeCar(response.data);
}

// ─────────────────────────────────────────────
// VIN EXTRACTION (OCR через GPT)
// ─────────────────────────────────────────────
async function extractVINonce(filePath) {
  const base64 = fs.readFileSync(filePath).toString("base64");

  const response = await openai.responses.create({
    model: "gpt-5.4-mini",
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Найди VIN на изображении. Ответь строго 17 символами без пробелов, или NOT_FOUND если не видно."
        },
        {
          type:      "input_image",
          image_url: `data:image/jpeg;base64,${base64}`
        }
      ]
    }]
  });

  return normalizeVIN(response.output_text.trim());
}

async function extractVIN(filePath) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`[VIN OCR] attempt ${attempt}`);
    const vin = await extractVINonce(filePath);
    console.log(`[VIN OCR] raw result: ${vin}`);
    if (vin && vin.length === 17) return vin;
  }
  return null;
}

// ─────────────────────────────────────────────
// OIL LOGIC
// ─────────────────────────────────────────────

// Определяем URL страницы на podbormasla.ru по дереву + GPT
async function resolveUrl(car, tree) {
  const brand = car.brand?.toLowerCase();
  const model = car.model?.toLowerCase();

  if (!brand || !model || !tree[brand] || !tree[brand][model]) {
    return null;
  }

  const generations = tree[brand][model].generations || [];
  if (!generations.length) return null;

  // Если поколение одно — не тратим токены
  if (generations.length === 1) {
    return `https://podbormasla.ru/${brand}/${model}/${generations[0]}/`;
  }

  const prompt = `
У меня есть машина:
brand: ${car.brand}
model: ${car.model}
generation: ${car.generation}
year: ${car.year}

Вот список поколений (с индексами):
${generations.map((g, i) => `${i}: ${g}`).join("\n")}

Верни ТОЛЬКО индекс (число), который лучше всего подходит. Без текста, только число.
`.trim();

  const response = await openai.responses.create({
    model: "gpt-5.4-mini",
    input: prompt
  });

  let index = parseInt(response.output_text.trim());

  if (isNaN(index) || index < 0 || index >= generations.length) {
    console.log("[resolveUrl] bad index from GPT, fallback to 0");
    index = 0;
  }

  return `https://podbormasla.ru/${brand}/${model}/${generations[index]}/`;
}

// Фоллбэк 1: парсим HTML страницы через GPT когда парсер не нашёл движок
async function fallbackFromPage(url, car) {
  console.log(`[fallbackFromPage] url=${url} engine=${car.engine.code}`);

  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  const prompt = `
Ты автоэксперт по маслам.

Вот HTML страницы подбора масла (первые 15000 символов):
${data.slice(0, 15000)}

Найди данные для двигателя: ${car.engine.code}

Верни строго JSON без markdown:
{
  "found": true,
  "best": [
    { "specs": ["ACEA A3"], "viscosity": ["5W-40"] }
  ],
  "alternative": [
    { "specs": [], "viscosity": ["5W-30"] }
  ]
}

Если двигатель не найден — верни: { "found": false }
`.trim();

  const response = await openai.responses.create({
    model: "gpt-5.4-mini",
    input: prompt
  });

  try {
    const text = response.output_text.replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch (e) {
    console.error("[fallbackFromPage] JSON parse error:", e.message);
    return null;
  }
}

// Фоллбэк 2: GPT по знаниям, без парсинга (когда нет страницы вообще)
async function fallbackGlobal(car) {
  console.log(`[fallbackGlobal] ${car.brand} ${car.model} engine=${car.engine.code}`);

  const prompt = `
Ты автоэксперт по моторным маслам.

Автомобиль:
- Марка: ${car.brand}
- Модель: ${car.model}
- Год: ${car.year}
- Двигатель: ${car.engine.code}, ${car.engine.volume}л, ${car.engine.type}
- Мощность: ${car.power_hp} л.с.

Подбери моторное масло. Верни строго JSON без markdown:
{
  "found": true,
  "volume": 4.5,
  "best": [
    { "specs": ["ACEA A3/B4", "VW 502.00"], "viscosity": ["5W-40"] }
  ],
  "alternative": [
    { "specs": ["ACEA A3/B4"], "viscosity": ["5W-30"] }
  ]
}

Если не можешь подобрать — верни: { "found": false }
Только JSON, никакого текста вокруг.
`.trim();

  const response = await openai.responses.create({
    model: "gpt-5.4-mini",
    input: prompt
  });

  try {
    const text = response.output_text.replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch (e) {
    console.error("[fallbackGlobal] JSON parse error:", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Создать сессию
app.get("/new-session", (req, res) => {
  const id = Math.random().toString(36).substring(2, 8).toUpperCase();
  sessions[id] = { vin: null, history: [] };
  console.log(`[session] created: ${id}`);
  res.json({ session_id: id });
});

// Данные сессии (polling)
app.get("/data/:id", (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: "session not found" });
  res.json(session);
});

// Ручной ввод VIN
app.post("/manual/:id", (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: "session not found" });

  const vin = normalizeVIN(req.body.vin);

  if (!vin || vin.length !== 17) {
    return res.status(400).json({ error: "invalid VIN" });
  }

  saveVIN(session, vin);
  console.log(`[manual] session=${req.params.id} vin=${vin}`);
  res.json({ vin });
});

// Загрузка фото
app.post("/upload/:id", upload.single("image"), async (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: "session not found" });

  if (!req.file) return res.status(400).json({ error: "no file" });

  console.log(`[upload] session=${req.params.id} file=${req.file.path}`);

  try {
    const vin = await extractVIN(req.file.path);
    console.log(`[upload] final VIN: ${vin}`);

    if (vin) saveVIN(session, vin);

    res.json({ vin: vin || null });
  } catch (e) {
    console.error("[upload] error:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    // Чистим временный файл в любом случае
    cleanupFile(req.file.path);
  }
});

// Данные об авто
app.get("/car-info/:vin", async (req, res) => {
  try {
    const car = await fetchCarInfo(req.params.vin);
    res.json(car);
  } catch (e) {
    if (e.name === "CarNotFoundError") {
      return res.status(404).json({ error: "not_found", message: "Автомобиль не найден" });
    }
    console.error("[car-info] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Масло по VIN — основной эндпоинт
app.get("/oil/:vin", async (req, res) => {
  try {
    // Грузим данные об авто напрямую (без HTTP к себе)
    let car;
    try {
      car = await fetchCarInfo(req.params.vin);
    } catch (e) {
      if (e.name === "CarNotFoundError") {
        console.log(`[oil] car not found for VIN: ${req.params.vin}`);
        // Возвращаем 200 с понятным source — фронт не ломается, polling продолжает работать
        return res.json({ car: null, url: null, source: "car_not_found", oil: null });
      }
      throw e;
    }

    const tree = require("./tree.json");

    console.log(`[oil] ${car.brand} ${car.model} ${car.year} engine=${car.engine.code}`);

    const url = await resolveUrl(car, tree);

    // ── Нет страницы → сразу GPT global ──
    if (!url) {
      console.log("[oil] no url → fallbackGlobal");
      const gpt = await fallbackGlobal(car);

      return res.json({
        car,
        url:    null,
        source: gpt?.found ? "gpt_global" : "not_found",
        oil:    gpt?.found ? {
          volume: gpt.volume || null,
          oil: {
            best:        gpt.best        || [],
            alternative: gpt.alternative || []
          }
        } : null
      });
    }

    // ── Парсим страницу ──
    console.log(`[oil] parsing ${url}`);
    const blocks = await parseEngineBlocks(url);
    const engine = findEngineBlock(blocks, car);

    if (engine) {
      console.log("[oil] found via parser");
      return res.json({ car, url, source: "parsed", oil: engine });
    }

    // ── Парсер не нашёл движок → GPT по HTML ──
    console.log("[oil] engine not found → fallbackFromPage");
    const gptPage = await fallbackFromPage(url, car);

    if (gptPage?.found) {
      return res.json({
        car,
        url,
        source: "gpt_html",
        oil: {
          volume: null,
          oil: {
            best:        gptPage.best        || [],
            alternative: gptPage.alternative || []
          }
        }
      });
    }

    // ── Финальный фоллбэк → GPT global ──
    console.log("[oil] page fallback failed → fallbackGlobal");
    const gptGlobal = await fallbackGlobal(car);

    if (gptGlobal?.found) {
      return res.json({
        car,
        url,
        source: "gpt_global",
        oil: {
          volume: gptGlobal.volume || null,
          oil: {
            best:        gptGlobal.best        || [],
            alternative: gptGlobal.alternative || []
          }
        }
      });
    }

    // ── Ничего не нашли ──
    res.json({ car, url, source: "not_found", oil: null });

  } catch (e) {
    console.error("[oil] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// CATCH-ALL — отдаём index.html для /:sessionId
// ─────────────────────────────────────────────
app.get("/:id", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
