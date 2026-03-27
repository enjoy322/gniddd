const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// память
const sessions = {};

// создать сессию
app.get("/new-session", (req, res) => {
  const id = Math.random().toString(36).substring(2, 8).toUpperCase();
  sessions[id] = { vin: null, history: [] };
  res.json({ session_id: id });
});

// сохранить VIN
function saveVIN(session, vin) {
  session.vin = vin;
  if (!session.history.includes(vin)) {
    session.history.unshift(vin);
  }
}

// очистка
function normalizeVIN(vin) {
  return vin
    ?.toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[IOQ]/g, "");
}

// GPT OCR (1 попытка)
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
          text: "Найди VIN на изображении. Ответ строго: 17 символов или NOT_FOUND."
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

// 3 попытки
async function extractVIN(filePath) {
  for (let i = 0; i < 3; i++) {
    console.log("TRY:", i + 1);

    const vin = await extractVINonce(filePath);

    console.log("RAW:", vin);

    if (vin && vin.length === 17) {
      return vin;
    }
  }

  return null;
}

// загрузка фото
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
    console.error("UPLOAD ERROR:", e);
    res.status(500).json({ error: "failed" });
  }
});

// ручной ввод
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

// данные
app.get("/data/:id", (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).end();

  res.json(session);
});

// SPA фикс
app.get("*", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("http://localhost:" + PORT);
});