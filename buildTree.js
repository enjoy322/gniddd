const fs = require("fs");

const raw = JSON.parse(fs.readFileSync("links.json", "utf-8"));

const tree = {};

for (let item of raw) {
  let url = item.to;

  if (!url.startsWith("https://podbormasla.ru")) continue;

  // убираем домен
  const path = url.replace("https://podbormasla.ru", "")
    .split("/")
    .filter(Boolean);

  // интересуют только до 3 уровней
  if (path.length < 1 || path.length > 3) continue;

  const [brand, model, generation] = path;

  // бренд
  if (!tree[brand]) {
    tree[brand] = {};
  }

  // модель
  if (model) {
    if (!tree[brand][model]) {
      tree[brand][model] = {
        generations: []
      };
    }
  }

  // поколение
  if (generation) {
    if (!tree[brand][model].generations.includes(generation)) {
      tree[brand][model].generations.push(generation);
    }
  }
}

fs.writeFileSync("tree.json", JSON.stringify(tree, null, 2));

console.log("DONE");