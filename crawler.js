const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const BASE = "https://podbormasla.ru";

const visited = new Set();
const results = [];

async function crawl(url) {
  if (visited.has(url)) return;
  visited.add(url);

  console.log("CRAWL:", url);

  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const links = [];

   const basePath = url.replace("https://podbormasla.ru", "");

$("main a, .content a").each((i, el) => {
  let href = $(el).attr("href");
  const text = $(el).text().trim();

  if (!href) return;

  if (href.startsWith("/")) {
    href = BASE + href;
  }

  if (!href.startsWith(BASE)) return;

  // 🔥 фильтр: только внутренняя структура
  if (!href.includes(basePath)) return;

  links.push({ from: url, to: href, text });
});

    for (let link of links) {
      results.push(link);

      // ограничение глубины (ВАЖНО)
      if (link.to.split("/").length <= 6) {
        await crawl(link.to);
      }
    }

  } catch (e) {
    console.log("FAIL:", url);
  }
}

async function start() {
  await crawl(BASE);

  fs.writeFileSync("links.json", JSON.stringify(results, null, 2));

  console.log("DONE:", results.length);
}

start();