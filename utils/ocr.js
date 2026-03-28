"use strict";
const fs     = require("fs");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Нормализация VIN ──
function normalizeVIN(vin) {
  return vin
    ?.toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[IOQ]/g, "");
}

// ── Три промпта с разным подходом — повышают шанс распознавания ──
const VIN_PROMPTS = [
  "Find the VIN number in this image. Reply with ONLY the 17-character VIN, no spaces, no explanation. If not found, reply NOT_FOUND.",
  "Look carefully at this image for a VIN (Vehicle Identification Number). It is 17 characters long, contains only letters A-Z (except I, O, Q) and digits 0-9. It may be on a sticker, dashboard, door frame, or document. Reply with ONLY the 17-character VIN or NOT_FOUND.",
  "This image may contain a VIN code. VIN is exactly 17 alphanumeric characters. Look for sequences like 'XTA', 'Z94', 'WBA', 'JN1', 'SHH' at the start — these are common VIN beginnings. Extract and return ONLY the 17-character VIN with no spaces. If you cannot find it, reply NOT_FOUND."
];

async function extractVINwithPrompt(filePath, promptText) {
  const base64 = fs.readFileSync(filePath).toString("base64");

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text",  text: promptText },
          { type: "input_image", image_url: `data:image/jpeg;base64,${base64}` }
        ]
      }
    ]
  });

  return normalizeVIN(response.output_text.trim());
}

async function extractVIN(filePath) {
  for (let attempt = 0; attempt < VIN_PROMPTS.length; attempt++) {
    console.log(`[VIN OCR] attempt ${attempt + 1}/${VIN_PROMPTS.length}`);
    try {
      const vin = await extractVINwithPrompt(filePath, VIN_PROMPTS[attempt]);
      console.log(`[VIN OCR] raw result: ${vin}`);
      if (vin && vin.length === 17) {
        console.log(`[VIN OCR] success on attempt ${attempt + 1}`);
        return vin;
      }
    } catch (e) {
      console.error(`[VIN OCR] attempt ${attempt + 1} error:`, e.message);
    }
  }
  console.log("[VIN OCR] all attempts failed");
  return null;
}

module.exports = { extractVIN, normalizeVIN };
