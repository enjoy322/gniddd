const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const fs = require("fs");
const axios = require("axios");
const https = require("https");
const cheerio = require("cheerio");
const { parseEngineBlocks, findEngineBlock } = require("./utils/parseOil");
const app = express();
app.use(express.json());

// 👉 статика (ОБЯЗАТЕЛЬНО)
app.use(express.static("public"));

async function matchCarToUrl(car, tree) {
  const input = `
Найди лучшее совпадение.

Авто:
Бренд: ${car.brand}
Модель: ${car.model}
Поколение: ${car.generation}

Доступные варианты:
${JSON.stringify(tree[car.brand.toLowerCase()] || {}, null, 2)}

Ответ:
{
  "model": "...",
  "generation": "..."
}
`;

  const res = await openai.responses.create({
    model: "gpt-5.4-mini",
    input
  });

  try {
    return JSON.parse(res.output_text);
  } catch {
    return null;
  }
}
/*async function parseEngineBlocks(url) {
  const { data } = await axios.get(url);
  const $ = cheerio.load(data);

  const blocks = [];

  $("table tr").each((i, el) => {
    const rowText = $(el).text();

    if (!rowText.includes("Модель")) return;

    const blockText = $(el).text();

    // достаем коды двигателей
    const codes = [...blockText.matchAll(/[A-Z]{3,5}/g)].map(m => m[0]);

    // объем
    const volumeMatch = blockText.match(/(\d\.\d)\s*л/);

    // вязкость
    const viscosity = [...blockText.matchAll(/\d{1,2}W-\d{2}/g)].map(m => m[0]);

    // допуски
    const specs = [...blockText.matchAll(/[A-Z]{2,}\s?\d{2,3}\.\d{2}/g)].map(m => m[0]);

    if (codes.length === 0) return;

    blocks.push({
      codes,
      volume: volumeMatch ? volumeMatch[1] : null,
      viscosity: [...new Set(viscosity)],
      specs: [...new Set(specs)],
      raw: blockText
    });
  });

  return blocks;
}*/

function normalizeCar(data) {
  return {
    brand: data.brand,
    model: data.model,
    generation: data.generation,
    year: data.year_manufactured,

    engine: {
      code: data.engine_code,
      volume: parseFloat(data.engine_volume?.replace(",", ".")),
      type: data.engine_type
    },

    transmission: data.transmission,
    drive: data.drive,
    power_hp: parseInt(data.power)
  };
}
const upload = multer({ dest: "uploads/" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// память (MVP)
const sessions = {};
app.get("/test-links", async (req, res) => {
  try {
    const axios = require("axios");
    const cheerio = require("cheerio");

    const { data } = await axios.get("https://podbormasla.ru/");

    const $ = cheerio.load(data);

    const links = [];

    $("a").each((i, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();

      if (href && text && href.startsWith("/")) {
        links.push({
          text,
          href
        });
      }
    });

    res.json(links.slice(0, 50)); // чтобы не заспамить
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// 🆕 создать сессию
app.get("/new-session", (req, res) => {
  const id = Math.random().toString(36).substring(2, 8).toUpperCase();
  sessions[id] = { vin: null, history: [] };
  res.json({ session_id: id });
});

// 💾 сохранить VIN
function saveVIN(session, vin) {
  session.vin = vin;
  if (!session.history.includes(vin)) {
    session.history.unshift(vin);
  }
}

// 🧹 очистка
function normalizeVIN(vin) {
  return vin
    ?.toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[IOQ]/g, "");
}

// 🤖 GPT (1 попытка)
async function extractVINonce(filePath) {
  const imageBuffer = fs.readFileSync(filePath);
  const base64 = imageBuffer.toString("base64");

  const response = await openai.responses.create({
    model: "gpt-5.4-mini",
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Найди VIN. Ответ строго 17 символов или NOT_FOUND."
        },
        {
          type: "input_image",
          image_url: `data:image/jpeg;base64,${base64}`
        }
      ]
    }]
  });

  return normalizeVIN(response.output_text);
}


// 🔁 2 попытки
async function extractVIN(filePath) {
  for (let i = 0; i < 2; i++) {
    console.log("TRY:", i + 1);

    const vin = await extractVINonce(filePath);
    console.log("RAW:", vin);

    if (vin && vin.length === 17) {
      return vin;
    }
  }

  return null;
}

