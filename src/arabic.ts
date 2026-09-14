/**
 * Нормализация арабского текста и пословное сравнение.
 *
 * Задача: сопоставить то, что выдал распознаватель речи (современная орфография,
 * без огласовок), с эталоном из базы. Поэтому сравниваем не начертание, а
 * «скелет» слова: снимаем огласовки, знаки вакфа, унифицируем хамзы и алифы.
 */

const DIACRITICS =
  /[ؐ-ًؚ-ٰٟۖ-ۭࣔ-ࣣ࣡-ࣿ]/g;
const TATWEEL = /ـ/g;
const NON_ARABIC = /[^ء-يٱ\s]/g; // цифры, знаки аята ۝, латиница

/** Приводит слово к форме, по которой сравниваем. */
export function normalizeWord(w: string): string {
  return w
    .replace(DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(NON_ARABIC, "")
    .replace(/[آأإٱ]/g, "ا") // آ أ إ ٱ → ا
    .replace(/ؤ/g, "و") // ؤ → و
    .replace(/ئ/g, "ي") // ئ → ي
    .replace(/ى/g, "ي") // ى → ي
    .replace(/ة/g, "ه") // ة → ه
    .trim();
}

export function normalizeText(s: string): string[] {
  return s
    .split(/\s+/)
    .map(normalizeWord)
    .filter((w) => w.length > 0);
}

/** Расстояние Левенштейна — чтобы отличить описку распознавания от реальной ошибки. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Похожи ли слова настолько, что это скорее шум распознавания, чем ошибка хифза. */
export function nearMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const d = levenshtein(a, b);
  const len = Math.max(a.length, b.length);
  return len >= 4 ? d <= 1 : false;
}

export type Op =
  | { op: "eq"; ref: string; got: string; i: number }
  | { op: "near"; ref: string; got: string; i: number }
  | { op: "sub"; ref: string; got: string; i: number }
  | { op: "del"; ref: string; i: number }          // пропустил слово
  | { op: "ins"; got: string; i: number };         // добавил лишнее

/**
 * Пословное выравнивание через LCS. Длина отрывка — максимум несколько сотен
 * слов, поэтому квадратичная сложность здесь не проблема.
 */
export function diffWords(ref: string[], got: string[]): Op[] {
  const n = ref.length;
  const m = got.length;
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = nearMatch(ref[i], got[j])
        ? L[i + 1][j + 1] + 1
        : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (nearMatch(ref[i], got[j])) {
      ops.push({
        op: ref[i] === got[j] ? "eq" : "near",
        ref: ref[i],
        got: got[j],
        i,
      });
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      // слово эталона не нашло пары — либо пропуск, либо замена
      if (j < m && !nearMatch(ref[i], got[j]) && i + 1 < n && nearMatch(ref[i + 1], got[j + 1] ?? "")) {
        ops.push({ op: "sub", ref: ref[i], got: got[j], i });
        i++;
        j++;
      } else {
        ops.push({ op: "del", ref: ref[i], i });
        i++;
      }
    } else {
      ops.push({ op: "ins", got: got[j], i });
      j++;
    }
  }
  while (i < n) ops.push({ op: "del", ref: ref[i], i: i++ });
  while (j < m) ops.push({ op: "ins", got: got[j], i: n });

  return ops;
}

export interface DiffSummary {
  ops: Op[];
  wordsTotal: number;
  exact: number;
  near: number;
  errors: Op[];
  /** Доля верно прочитанных слов эталона: 0..1 */
  accuracy: number;
}

export function summarize(ref: string[], got: string[]): DiffSummary {
  const ops = diffWords(ref, got);
  const exact = ops.filter((o) => o.op === "eq").length;
  const near = ops.filter((o) => o.op === "near").length;
  const errors = ops.filter((o) => o.op === "sub" || o.op === "del" || o.op === "ins");
  const total = ref.length || 1;
  // «near» считаем верным: это почти всегда погрешность распознавания.
  const accuracy = Math.max(0, Math.min(1, (exact + near) / total));
  return { ops, wordsTotal: ref.length, exact, near, errors, accuracy };
}

/**
 * Ошибки в виде, пригодном для показа и для передачи в Claude.
 * `context` — несколько верных слов перед ошибкой, чтобы было видно место.
 */
export function errorList(ops: Op[], ref: string[], limit = 40) {
  const out: { type: string; expected: string; got: string; context: string; index: number }[] = [];
  for (const o of ops) {
    if (o.op === "eq" || o.op === "near") continue;
    const idx = o.i;
    const context = ref.slice(Math.max(0, idx - 3), idx).join(" ");
    if (o.op === "sub") {
      out.push({ type: "замена", expected: o.ref, got: o.got, context, index: idx });
    } else if (o.op === "del") {
      out.push({ type: "пропуск", expected: o.ref, got: "", context, index: idx });
    } else {
      out.push({ type: "лишнее", expected: "", got: o.got, context, index: idx });
    }
    if (out.length >= limit) break;
  }
  return out;
}
