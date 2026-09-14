/**
 * Движок заучивания и повторения.
 *
 * Единица учёта — СТРАНИЦА мусхафа (604 штуки), а не аят: хафиз держит в
 * памяти страницу целиком, и «уплывает» тоже страница.
 *
 * Классическая мединская схема разделяет три потока, бот их и планирует:
 *   • حفظ جديد   — новое заучивание;
 *   • مراجعة قريبة — ближнее повторение: всё, выученное за последние ~30 дней,
 *     прогоняется каждый день;
 *   • مراجعة بعيدة — дальнее повторение: старое, по кругу за ~30 дней.
 *
 * Прочность страницы моделируем как забывание по экспоненте:
 *     R(t) = exp(-t / S)
 * где S («stability») — в днях, t — дней с последнего повторения.
 * Успешное повторение растягивает S, ошибка — резко сжимает.
 */

export const QURAN_PAGES = 604;

/** Оценка 1..4 по доле верно прочитанных слов. */
export function grade(accuracy: number): 1 | 2 | 3 | 4 {
  if (accuracy >= 0.99) return 4; // чисто
  if (accuracy >= 0.95) return 3; // мелкие запинки
  if (accuracy >= 0.85) return 2; // шатко
  return 1; // не держится
}

/** Текущая прочность страницы: 0..1. */
export function retrievability(stability: number, lastReview: string | null, now = new Date()): number {
  if (!lastReview) return 0;
  const days = (now.getTime() - new Date(lastReview + "Z").getTime()) / 86_400_000;
  if (!isFinite(days) || days < 0) return 1;
  return Math.exp(-days / Math.max(0.5, stability));
}

export interface SrsUpdate {
  stability: number;
  next_review: string;
  lapses: number;
  reps: number;
}

/**
 * Новое состояние страницы после повторения.
 * `targetR` — до какой прочности даём упасть, прежде чем звать повторять.
 */
export function review(
  prev: { stability: number; reps: number; lapses: number },
  accuracy: number,
  targetR = 0.9,
  now = new Date()
): SrsUpdate {
  const g = grade(accuracy);
  let S = Math.max(0.5, prev.stability);
  let lapses = prev.lapses;

  if (g >= 3) {
    // Чем чище прочитано, тем сильнее растягиваем интервал. Потолок — год:
    // Коран всё равно положено прогонять целиком чаще.
    const gain = g === 4 ? 2.3 : 1.6;
    S = Math.min(365, S * gain + 1);
  } else if (g === 2) {
    S = Math.min(365, S * 1.05 + 0.5); // почти не двигаем
  } else {
    S = Math.max(0.5, S * 0.35); // сорвалось — назад к частым повторам
    lapses += 1;
  }

  const intervalDays = S * Math.log(1 / targetR);
  const next = new Date(now.getTime() + Math.max(0.5, intervalDays) * 86_400_000);

  return {
    stability: Number(S.toFixed(3)),
    next_review: next.toISOString().slice(0, 19).replace("T", " "),
    lapses,
    reps: prev.reps + 1,
  };
}

/**
 * Сколько новых аятов в день нужно, чтобы уложиться в цель.
 * Считаем по страницам, потом переводим в аяты через среднюю плотность отрывка.
 */
export function dailyNewTarget(opts: {
  pagesDone: number;
  goalYears: number;
  daysPerWeek: number;
  ayatPerPage: number;
}): { pagesPerWeek: number; ayatPerDay: number } {
  const pagesLeft = Math.max(0, QURAN_PAGES - opts.pagesDone);
  const weeks = Math.max(1, opts.goalYears * 52.18);
  const pagesPerWeek = pagesLeft / weeks;
  const perDay = (pagesPerWeek / Math.max(1, opts.daysPerWeek)) * opts.ayatPerPage;
  return {
    pagesPerWeek: Number(pagesPerWeek.toFixed(2)),
    ayatPerDay: Math.max(1, Math.round(perDay)),
  };
}

/** Сколько лет осталось при нынешнем темпе. */
export function projection(pagesDone: number, daysElapsed: number): {
  pagesPerYear: number;
  yearsLeft: number | null;
} {
  if (daysElapsed < 7 || pagesDone <= 0) return { pagesPerYear: 0, yearsLeft: null };
  const pagesPerYear = (pagesDone / daysElapsed) * 365.25;
  const left = QURAN_PAGES - pagesDone;
  return {
    pagesPerYear: Number(pagesPerYear.toFixed(1)),
    yearsLeft: pagesPerYear > 0 ? Number((left / pagesPerYear).toFixed(1)) : null,
  };
}
