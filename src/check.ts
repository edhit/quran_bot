import type { Env } from "./env";
import { Db, type Ayah } from "./db";
import { normalizeText, summarize, errorList } from "./arabic";
import { askJson } from "./claude";

/**
 * Проверка записи чтения.
 *
 * Что бот РЕАЛЬНО умеет и чего не умеет — важно понимать:
 *   ✅ пропущенные, переставленные и подменённые слова, съезд на похожий аят,
 *      остановки не на месте;
 *   ❌ таджвид (мадд, гунна, махрадж) — распознавание речи приводит звук к
 *      орфографии и эти ошибки просто не доходят до текста.
 *
 * Ещё одна ловушка: распознаватель хорошо знает Коран и склонен «дочитывать»
 * за тебя правильный вариант. Поэтому мы НЕ передаём ему эталонный текст
 * подсказкой (initial_prompt) — иначе он замажет как раз те ошибки, которые
 * мы ищем.
 */

export interface CheckResult {
  accuracy: number;
  wordsTotal: number;
  transcript: string;
  errors: ReturnType<typeof errorList>;
  report: string;
  confusions: { ayah: string; similar: string; note: string }[];
}

const ERROR_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["чисто", "мелкие_запинки", "шатко", "не_держится"],
    },
    summary: { type: "string", description: "2–3 предложения по-русски: что в целом." },
    mistakes: {
      type: "array",
      description: "Разбор каждой значимой ошибки. Максимум 12 штук, самые важные.",
      items: {
        type: "object",
        properties: {
          ayah: { type: "string", description: "Ключ аята, например 6:71" },
          expected: { type: "string", description: "Как в мусхафе" },
          got: { type: "string", description: "Как прочитано" },
          kind: {
            type: "string",
            enum: [
              "пропуск_слова",
              "лишнее_слово",
              "другое_слово",
              "окончание",
              "порядок_слов",
              "переход_на_похожий_аят",
              "шум_распознавания",
            ],
          },
          why: { type: "string", description: "Почему так вышло, по-русски, коротко." },
          fix: { type: "string", description: "Что конкретно сделать, чтобы закрепить." },
          similar_to: {
            type: "string",
            description:
              "Если ошибка — съезд на другое место Корана, ключ того места (например 7:12). Иначе пустая строка.",
          },
        },
        required: ["ayah", "expected", "got", "kind", "why", "fix", "similar_to"],
        additionalProperties: false,
      },
    },
    advice: { type: "string", description: "Один совет на завтра по этому отрывку." },
  },
  required: ["verdict", "summary", "mistakes", "advice"],
  additionalProperties: false,
} as const;

const SYSTEM = `Ты — требовательный, но спокойный учитель Корана. Твой ученик — студент Исламского университета Медины, учит Коран наизусть много лет. Он присылает запись чтения по памяти.

Тебе дают:
1. эталонный текст отрывка,
2. расшифровку записи (автоматическое распознавание речи),
3. готовое пословное сравнение эталона с расшифровкой.

Твоя работа — объяснить ошибки, а не пересчитать их заново: сравнение уже сделано машиной.

Держи в голове границы метода:
— Распознавание речи знает Коран и нередко «исправляет» чтеца. Если расхождение выглядит как артефакт распознавания (одна буква, похожее звучание, слитно/раздельно), помечай kind = "шум_распознавания" и не вини ученика.
— Таджвид по расшифровке НЕ проверяется. Никогда не пиши про мадд, гунну, идгам, махрадж — этих данных у тебя нет.
— Особенно ценно поймать переход на похожий аят (муташабихат): если ученик прочитал слова из другого места Корана, укажи это место в similar_to. Это самая полезная для него находка.

Пиши по-русски, арабские слова — арабицей. Коротко, по делу, без славословий и без нравоучений.`;

