import type { Env } from "./env";
import { Db, type Ayah } from "./db";
import { askJson, askText } from "./claude";

/**
 * Арабский — не отдельным курсом, а из того, что ты сейчас учишь наизусть.
 * Слова текущего отрывка разбираются один раз, кладутся в кэш и попадают в
 * словарь с собственным повторением (SM-2).
 */

const WORDS_SCHEMA = {
  type: "object",
  properties: {
    words: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string", description: "Слово как в аяте, арабицей" },
          root: { type: "string", description: "Корень, три-четыре буквы через пробел" },
          meaning: { type: "string", description: "Значение здесь, по-русски, 1–4 слова" },
          note: {
            type: "string",
            description:
              "Грамматика одной строкой: часть речи, форма, падеж/наклонение. Пусто, если нечего сказать.",
          },
          frequency: {
            type: "string",
            enum: ["частое", "среднее", "редкое"],
            description: "Насколько часто корень встречается в Коране",
          },
        },
        required: ["word", "root", "meaning", "note", "frequency"],
        additionalProperties: false,
      },
    },
  },
  required: ["words"],
  additionalProperties: false,
} as const;

const SYSTEM = `Ты преподаёшь коранический арабский студенту Исламского университета Медины. Он учит Коран наизусть и хочет понимать то, что заучивает.

Разбирай каждое знаменательное слово аята: частицы и предлоги пропускай, если они не несут смысловой нагрузки в этом месте. Значение давай ТО, которое слово имеет здесь, а не список словарных.

Грамматику пиши предельно сжато и общепринятой терминологией (масдар, маджзум, мансуб, страдательный залог, форма II и т. п.). По-русски, арабские слова — арабицей. Без вступлений.`;

export interface WordItem {
  word: string;
  root: string;
  meaning: string;
  note: string;
  frequency: string;
}

export async function analyzeAyah(env: Env, d: Db, a: Ayah): Promise<WordItem[]> {
  const key = `words:${a.surah}:${a.ayah}`;
  const hit = await d.cacheGet(key);
  if (hit) return JSON.parse(hit) as WordItem[];

  const parsed = await askJson<{ words: WordItem[] }>(env, {
    system: SYSTEM,
    user: `Аят ${a.surah}:${a.ayah}\n\n${a.text_uthmani}`,
    toolName: "razbor_slov",
    toolDescription: "Пословный разбор аята",
    schema: WORDS_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 3000,
    cacheSystem: true,
  });

  const words = parsed?.words ?? [];
  if (words.length) await d.cacheSet(key, JSON.stringify(words));
  return words;
}

export async function stockUp(env: Env, d: Db, userId: number, ayat: Ayah[]): Promise<number> {
  let added = 0;
  for (const a of ayat.slice(0, 5)) {
    const words = await analyzeAyah(env, d, a);
    for (const w of words) {
      if (w.frequency === "редкое") continue; // редкое учить наизусть смысла мало
      await d.addWord(userId, {
        word: w.word,
        root: w.root,
        meaning: w.meaning,
        note: w.note,
        ayah_key: `${a.surah}:${a.ayah}`,
      });
      added++;
    }
  }
  return added;
}

export function renderWords(a: Ayah, words: WordItem[]): string {
  if (!words.length) return "Разбор не получился, попробуй ещё раз.";
  const rows = words.map(
    (w) =>
      `<b>${w.word}</b> — ${w.meaning}` +
      (w.root ? `\n   корень: ${w.root}` : "") +
      (w.note ? `\n   <i>${w.note}</i>` : "")
  );
  return `<b>${a.surah}:${a.ayah}</b>\n${a.text_uthmani}\n\n${rows.join("\n\n")}`;
}

/** SM-2 для слов. quality: 0 — не знал, 1 — вспомнил с трудом, 2 — знал. */
export function nextWordState(
  prev: { interval: number; ease: number; reps: number; lapses: number },
  quality: 0 | 1 | 2
): { interval: number; ease: number; reps: number; lapses: number; due: string } {
  let { interval, ease, reps, lapses } = prev;

  if (quality === 0) {
    reps = 0;
    lapses += 1;
    interval = 0;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    ease = Math.min(2.8, ease + (quality === 2 ? 0.1 : -0.05));
    reps += 1;
    interval = reps === 1 ? 1 : reps === 2 ? 4 : Math.round(interval * ease);
    interval = Math.min(365, Math.max(1, interval));
  }

  const due = new Date(Date.now() + interval * 86_400_000).toISOString().slice(0, 10);
  return { interval, ease, reps, lapses, due };
}

export async function explainGrammar(env: Env, a: Ayah): Promise<string> {
  return askText(
    env,
    SYSTEM,
    `Разбери грамматику аята ${a.surah}:${a.ayah} — по членам предложения (иʿраб), с опорой на то, ` +
      `что студент уже знает основы нахва. Максимум 15 строк.\n\n${a.text_uthmani}`,
    2500
  );
}
