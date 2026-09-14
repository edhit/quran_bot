import type { Env } from "./env";
import { Db, type User } from "./db";
import { QURAN_PAGES, projection, retrievability, dailyNewTarget } from "./srs";
import { localDate } from "./plan";

export interface Snapshot {
  pagesDone: number;
  percent: number;
  juzDone: number;
  daysElapsed: number;
  pagesPerYear: number;
  yearsLeft: number | null;
  finishYear: number | null;
  onTrack: boolean;
  needPagesPerWeek: number;
  havePagesPerWeek: number;
  streak: number;
  bestStreak: number;
  coverage30: number;   // доля выученного, повторённого за 30 дней
  avgAccuracy: number | null;
  debt: number;
  weakest: { page: number; r: number; lapses: number }[];
}

export async function snapshot(env: Env, d: Db, u: User): Promise<Snapshot> {
  const pagesDone = await d.countMemorized(u.id);
  const pages = await d.memorizedPages(u.id);
  const days = await d.days(u.id, 400);
  const today = localDate(u);

  const startedAt = new Date(u.created_at + "Z").getTime();
  // Если бот заведён недавно, темп считаем по его собственным данным, а не
  // приписываем ему годы, которые ты учил до него.
  const daysElapsed = Math.max(1, (Date.now() - startedAt) / 86_400_000);

  const pagesAddedHere = days.reduce((s: number, x: any) => s + (x.new_done ?? 0), 0);
  const proj = projection(
    pagesAddedHere > 0 ? pagesAddedHere : pagesDone,
    pagesAddedHere > 0 ? daysElapsed : daysElapsed
  );

  const havePagesPerWeek = proj.pagesPerYear / 52.18;
  const need = dailyNewTarget({
    pagesDone,
    goalYears: u.goal_years,
    daysPerWeek: u.days_per_week,
    ayatPerPage: 1,
  });

  const now = Date.now();
  const reviewed30 = pages.filter(
    (p) => p.last_review && now - new Date(p.last_review + "Z").getTime() < 30 * 86_400_000
  ).length;

  const weakest = pages
    .map((p) => ({ page: p.page, r: retrievability(p.stability, p.last_review), lapses: p.lapses }))
    .sort((a, b) => a.r - b.r)
    .slice(0, 5);

  const checks = await d.recentChecks(u.id, 30);
  const avgAccuracy = checks.length
    ? checks.reduce((s: number, c: any) => s + c.accuracy, 0) / checks.length
    : null;

  const { streak, best } = streaks(days.map((x: any) => x.date), today);
  const debt = (await d.debt(u.id, today)).length;

  return {
    pagesDone,
    percent: Number(((pagesDone / QURAN_PAGES) * 100).toFixed(1)),
    juzDone: Number((pagesDone / 20).toFixed(1)),
    daysElapsed: Math.round(daysElapsed),
    pagesPerYear: proj.pagesPerYear,
    yearsLeft: proj.yearsLeft,
    finishYear:
      proj.yearsLeft !== null ? new Date().getFullYear() + Math.ceil(proj.yearsLeft) : null,
    onTrack: proj.yearsLeft !== null ? proj.yearsLeft <= u.goal_years : true,
    needPagesPerWeek: Number(need.pagesPerWeek.toFixed(2)),
    havePagesPerWeek: Number(havePagesPerWeek.toFixed(2)),
    streak,
    bestStreak: best,
    coverage30: pagesDone ? Number(((reviewed30 / pagesDone) * 100).toFixed(0)) : 0,
    avgAccuracy,
    debt,
    weakest,
  };
}

function streaks(dates: string[], today: string): { streak: number; best: number } {
  const set = new Set(dates);
  const day = (s: string, delta: number) =>
    new Date(new Date(s + "T00:00:00Z").getTime() + delta * 86_400_000)
      .toISOString()
      .slice(0, 10);

  let streak = 0;
  let cur = set.has(today) ? today : day(today, -1);
  while (set.has(cur)) {
    streak++;
    cur = day(cur, -1);
  }

  const sorted = [...set].sort();
  let best = 0;
  let run = 0;
  let prev = "";
  for (const dt of sorted) {
    run = prev && day(prev, 1) === dt ? run + 1 : 1;
    best = Math.max(best, run);
    prev = dt;
  }
  return { streak, best: Math.max(best, streak) };
}

export function renderStats(s: Snapshot, u: User): string {
  const bar = (pct: number) => {
    const filled = Math.round(pct / 5);
    return "█".repeat(filled) + "░".repeat(20 - filled);
  };

  const lines = [
    `<b>📊 Где ты сейчас</b>`,
    ``,
    `${bar(s.percent)} ${s.percent}%`,
    `Страниц: <b>${s.pagesDone}</b> из ${QURAN_PAGES}  ·  примерно ${s.juzDone} джуза`,
    ``,
    `<b>Темп</b>`,
    `Набрано с ботом: ${s.pagesPerYear.toFixed(1)} стр./год (${s.havePagesPerWeek} стр./нед.)`,
    `Нужно для цели в ${u.goal_years} лет: ${s.needPagesPerWeek} стр./нед.`,
  ];

  if (s.yearsLeft !== null) {
    lines.push(
      s.onTrack
        ? `✅ При таком темпе закончишь примерно через ${s.yearsLeft} лет — к ${s.finishYear} году. В графике.`
        : `⚠️ При таком темпе останется ещё ${s.yearsLeft} лет (${s.finishYear} год) — цель ${u.goal_years} лет уплывает.`
    );
  } else {
    lines.push(`<i>Темп посчитаю, когда наберётся хотя бы неделя записей.</i>`);
  }

  lines.push(
    ``,
    `<b>Повторение</b>`,
    `Пройдено за 30 дней: ${s.coverage30}% выученного`,
    s.avgAccuracy !== null
      ? `Средняя точность последних проверок: ${Math.round(s.avgAccuracy * 100)}%`
      : `Проверок ещё не было`,
    ``,
    `<b>Дисциплина</b>`,
    `Серия: ${s.streak} дн. подряд (рекорд ${s.bestStreak})`,
    s.debt > 0 ? `❗️ Долг: ${s.debt} невыполненных заданий` : `Долгов нет`
  );

  if (s.weakest.length) {
    lines.push(
      ``,
      `<b>Слабее всего держатся</b>`,
      ...s.weakest.map(
        (w) =>
          `стр. ${w.page} — прочность ${Math.round(w.r * 100)}%` +
          (w.lapses ? ` (срывов: ${w.lapses})` : "")
      )
    );
  }

  return lines.join("\n");
}
