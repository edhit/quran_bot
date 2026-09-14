import type { Env } from "./env";
import { Db, type Task, type User } from "./db";
import { QURAN_PAGES, dailyNewTarget, retrievability } from "./srs";

/** Локальная дата пользователя в виде YYYY-MM-DD. */
export function localDate(u: { tz_offset: number }, now = new Date()): string {
  return new Date(now.getTime() + u.tz_offset * 60_000).toISOString().slice(0, 10);
}

export function localHour(u: { tz_offset: number }, now = new Date()): number {
  return new Date(now.getTime() + u.tz_offset * 60_000).getUTCHours();
}

/**
 * Собирает план на день, если он ещё не собран.
 * Порядок потоков: новое → ближнее повторение → слабые места → дальнее.
 */
export async function buildPlan(env: Env, d: Db, u: User): Promise<Task[]> {
  const date = localDate(u);
  const existing = await d.tasksForDay(u.id, date);
  if (existing.length) return existing;

  const totalAyat = await d.totalAyat();
  if (!totalAyat) return []; // база Корана не залита

  const pagesDone = await d.countMemorized(u.id);
  const ayatPerPage = totalAyat / QURAN_PAGES;

  // ---- 1. Новое заучивание ----------------------------------------------
  const perDay =
    u.new_ayat_per_day > 0
      ? u.new_ayat_per_day
      : dailyNewTarget({
          pagesDone,
          goalYears: u.goal_years,
          daysPerWeek: u.days_per_week,
          ayatPerPage,
        }).ayatPerDay;

  const cursor = await d.ayahByKey(u.cursor_surah, u.cursor_ayah);
  if (cursor) {
    const toN = Math.min(totalAyat, cursor.n + perDay - 1);
    await d.addTask(u.id, date, "new", cursor.page, cursor.n, toN);
  }

  // ---- 2. Ближнее повторение: всё свежее, каждый день ---------------------
  const memorized = await d.memorizedPages(u.id);
  const nearCutoff = Date.now() - u.near_window_days * 86_400_000;
  const near = memorized.filter(
    (p) => p.memorized_at && new Date(p.memorized_at + "Z").getTime() >= nearCutoff
  );
  for (const p of near.slice(0, 6)) {
    const ayat = await d.pageAyat(p.page);
    if (ayat.length) {
      await d.addTask(u.id, date, "near", p.page, ayat[0].n, ayat[ayat.length - 1].n);
    }
  }

  // ---- 3. Дальнее повторение: старое по кругу ----------------------------
  const nearPages = new Set(near.map((p) => p.page));
  const far = memorized.filter((p) => !nearPages.has(p.page));
  if (far.length) {
    const perDayFar = Math.max(1, Math.ceil(far.length / Math.max(1, u.far_cycle_days)));
    // Сначала то, что сильнее всего выветрилось.
    const ranked = far
      .map((p) => ({ p, r: retrievability(p.stability, p.last_review) }))
      .sort((a, b) => a.r - b.r)
      .slice(0, perDayFar);

    for (const { p } of ranked) {
      const ayat = await d.pageAyat(p.page);
      if (ayat.length) {
        const kind = p.lapses >= 2 ? "weak" : "far";
        await d.addTask(u.id, date, kind, p.page, ayat[0].n, ayat[ayat.length - 1].n);
      }
    }
  }

  return d.tasksForDay(u.id, date);
}

export const KIND_LABEL: Record<Task["kind"], string> = {
  new: "🆕 Новое",
  near: "🔁 Ближнее повторение",
  far: "📚 Дальнее повторение",
  weak: "⚠️ Слабое место",
  connect: "🔗 Связка",
};

/** Текст отрывка задачи в виде «6:71–6:75 (стр. 137)». */
export async function taskLabel(d: Db, t: Task): Promise<string> {
  const a = await d.ayahByN(t.from_n);
  const b = await d.ayahByN(t.to_n);
  if (!a || !b) return "отрывок";
  const sur = await d.surahName(a.surah);
  const name = sur?.name_ru ?? `сура ${a.surah}`;
  const range =
    a.surah === b.surah
      ? `${a.surah}:${a.ayah}–${b.ayah}`
      : `${a.surah}:${a.ayah} – ${b.surah}:${b.ayah}`;
  const pages = a.page === b.page ? `стр. ${a.page}` : `стр. ${a.page}–${b.page}`;
  return `${name} ${range} (${pages})`;
}

/**
 * Отмечает задачу выполненной: двигает курсор заучивания, обновляет
 * состояние страниц, пишет в дневник.
 */
export async function completeTask(
  d: Db,
  u: User,
  t: Task,
  accuracy: number | null
): Promise<void> {
  const date = localDate(u);
  await d.closeTask(t.id, "done", accuracy);

  if (t.kind === "new") {
    const last = await d.ayahByN(t.to_n);
    const next = await d.ayahByN(t.to_n + 1);
    if (next) {
      await d.updateUser(u.id, { cursor_surah: next.surah, cursor_ayah: next.ayah });
    }
    // Страница считается выученной, когда её последний аят пройден.
    if (last) {
      const pageAyat = await d.pageAyat(last.page);
      const lastOfPage = pageAyat[pageAyat.length - 1];
      const done = Math.min(pageAyat.length, pageAyat.filter((a) => a.n <= t.to_n).length);
      await d.upsertPage(u.id, last.page, { ayat_done: done });
      if (lastOfPage && t.to_n >= lastOfPage.n) {
        const existing = await d.page(u.id, last.page);
        if (existing?.status !== "memorized") {
          await d.upsertPage(u.id, last.page, {
            status: "memorized",
            memorized_at: new Date().toISOString().slice(0, 19).replace("T", " "),
            stability: 1,
            last_review: new Date().toISOString().slice(0, 19).replace("T", " "),
          });
        }
      }
    }
    await d.bumpDay(u.id, date, { new_done: 1 });
  } else {
    await d.bumpDay(u.id, date, { reviews: 1 });
  }
}
