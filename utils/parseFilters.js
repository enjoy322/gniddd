"use strict";
const fs = require("fs");
const path = require("path");

const CATALOG_PATH = path.join(__dirname, "../filter-catalog.json");

let _catalog = null;

function loadCatalog() {
  if (_catalog) return _catalog;
  try {
    _catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf-8"));
  } catch (e) {
    _catalog = {};
  }
  return _catalog;
}

function findFilters(car) {
  const catalog = loadCatalog();
  const code    = (car.engine?.code || "").toUpperCase();
  const brand   = (car.brand  || "").toLowerCase();
  const model   = (car.model  || "").toLowerCase();

  if (!code) return null;

  // Точное совпадение: code|brand|model
  const exactKey = `${code}|${brand}|${model}`;
  if (catalog[exactKey]) return catalog[exactKey];

  // Фолбэк: любой ключ с этим engine_code
  const fallback = Object.keys(catalog).find(k => k.startsWith(code + "|"));
  return fallback ? catalog[fallback] : null;
}

module.exports = { findFilters };