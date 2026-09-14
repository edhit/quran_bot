#!/usr/bin/env node
/**
 * Обёртка над `wrangler d1`, которая берёт имя базы из wrangler.toml.
 *
 * Имя базы должно жить в одном месте. Иначе легко поменять его в конфиге,
 * забыть про npm-скрипты — и залить миграцию в чужую базу.
 *
 *   node scripts/d1.mjs create
 *   node scripts/d1.mjs info
 *   node scripts/d1.mjs execute --remote --file=./migrations/0001_init.sql
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const toml = fs.readFileSync("wrangler.toml", "utf8");

// Ищем database_name внутри блока [[d1_databases]], а не где попало в файле.
const block = toml.split(/^\s*\[\[d1_databases\]\]\s*$/m)[1];
const name = block?.match(/^\s*database_name\s*=\s*"([^"]+)"/m)?.[1];

if (!name) {
  console.error("Не нашёл database_name в блоке [[d1_databases]] файла wrangler.toml");
  process.exit(1);
}

const [sub, ...rest] = process.argv.slice(2);
if (!sub) {
  console.error("Укажи подкоманду: create | info | execute ...");
  process.exit(1);
}

console.log(`База: ${name}`);
const r = spawnSync("npx", ["wrangler", "d1", sub, name, ...rest], { stdio: "inherit" });
process.exit(r.status ?? 1);
