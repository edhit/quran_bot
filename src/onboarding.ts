import type { Env } from "./env";
import { Db, type User } from "./db";
import { tg } from "./telegram";
import { MENU } from "./ui";
import { QURAN_PAGES, dailyNewTarget } from "./srs";

/**
 * Пошаговый мастер: при первом запуске и по команде /settings.
 * Состояние шага лежит в users.state, так что Worker остаётся без памяти.
 */

interface Step {
  key: string;
  ask: string;
  parse: (input: string) => Partial<User> | null;
}

const STEPS: Step[] = [
  {
    key: "name",
    ask: "Как к тебе обращаться?",
    parse: (s) => (s.trim() ? { name: s.trim().slice(0, 40) } : null),
  },
  {
    key: "cursor",
    ask:
      "На каком месте ты сейчас в заучивании? Напиши сурой и аятом — например <code>6:71</code>.\n\n" +
      "Это место, с которого начнётся <b>новое</b>. Всё до него бот считает выученным и поставит в повторение.",
    parse: (s) => {
      const m = s.match(/(\d+)\s*[:\s]\s*(\d+)/);
      if (!m) return null;
      const surah = Number(m[1]);
      const ayah = Number(m[2]);
      if (surah < 1 || surah > 114 || ayah < 1) return null;
      return { cursor_surah: surah, cursor_ayah: ayah };
    },
  },
  {
    key: "tz",
    ask:
      "Часовой пояс — сдвиг от UTC в часах.\n" +
      "Медина: <code>3</code>, Москва: <code>3</code>, Ташкент: <code>5</code>.",
    parse: (s) => {
      const h = Number(s.replace(",", ".").trim());
      if (!isFinite(h) || h < -12 || h > 14) return null;
      return { tz_offset: Math.round(h * 60) };
    },
  },
  {
    key: "goal",
    ask: "За сколько лет хочешь закончить весь Коран? Напиши число, например <code>11</code>.",
    parse: (s) => {
      const y = Number(s.replace(",", ".").trim());
      if (!isFinite(y) || y < 0.5 || y > 40) return null;
      return { goal_years: y };
    },
  },
  {
    key: "days",
    ask: "Сколько дней в неделю реально занимаешься? <code>5</code>, <code>6</code> или <code>7</code>.",
    parse: (s) => {
      const n = Number(s.trim());
      if (!Number.isInteger(n) || n < 1 || n > 7) return null;
      return { days_per_week: n };
    },
  },
  {
    key: "plan_hour",
    ask: "Во сколько присылать план на день? Час по-твоему местному времени, например <code>5</code>.",
    parse: (s) => {
      const h = Number(s.trim());
      if (!Number.isInteger(h) || h < 0 || h > 23) return null;
      return { plan_hour: h };
    },
  },
  {
    key: "nudge_hour",
    ask: "А во сколько проверять, сделал ли ты сегодня хоть что-то? Например <code>21</code>.",
    parse: (s) => {
      const h = Number(s.trim());
      if (!Number.isInteger(h) || h < 0 || h > 23) return null;
      return { nudge_hour: h };
    },
  },
];

export async function startOnboarding(
  env: Env,
  d: Db,
  user: User,
  flow: "onboarding" | "settings" = "onboarding"
): Promise<void> {
  const bot = tg(env);
  if (flow === "onboarding") {
    await bot.send(
      user.id,
      "Ассаламу алейкум.\n\nЯ буду вести твой хифз: давать новое, гонять повторение, " +
        "проверять чтение по записи и показывать, укладываешься ли ты в свой срок.\n\n" +
        "Семь вопросов — и начнём.",
      { keyboard: MENU }
    );
  }
  await d.setState(user.id, { flow, step: 0 });
  await bot.send(user.id, `<b>1/${STEPS.length}.</b> ${STEPS[0].ask}`);
}

export async function runOnboarding(env: Env, d: Db, user: User, input: string): Promise<void> {
  const bot = tg(env);
  const st = JSON.parse(user.state!) as { flow: "onboarding" | "settings"; step: number };
  const step = STEPS[st.step];

  if (input.toLowerCase() === "/cancel") {
    await d.setState(user.id, null);
    await bot.send(user.id, "Отменил.", { keyboard: MENU });
    return;
  }

  const patch = step.parse(input);
  if (!patch) {
    await bot.send(user.id, "Не разобрал. Попробуй ещё раз — или /cancel.");
    return;
  }

  await d.updateUser(user.id, patch);

  const nextStep = st.step + 1;
  if (nextStep < STEPS.length) {
    await d.setState(user.id, { flow: st.flow, step: nextStep });
    await bot.send(user.id, `<b>${nextStep + 1}/${STEPS.length}.</b> ${STEPS[nextStep].ask}`);
    return;
  }

  await d.setState(user.id, null);
  const fresh = (await d.user(user.id))!;
  if (st.flow === "onboarding") {
    await seedProgress(d, fresh);
  }
  await bot.send(user.id, await summary(d, fresh), { keyboard: MENU });
}

/**
 * Всё, что идёт до курсора, помечаем выученным и ставим в очередь дальнего
 * повторения. Прочность задаём низкой: бот не знает, как эти страницы держатся,
 * и в первые недели прогонит их все — заодно выяснит, где дыры.
 */
async function seedProgress(d: Db, u: User): Promise<void> {
  const cursor = await d.ayahByKey(u.cursor_surah, u.cursor_ayah);
  if (!cursor) return;

  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const lastFullPage = cursor.page - 1;

  for (let p = 1; p <= lastFullPage; p++) {
    await d.upsertPage(u.id, p, {
      status: "memorized",
      memorized_at: stamp,
      stability: 3,          // осторожная оценка: прогоним и уточним
      last_review: stamp,
      reps: 0,
    });
  }
}

async function summary(d: Db, u: User): Promise<string> {
  const pagesDone = await d.countMemorized(u.id);
  const cursor = await d.ayahByKey(u.cursor_surah, u.cursor_ayah);
  const totalAyat = (await d.totalAyat()) || 6236;

  const need = dailyNewTarget({
    pagesDone,
    goalYears: u.goal_years,
    daysPerWeek: u.days_per_week,
    ayatPerPage: totalAyat / QURAN_PAGES,
  });

  return [
    `<b>Готово.</b>`,
    ``,
    `Ты на ${u.cursor_surah}:${u.cursor_ayah}${cursor ? ` — страница ${cursor.page}, джуз ${cursor.juz}` : ""}.`,
    `Выучено: <b>${pagesDone}</b> из ${QURAN_PAGES} страниц (${((pagesDone / QURAN_PAGES) * 100).toFixed(1)}%).`,
    ``,
    `Чтобы закончить за ${u.goal_years} лет при ${u.days_per_week} днях в неделю, нужно:`,
    `• <b>${need.pagesPerWeek}</b> страницы в неделю`,
    `• примерно <b>${need.ayatPerDay}</b> аята в день`,
    ``,
    `План приходит в ${u.plan_hour}:00, проверка — в ${u.nudge_hour}:00.`,
    ``,
    `Начнём: /plan`,
  ].join("\n");
}
