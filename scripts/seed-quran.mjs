#!/usr/bin/env node
/**
 * Скачивает арабский текст Корана и разметку (сура / аят / страница мусхафа /
 * джуз / хизб) и складывает в seed/quran.sql для заливки в D1.
 *
 * Запускать со своей машины (не из Worker'а) — один раз:
 *     npm run quran:fetch
 *     npm run quran:load
 *
 * Переводы и тафсир СЮДА НЕ КЛАДУТСЯ: они тянутся ботом по запросу и
 * кэшируются в твоей же базе. Так в репозитории лежит только сам арабский текст.
 *
 * Если api.quran.com перестанет отвечать — передай другой источник:
 *     node scripts/seed-quran.mjs --api-base https://...
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const API = arg("api-base", "https://api.quran.com/api/v4");
const OUT = arg("out", "seed/quran.sql");

const EXPECT_SURAHS = 114;
const EXPECT_AYAT = 6236;
const EXPECT_PAGES = 604;

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function getJSON(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((res) => setTimeout(res, 2 ** attempt * 1000));
    }
  }
}

async function fetchSurahs() {
  const ru = await getJSON(`${API}/chapters?language=ru`);
  const en = await getJSON(`${API}/chapters?language=en`);
  const nameRu = new Map(en.chapters.map((c) => [c.id, c.name_simple]));
  for (const c of ru.chapters) {
    if (c.translated_name?.name) nameRu.set(c.id, c.translated_name.name);
  }
  return ru.chapters.map((c) => ({
    id: c.id,
    name_ar: c.name_arabic,
    name_ru: nameRu.get(c.id) ?? c.name_simple,
    ayah_count: c.verses_count,
    revelation: c.revelation_place,
    page_start: c.pages?.[0] ?? 0,
  }));
}

async function fetchAyat() {
  const out = [];
  for (let surah = 1; surah <= EXPECT_SURAHS; surah++) {
    let page = 1;
    for (;;) {
      const url =
        `${API}/verses/by_chapter/${surah}` +
        `?fields=text_uthmani,text_imlaei_simple,page_number,juz_number,hizb_number` +
        `&per_page=50&page=${page}`;
      const data = await getJSON(url);
      for (const v of data.verses) {
        const [s, a] = v.verse_key.split(":").map(Number);
        out.push({
          surah: s,
          ayah: a,
          page: v.page_number,
          juz: v.juz_number,
          hizb: v.hizb_number,
          uthmani: v.text_uthmani,
          plain: v.text_imlaei_simple ?? v.text_uthmani,
        });
      }
      const total = data.pagination?.total_pages ?? 1;
      if (page >= total) break;
      page++;
    }
    process.stdout.write(`\rсура ${surah}/114 — аятов: ${out.length}   `);
  }
  process.stdout.write("\n");
  return out;
}

function validate(surahs, ayat) {
  const problems = [];
  if (surahs.length !== EXPECT_SURAHS)
    problems.push(`сур: ${surahs.length}, ожидалось ${EXPECT_SURAHS}`);
  if (ayat.length !== EXPECT_AYAT)
    problems.push(`аятов: ${ayat.length}, ожидалось ${EXPECT_AYAT}`);

  const pages = new Set(ayat.map((a) => a.page));
  if (pages.size !== EXPECT_PAGES)
    problems.push(`страниц: ${pages.size}, ожидалось ${EXPECT_PAGES}`);

  const juz = new Set(ayat.map((a) => a.juz));
  if (juz.size !== 30) problems.push(`джузов: ${juz.size}, ожидалось 30`);

  const empty = ayat.filter((a) => !a.uthmani?.trim() || !a.plain?.trim());
  if (empty.length) problems.push(`пустой текст у ${empty.length} аятов`);

  for (const s of surahs) {
    const n = ayat.filter((a) => a.surah === s.id).length;
    if (n !== s.ayah_count)
      problems.push(`сура ${s.id}: скачано ${n} аятов, в метаданных ${s.ayah_count}`);
  }
  return problems;
}

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

(async () => {
  console.log(`Источник: ${API}`);
  const surahs = await fetchSurahs();
  const ayat = await fetchAyat();

  const problems = validate(surahs, ayat);
  if (problems.length) {
    console.error("\n❌ Данные не прошли проверку — файл не записан:");
    for (const p of problems) console.error("   • " + p);
    console.error(
      "\nИсточник отдал неполные данные. Попробуй другой: --api-base <url>"
    );
    process.exit(1);
  }

  const lines = [
    "-- Сгенерировано scripts/seed-quran.mjs. Руками не править.",
    "DELETE FROM ayat;",
    "DELETE FROM surahs;",
  ];

  for (const batch of chunk(surahs, 50)) {
    lines.push(
      "INSERT INTO surahs (id,name_ar,name_ru,ayah_count,revelation,page_start) VALUES\n" +
        batch
          .map(
            (s) =>
              `(${s.id},${q(s.name_ar)},${q(s.name_ru)},${s.ayah_count},${q(
                s.revelation
              )},${s.page_start})`
          )
          .join(",\n") +
        ";"
    );
  }

  let n = 0;
  const rows = ayat.map((a) => {
    n++;
    return `(${n},${a.surah},${a.ayah},${a.page},${a.juz},${a.hizb},${q(
      a.uthmani
    )},${q(a.plain)})`;
  });
  for (const batch of chunk(rows, 200)) {
    lines.push(
      "INSERT INTO ayat (n,surah,ayah,page,juz,hizb,text_uthmani,text_plain) VALUES\n" +
        batch.join(",\n") +
        ";"
    );
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");

  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`✅ ${OUT} — ${ayat.length} аятов, ${surahs.length} сур, ${mb} МБ`);
  console.log("   Дальше:  npm run quran:load");
})();
