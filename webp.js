const axios = require("axios");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const FILE_PATH = "./ARMTEK_MAIN_40211446_202603280835.xlsx";
const SAVE_DIR = "./logos";

// создаем папку если нет
if (!fs.existsSync(SAVE_DIR)) {
  fs.mkdirSync(SAVE_DIR);
}

// читаем файл
const workbook = XLSX.readFile(FILE_PATH);

// проверим листы
console.log("Листы:", workbook.SheetNames);

// берем ВТОРОЙ лист
const sheetName = workbook.SheetNames[1];
const sheet = workbook.Sheets[sheetName];

// 👇 читаем как массив массивов (без заголовков)
const rows = XLSX.utils.sheet_to_json(sheet, {
  header: 1,
  blankrows: false,
});

console.log("Всего строк:", rows.length);
console.log("Пример:", rows[0]);

async function download() {
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    const brandRaw = row[0];
    const url = row[1];

    console.log("\n------------------");
    console.log("Строка:", i + 1);
    console.log("brand:", brandRaw);
    console.log("url:", url);

    if (!brandRaw || !url) {
      console.log("⛔ пусто — пропуск");
      fail++;
      continue;
    }

    if (typeof url !== "string" || !url.startsWith("http")) {
      console.log("⛔ невалидный URL");
      fail++;
      continue;
    }

    // нормализуем имя файла
    const brand = String(brandRaw)
      .trim()
      .replace(/[^a-z0-9]/gi, "_")
      .toLowerCase();

    const filePath = path.join(SAVE_DIR, `${brand}.webp`);

    try {
      const res = await axios({
        method: "GET",
        url,
        responseType: "arraybuffer",
        timeout: 15000,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "image/webp,image/*,*/*",
        },
        validateStatus: () => true,
      });

      console.log("status:", res.status);

      if (res.status !== 200) {
        console.log("⛔ не 200");
        fail++;
        continue;
      }

      const type = res.headers["content-type"] || "";
      console.log("type:", type);

      if (!type.includes("image")) {
        console.log("⛔ это не картинка");
        fail++;
        continue;
      }

      fs.writeFileSync(filePath, res.data);

      console.log("✅ сохранено:", filePath);
      ok++;
    } catch (err) {
      console.log("💥 ошибка:", err.message);
      fail++;
    }
  }

  console.log("\n====================");
  console.log("ГОТОВО");
  console.log("OK:", ok);
  console.log("FAIL:", fail);
}

download();