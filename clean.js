const fs = require("fs");

const raw = JSON.parse(fs.readFileSync("links.json", "utf-8"));

const result = [];
const seen = new Set();

for (let item of raw) {
  let url = item.to;

  if (!url.startsWith("https://podbormasla.ru")) continue;

  // убираем хвост /
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }

  const parts = url.replace("https://podbormasla.ru", "").split("/").filter(Boolean);

  // 👇 ключевой фильтр
  if (parts.length >= 2 && parts.length <= 3) {
    if (!seen.has(url)) {
      seen.add(url);

      result.push({
        url,
        path: parts
      });
    }
  }
}

fs.writeFileSync("clean_links.json", JSON.stringify(result, null, 2));

console.log("CLEAN:", result.length);