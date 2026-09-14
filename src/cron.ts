import type { Env } from "./env";
import { db, type Db, type User } from "./db";
import { tg } from "./telegram";
import { buildPlan, localDate, localHour, KIND_LABEL, taskLabel } from "./plan";
import { snapshot, renderStats } from "./stats";
import { nudgeText } from "./ui";
import { QURAN_PAGES } from "./srs";

/**
 * Крон дёргается каждые 15 минут. Для каждого пользователя смотрим его
 * локальное время: совпал час плана — шлём план, час проверки — проверяем,
 * сделал ли он сегодня хоть что-нибудь.
 */
export async function tick(env: Env): Promise<void> {
  const d = db(env);
  const users = await d.allUsers();
  const now = new Date();

  for (const u of users) {
    try {
      const hour = localHour(u, now);
      const minute = now.getUTCMinutes();

      // Шлём один раз в час — в первую четверть.
      if (minute >= 15) continue;

      if (hour === u.plan_hour) await morningPlan(env, d, u);
      else if (hour === u.nudge_hour) await eveningCheck(env, d, u);

      // Пятничный отчёт — в час вечерней проверки.
      const weekday = new Date(now.getTime() + u.tz_offset * 60_000).getUTCDay();
      if (hour === u.nudge_hour && weekday === 5) await weeklyReport(env, d, u);
    } catch (e) {
      console.error(`cron: пользователь ${u.id}:`, e);
    }
  }
}

async function morningPlan(env: Env, d: Db, u: User): Promise<void> {
  const bot = tg(env);
  const tasks = await buildPlan(env, d, u);
  const open = tasks.filter((t) => t.status === "open");
  if (!open.length) return;

  const date = localDate(u);
  const debt = await d.debt(u.id, date);
  const s = await snapshot(env, d, u);

  const head = [
    `<b>🌅 План на ${date}</b>`,
    `Серия: ${s.streak} дн.  ·  ${s.pagesDone}/${QURAN_PAGES} стр. (${s.percent}%)`,
  ];
  if (debt.length) head.push(`❗️ Хвост: ${debt.length} заданий с прошлых дней`);

  await bot.send(u.id, head.join("\n"));

  const { taskButtons } = await import("./ui");
  for (const t of open) {
    await bot.send(u.id, `${KIND_LABEL[t.kind]}\n<b>${await taskLabel(d, t)}</b>`, {
      buttons: taskButtons(t.id),
    });
  }
}

async function eveningCheck(env: Env, d: Db, u: User): Promise<void> {
  const bot = tg(env);
  const date = localDate(u);
  const tasks = await d.tasksForDay(u.id, date);
  const done = tasks.filter((t) => t.status === "done").length;

  if (done > 0) {
    const s = await snapshot(env, d, u);
    await bot.send(
      u.id,
      `Сегодня закрыто: ${done} из ${tasks.length}. Серия: ${s.streak} дн. 🤲`
    );
    return;
  }

  // Считаем, сколько дней подряд пусто.
  const days = await d.days(u.id, 10);
  const active = new Set(
    days.filter((x: any) => (x.new_done ?? 0) + (x.reviews ?? 0) > 0).map((x: any) => x.date)
  );
  let missed = 0;
  for (let i = 0; i < 10; i++) {
    const dt = new Date(new Date(date + "T00:00:00Z").getTime() - i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (active.has(dt)) break;
    missed++;
  }

  const debt = (await d.debt(u.id, date)).length + tasks.filter((t) => t.status === "open").length;
  await bot.send(u.id, nudgeText(missed - 1, debt));
}

async function weeklyReport(env: Env, d: Db, u: User): Promise<void> {
  const bot = tg(env);
  const s = await snapshot(env, d, u);
  const text = `<b>📅 Итоги недели</b>\n\n` + renderStats(s, u);

  await bot.send(u.id, text);

  // Мухасаба: тот же отчёт уходит человеку, перед которым тебе не всё равно.
  const partner = u.partner_chat_id || env.PARTNER_CHAT_ID;
  if (partner) {
    await bot
      .send(partner, `<b>Отчёт: ${u.name ?? "студент"}</b>\n\n${renderStats(s, u)}`)
      .catch(() => {});
  }
}
