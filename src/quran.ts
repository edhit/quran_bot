import type { Env } from "./env";
import { Db, type Ayah } from "./db";

/**
 * Внешний контент: перевод и тафсир.
 *
 * В репозитории их нет и не будет — бот тянет их из открытого API по запросу и
 * кладёт в твою собственную базу как кэш. Так ты пользуешься источником
 * напрямую, а в коде лежит только арабский текст Корана.
 */

async function cached(d: Db, key: string, load: () => Promise<string | null>): Promise<string | null> {
  const hit = await d.cacheGet(key);
  if (hit !== null) return hit;
  const v = await load();
  if (v) await d.cacheSet(key, v);
  return v;
}

const stripTags = (s: string) =>
  s
    .replace(/<sup[^>]*>.*?<\/sup>/gs, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export async function translation(env: Env, d: Db, a: Ayah): Promise<string | null> {
  const id = env.TRANSLATION_ID || "45";
  return cached(d, `tr:${id}:${a.surah}:${a.ayah}`, async () => {
    try {
      const url =
        `${env.QURAN_API_BASE}/verses/by_key/${a.surah}:${a.ayah}` +
        `?translations=${id}&fields=text_uthmani`;
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) return null;
      const j: any = await r.json();
      const t = j?.verse?.translations?.[0]?.text;
      return t ? stripTags(t) : null;
    } catch {
      return null;
    }
  });
}

export async function tafsir(env: Env, d: Db, a: Ayah): Promise<string | null> {
  const id = env.TAFSIR_ID || "170";
  return cached(d, `tf:${id}:${a.surah}:${a.ayah}`, async () => {
    try {
      const url = `${env.QURAN_API_BASE}/tafsirs/${id}/by_ayah/${a.surah}:${a.ayah}`;
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) return null;
      const j: any = await r.json();
      const t = j?.tafsir?.text;
      return t ? stripTags(t) : null;
    } catch {
      return null;
    }
  });
}

/** Список доступных источников — чтобы выставить точные id в настройках. */
export async function listSources(env: Env): Promise<string> {
  const out: string[] = [];
  for (const [label, path] of [
    ["ПЕРЕВОДЫ", "resources/translations?language=ru"],
    ["ТАФСИРЫ", "resources/tafsirs?language=ru"],
  ] as const) {
    try {
      const r = await fetch(`${env.QURAN_API_BASE}/${path}`, {
        headers: { accept: "application/json" },
      });
      const j: any = await r.json();
      const items: any[] = j?.translations ?? j?.tafsirs ?? [];
      out.push(
        `<b>${label}</b>\n` +
          items
            .filter((i) => i.language_name === "russian" || i.language_name === "russian ")
            .map((i) => `<code>${i.id}</code> — ${i.name} (${i.author_name ?? "—"})`)
            .join("\n")
      );
    } catch {
      out.push(`<b>${label}</b>\nне удалось получить список`);
    }
  }
  return out.join("\n\n") || "Источники недоступны.";
}

// ---------------------------------------------------------------------------
//  Аудио
// ---------------------------------------------------------------------------

export const RECITERS: Record<string, string> = {
  Husary_128kbps: "Хусари — мурат­таль",
  Husary_64kbps: "Хусари — мураттиль (64 kbps)",
  Husary_Mujawwad_128kbps: "Хусари — муджаввад",
  Husary_Muallim_128kbps: "Хусари — муаллим (с повтором за чтецом)",
  Abdul_Basit_Murattal_192kbps: "Абдульбасит — муратталь",
  Minshawy_Murattal_128kbps: "Миншави — муратталь",
  Alafasy_128kbps: "Мишари аль-Афаси",
};

export function ayahAudioUrl(reciter: string, a: Ayah): string {
  const s = String(a.surah).padStart(3, "0");
  const v = String(a.ayah).padStart(3, "0");
  return `https://everyayah.com/data/${reciter}/${s}${v}.mp3`;
}

/** Проверяет, что папка чтеца реально существует на everyayah. */
export async function probeReciter(reciter: string): Promise<boolean> {
  try {
    const r = await fetch(`https://everyayah.com/data/${reciter}/001001.mp3`, {
      method: "HEAD",
    });
    return r.ok;
  } catch {
    return false;
  }
}
