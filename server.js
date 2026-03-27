const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const fs = require("fs");
const axios = require("axios");
const https = require("https");

const app = express();
app.use(express.json());

// 👉 статика (ОБЯЗАТЕЛЬНО)
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// память (MVP)
const sessions = {};

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
    console.error(e);
    res.status(500).json({ error: "failed" });
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