export async function checkRecitation(
  env: Env,
  d: Db,
  audio: ArrayBuffer,
  ayat: Ayah[]
): Promise<CheckResult> {
  // ---- 1. Распознавание -------------------------------------------------
  const transcript = await transcribe(env, audio);

  // ---- 2. Пословное сравнение (детерминированно, без модели) -------------
  const refWords = normalizeText(ayat.map((a) => a.text_plain).join(" "));
  const gotWords = normalizeText(transcript);
  const diff = summarize(refWords, gotWords);
  const errors = errorList(diff.ops, refWords);

  const keyOf = (a: Ayah) => `${a.surah}:${a.ayah}`;
  const rangeLabel = `${keyOf(ayat[0])}–${keyOf(ayat[ayat.length - 1])}`;

  // Ничего не нашли — не тратим запрос к модели.
  if (errors.length === 0) {
    return {
      accuracy: diff.accuracy,
      wordsTotal: diff.wordsTotal,
      transcript,
      errors,
      report: "Ошибок по словам не найдено. Читал чисто — закрепляй.",
      confusions: [],
    };
  }

  // Расшифровка пустая или обрывочная — говорим прямо, а не выставляем «0%».
  if (gotWords.length < refWords.length * 0.4) {
    return {
      accuracy: diff.accuracy,
      wordsTotal: diff.wordsTotal,
      transcript,
      errors,
      report:
        "Распознать удалось меньше половины отрывка. Скорее всего дело в записи, а не в чтении: " +
        "запиши ещё раз в тишине, ближе к микрофону и без спешки.",
      confusions: [],
    };
  }

  // ---- 3. Разбор ошибок моделью -----------------------------------------
  const user = [
    `Отрывок: ${rangeLabel}`,
    "",
    "ЭТАЛОН:",
    ...ayat.map((a) => `${keyOf(a)} ${a.text_uthmani}`),
    "",
    "РАСШИФРОВКА ЗАПИСИ:",
    transcript,
    "",
    `ПОСЛОВНОЕ СРАВНЕНИЕ: верно ${diff.exact + diff.near} из ${diff.wordsTotal} слов ` +
      `(${Math.round(diff.accuracy * 100)}%). Расхождения:`,
    ...errors.map(
      (e, i) =>
        `${i + 1}. ${e.type}: ожидалось «${e.expected || "—"}», прочитано «${e.got || "—"}»` +
        (e.context ? ` (после: ${e.context})` : "")
    ),
  ].join("\n");

  type Parsed = {
    verdict: string;
    summary: string;
    mistakes: {
      ayah: string;
      expected: string;
      got: string;
      kind: string;
      why: string;
      fix: string;
      similar_to: string;
    }[];
    advice: string;
  };

  const parsed = await askJson<Parsed>(env, {
    system: SYSTEM,
    user,
    toolName: "razbor_oshibok",
    toolDescription: "Разбор ошибок в чтении Корана по памяти",
    schema: ERROR_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 4000,
    cacheSystem: true,
  });

  if (!parsed) {
    return {
      accuracy: diff.accuracy,
      wordsTotal: diff.wordsTotal,
      transcript,
      errors,
      report: `Найдено расхождений: ${errors.length}. Подробный разбор сейчас недоступен — ошибки перечислены выше.`,
      confusions: [],
    };
  }

  const real = parsed.mistakes.filter((m) => m.kind !== "шум_распознавания");
  const noise = parsed.mistakes.length - real.length;

  const lines: string[] = [];
  lines.push(parsed.summary);
  if (real.length) {
    lines.push("");
    for (const m of real) {
      lines.push(
        `• <b>${m.ayah}</b> — ${m.kind.replace(/_/g, " ")}\n` +
          `  было: ${m.got || "—"}\n` +
          `  надо: ${m.expected || "—"}\n` +
          `  ${m.why}` +
          (m.similar_to ? `\n  ⚠️ похоже на ${m.similar_to} — муташабих` : "")
      );
    }
  }
  if (noise > 0) {
    lines.push("", `<i>Ещё ${noise} расхождений списаны на распознавание — не считаю их ошибками.</i>`);
  }
  lines.push("", `👉 ${parsed.advice}`);

  return {
    accuracy: diff.accuracy,
    wordsTotal: diff.wordsTotal,
    transcript,
    errors,
    report: lines.join("\n"),
    confusions: real
      .filter((m) => m.similar_to)
      .map((m) => ({ ayah: m.ayah, similar: m.similar_to, note: m.why })),
  };
}

/** Whisper на Workers AI. */
async function transcribe(env: Env, audio: ArrayBuffer): Promise<string> {
  const model = env.WHISPER_MODEL || "@cf/openai/whisper-large-v3-turbo";
  const res: any = await env.AI.run(model as any, {
    audio: toBase64(audio),
    language: "ar",
    task: "transcribe",
    // initial_prompt НЕ передаём намеренно: подсказка эталоном заставит
    // распознаватель «дочитать» правильный вариант и спрятать ошибку.
  } as any);
  return (res?.text ?? "").trim();
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