// 📤 загрузка фото
app.post("/upload/:id", upload.single("image"), async (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).end();

  console.log("UPLOAD START");

  try {
    const vin = await extractVIN(req.file.path);

    console.log("FINAL VIN:", vin);

    if (vin) {
      saveVIN(session, vin);
    }

    res.json({ vin });

  } catch (e) {
  console.error("ERROR URL:", test.url);
  console.error(e.message);
}
  }
);
app.get("/car-info/:vin", async (req, res) => {
  try {
    const response = await axios.get("https://podbor.upec.pro/api/v1/public/find-car", {
      params: {
        vin: req.params.vin,
        token: "32e33ef47960cdf8b9503c2cd241d20e2893b17623b3c916e829620bcfdf177d",
        transportType: "CAR",
        source: "vin"
      },
      headers: {
        "User-Agent": "Mozilla/5.0"
      },
      httpsAgent: new (require("https").Agent)({
        rejectUnauthorized: false
      })
    });

    const normalized = normalizeCar(response.data);

    res.json(normalized);

  } catch (e) {
    res.status(500).json({ error: "fail", details: e.message });
  }
});
app.get("/test-engine", async (req, res) => {
  try {
    const url = "https://podbormasla.ru/skoda/octavia/octavia_3/";

    const blocks = await parseEngineBlocks(url);

    res.json(blocks);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/test-match", async (req, res) => {
  try {
    const url = "https://podbormasla.ru/skoda/octavia/octavia_3/";

    const car = {
      engine: {
        code: "CWVA",
        volume: 1.6
      }
    };

    const blocks = await parseEngineBlocks(url);
    const engine = findEngineBlock(blocks, car);

    res.json(engine);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/test-sintec", async (req, res) => {
  try {const response = await axios.get("https://podbor.upec.pro/api/v1/public/find-car", {
  params: {
    vin: "Z94CB51AAGR059195",
    token: "32e33ef47960cdf8b9503c2cd241d20e2893b17623b3c916e829620bcfdf177d",
    transportType: "CAR",
    source: "vin"
  },
  headers: {
    "User-Agent": "Mozilla/5.0"
  },
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  })
});
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: "fail", details: e.message });
  }
});
// ⌨️ ручной ввод
app.post("/manual/:id", (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).end();

  let vin = normalizeVIN(req.body.vin);

  if (!vin || vin.length !== 17) {
    return res.json({ error: "invalid" });
  }

  saveVIN(session, vin);

  res.json({ vin });
});

app.get("/test-final", async (req, res) => {
  const tests = [
    {
      name: "Skoda Octavia",
      url: "https://podbormasla.ru/skoda/octavia/octavia_3/",
      engine: "CWVA"
    },
    {
      name: "Kia Rio",
      url: "https://podbormasla.ru/kia/rio/gen3/",
      engine: "G4FA"
    },
    {
      name: "VW Polo",
      url: "https://podbormasla.ru/volkswagen/polo/polo_5/",
      engine: "CFNA"
    },
    {
      name: "Renault Sandero",
      url: "https://podbormasla.ru/renault/sandero/sandero_2/",
      engine: "D4F"
    }
  ];

  const results = [];

  for (let test of tests) {
    try {
      console.log("FETCH:", test.url);

      const blocks = await parseEngineBlocks(test.url);

      const found = blocks.find(b =>
        b.codes.includes(test.engine.toUpperCase())
      );

      results.push({
        name: test.name,
        url: test.url,
        engine: test.engine,
        blocksCount: blocks.length,
        found: !!found,
        result: found || null
      });

    } catch (e) {
      results.push({
        name: test.name,
        url: test.url,
        error: e.message
      });
    }
  }

  res.json(results);
});

app.get("/oil/:vin", async (req, res) => {
  try {
    const carRes = await axios.get(
      "https://gniddd.onrender.com/car-info/" + req.params.vin
    );

    const car = carRes.data;

    // ⚠️ временно вручную (потом автоматизируем)
    const url = "https://podbormasla.ru/skoda/octavia/octavia_3/";

    const blocks = await parseEngineBlocks(url);
    const engine = findEngineBlock(blocks, car);

    res.json({
      car,
      oil: engine
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// 📊 данные
app.get("/data/:id", (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).end();

  res.json(session);
});


// 🔥 ВОТ ЭТО ГЛАВНОЕ (чтобы /ABC123 работало)
app.get("/:id", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});


// 🚀 запуск
const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
  console.log("http://localhost:" + PORT);
});