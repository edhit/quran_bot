import type { Env } from "./env";
import { Db, db, type User, type Task } from "./db";
import { tg, esc, type TgUpdate, type TgMessage, type TgCallback } from "./telegram";
import { buildPlan, completeTask, KIND_LABEL, localDate, taskLabel } from "./plan";
import { checkRecitation } from "./check";
import { review } from "./srs";
import { snapshot, renderStats } from "./stats";
import { translation, tafsir, ayahAudioUrl, listSources, probeReciter, RECITERS } from "./quran";
import { analyzeAyah, renderWords, explainGrammar, nextWordState, stockUp } from "./vocab";
import { MENU, HELP, taskButtons, PRAISE } from "./ui";
import { runOnboarding, startOnboarding } from "./onboarding";

export async function handleUpdate(env: Env, u: TgUpdate): Promise<void> {
  if (u.message) return handleMessage(env, u.message);
  if (u.callback_query) return handleCallback(env, u.callback_query);
}

// ===========================================================================
//  Сообщения
// ===========================================================================

async function handleMessage(env: Env, m: TgMessage): Promise<void> {
  const bot = tg(env);
  const d = db(env);
  const chatId = m.chat.id;

  // Бот личный: чужих не пускаем.
  const owner = Number(env.OWNER_ID || 0);
  if (owner && chatId !== owner) {
    await bot.send(chatId, "Это личный бот. Разверни свой: github.com/edhit/quran_bot");
    return;
  }

  let user = await d.user(chatId);
  const text = (m.text ?? "").trim();

  if (!user) {
    user = await d.createUser(chatId, m.from?.first_name ?? null);
    await startOnboarding(env, d, user);
    return;
  }

  // Незакрытый мастер настройки перехватывает ввод.
  if (user.state) {
    const st = JSON.parse(user.state) as { flow?: string };
    if (st.flow === "onboarding" || st.flow === "settings") {
      await runOnboarding(env, d, user, text);
      return;
    }
    if (st.flow === "await_voice" && (m.voice || m.audio || m.video_note)) {
      await handleVoice(env, d, user, m, (st as any).taskId ?? null);
      return;
    }
  }

  if (m.voice || m.audio || m.video_note) {
    await handleVoice(env, d, user, m, null);
    return;
  }

  if (!text) return;

  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, "");
  const arg = rest.join(" ");

  switch (cmd) {
    case "/start":
    case "/help":
      await bot.send(chatId, HELP, { keyboard: MENU });
      return;

    case "/plan":
    case "📋":
      await sendPlan(env, d, user);
      return;

    case "/check":
      await bot.send(
        chatId,
        "Пришли голосовое с чтением по памяти. Если это по заданию из плана — жми «🎙 Прочитать» под нужной строчкой, тогда я буду знать, с чем сверять."
      );
      return;

    case "/ayah":
      await sendAyah(env, d, user, arg);
      return;

    case "/words":
      await sendWords(env, d, user, arg);
      return;

    case "/grammar":
      await sendGrammar(env, d, user, arg);
      return;

    case "/drill":
      await sendDrill(env, d, user);
      return;

    case "/stats":
      await sendStats(env, d, user);
      return;

    case "/mistakes":
      await sendConfusions(env, d, user);
      return;

    case "/settings":
      await startOnboarding(env, d, user, "settings");
      return;

    case "/sources":
      await bot.send(chatId, await listSources(env));
      return;

    case "/reciter":
      await sendReciters(env, user);
      return;

    case "/pause":
      await d.updateUser(user.id, { paused: 1 });
      await bot.send(chatId, "Поставил на паузу. Напоминаний не будет. Вернуться: /resume");
      return;

    case "/resume":
      await d.updateUser(user.id, { paused: 0 });
      await bot.send(chatId, "С возвращением. /plan");
      return;
  }

  // Кнопки нижнего меню
  if (text.includes("План")) return sendPlan(env, d, user);
  if (text.includes("Проверить")) {
    await bot.send(chatId, "Жду голосовое с чтением.");
    return;
  }
  if (text.includes("Статистика")) return sendStats(env, d, user);
  if (text.includes("Настройки")) return startOnboarding(env, d, user, "settings");
  if (text.includes("Арабский")) return sendDrill(env, d, user);
  if (text.includes("Аят")) {
    await bot.send(chatId, "Напиши: /ayah 6:71");
    return;
  }
  if (/^\d+:\d+$/.test(text)) return sendAyah(env, d, user, text);

  await bot.send(chatId, "Не понял. /help — список команд.");
}

// ===========================================================================
//  Кнопки
// ===========================================================================

async function handleCallback(env: Env, c: TgCallback): Promise<void> {
  const bot = tg(env);
  const d = db(env);
  const chatId = c.message?.chat.id ?? c.from.id;
  const user = await d.user(chatId);
  if (!user) return;

  const [action, raw] = (c.data ?? "").split(":");
  const id = Number(raw);

  switch (action) {
    case "rec": {
      await d.setState(user.id, { flow: "await_voice", taskId: id });
      await bot.answerCallback(c.id);
      const t = await d.task(id);
      await bot.send(
        chatId,
        t
          ? `Жду голосовое: <b>${esc(await taskLabel(d, t))}</b>\nЧитай по памяти, не подглядывая.`
          : "Жду голосовое."
      );
      return;
    }

    case "txt": {
      const t = await d.task(id);
      if (!t) return void bot.answerCallback(c.id, "Задание не найдено");
      const ayat = await d.range(t.from_n, t.to_n);
      await bot.answerCallback(c.id);
      await bot.send(
        chatId,
        `<b>${esc(await taskLabel(d, t))}</b>\n\n` +
          ayat.map((a) => `${esc(a.text_uthmani)}  <code>${a.ayah}</code>`).join("\n")
      );
      return;
    }

    case "aud": {
      const t = await d.task(id);
      if (!t) return void bot.answerCallback(c.id, "Задание не найдено");
      await bot.answerCallback(c.id, "Отправляю…");
      const ayat = await d.range(t.from_n, t.to_n);
      for (const a of ayat.slice(0, 12)) {
        await bot.sendAudio(
          chatId,
          ayahAudioUrl(env.RECITER || "Husary_128kbps", a),
          `${a.surah}:${a.ayah}`
        );
      }
      if (ayat.length > 12) {
        await bot.send(chatId, `<i>Показал первые 12 аятов из ${ayat.length}.</i>`);
      }
      return;
    }

    case "trn": {
      const t = await d.task(id);
      if (!t) return void bot.answerCallback(c.id, "Задание не найдено");
      await bot.answerCallback(c.id);
      const ayat = await d.range(t.from_n, t.to_n);
      const parts: string[] = [];
      for (const a of ayat.slice(0, 10)) {
        const tr = await translation(env, d, a);
        parts.push(`<b>${a.surah}:${a.ayah}</b> ${tr ? esc(tr) : "<i>перевод недоступен</i>"}`);
      }
      await bot.send(chatId, parts.join("\n\n"));
      return;
    }

    case "done": {
      const t = await d.task(id);
      if (!t || t.status === "done") return void bot.answerCallback(c.id, "Уже закрыто");
      await completeTask(d, user, t, null);
      if (t.page) await applyReview(d, user.id, t.page, 0.95);
      await bot.answerCallback(c.id, "Отмечено");
      await bot.send(chatId, PRAISE[Math.floor(Math.random() * PRAISE.length)]);
      return;
    }

    case "skip": {
      await bot.answerCallback(c.id, "Отложено");
      return;
    }

    case "ayd": {
      const a = await d.ayahByN(id);
      await bot.answerCallback(c.id, "Отправляю…");
      if (a) await bot.sendAudio(chatId, ayahAudioUrl(env.RECITER || "Husary_128kbps", a), `${a.surah}:${a.ayah}`);
      return;
    }

    case "ayw": {
      const a = await d.ayahByN(id);
      if (!a) return void bot.answerCallback(c.id, "Не нашёл аят");
      await bot.answerCallback(c.id);
      await bot.sendChatAction(chatId, "typing");
      await bot.send(chatId, renderWords(a, await analyzeAyah(env, d, a)));
      return;
    }

    case "ayt": {
      const a = await d.ayahByN(id);
      if (!a) return void bot.answerCallback(c.id, "Не нашёл аят");
      await bot.answerCallback(c.id);
      const tf = await tafsir(env, d, a);
      await bot.send(
        chatId,
        tf
          ? `<b>Тафсир ${a.surah}:${a.ayah}</b>\n\n${esc(tf.slice(0, 3500))}`
          : "Тафсир для этого аята недоступен. Проверь id источника: /sources"
      );
      return;
    }

    case "w": {
      // Карточка словаря: w:<id>:<quality>
      const [, wid, q] = (c.data ?? "").split(":");
      await gradeWord(env, d, user, Number(wid), Number(q) as 0 | 1 | 2, c.id);
      return;
    }

    case "rc": {
      const name = (c.data ?? "").slice(3);
      const ok = await probeReciter(name);
      await bot.answerCallback(c.id);
      if (!ok) {
        await bot.send(chatId, `Папка <code>${esc(name)}</code> не отвечает на everyayah.com.`);
        return;
      }
      await bot.send(
        chatId,
        `Чтец проверен и доступен: <b>${esc(RECITERS[name] ?? name)}</b>\n\n` +
          `Чтобы закрепить, поменяй в <code>wrangler.toml</code>:\n<code>RECITER = "${esc(name)}"</code>\nи выполни <code>npm run deploy</code>.`
      );
      return;
    }
  }
}

// ===========================================================================
//  Экраны
// ===========================================================================

export async function sendPlan(env: Env, d: Db, user: User): Promise<void> {
  const bot = tg(env);
  const total = await d.totalAyat();
  if (!total) {
    await bot.send(
      user.id,
      "База Корана пустая. Выполни на своей машине:\n<code>npm run quran:fetch && npm run quran:load</code>"
    );
    return;
  }

  const tasks = await buildPlan(env, d, user);
  const date = localDate(user);
  const debt = await d.debt(user.id, date);

  const open = tasks.filter((t) => t.status === "open");
  if (!open.length) {
    await bot.send(user.id, "На сегодня всё закрыто. 🤲 Отдыхай.");
    return;
  }

  const head = [`<b>План на ${date}</b>`];
  if (debt.length) head.push(`❗️ Хвост с прошлых дней: ${debt.length} заданий`);
  await bot.send(user.id, head.join("\n"), { keyboard: MENU });

  for (const t of open) {
    await bot.send(
      user.id,
      `${KIND_LABEL[t.kind]}\n<b>${esc(await taskLabel(d, t))}</b>`,
      { buttons: taskButtons(t.id) }
    );
  }
}

async function sendAyah(env: Env, d: Db, user: User, arg: string): Promise<void> {
  const bot = tg(env);
  const a = await parseAyah(d, arg, user);
  if (!a) return void bot.send(user.id, "Напиши так: /ayah 6:71");

  const sur = await d.surahName(a.surah);
  const tr = await translation(env, d, a);

  await bot.send(
    user.id,
    `<b>${esc(sur?.name_ru ?? "")} ${a.surah}:${a.ayah}</b>  ·  стр. ${a.page}, джуз ${a.juz}\n\n` +
      `${esc(a.text_uthmani)}\n\n` +
      (tr ? esc(tr) : "<i>перевод недоступен</i>"),
    {
      buttons: [
        [
          { text: "🎧 Хусари", data: `ayd:${a.n}` },
          { text: "📚 Слова", data: `ayw:${a.n}` },
        ],
        [{ text: "📖 Тафсир", data: `ayt:${a.n}` }],
      ],
    }
  );
}

async function sendWords(env: Env, d: Db, user: User, arg: string): Promise<void> {
  const bot = tg(env);
  const a = await parseAyah(d, arg, user);
  if (!a) return void bot.send(user.id, "Напиши так: /words 6:71");
  await bot.sendChatAction(user.id, "typing");
  const words = await analyzeAyah(env, d, a);
  await bot.send(user.id, renderWords(a, words));
  const added = await stockUp(env, d, user.id, [a]);
  if (added) await bot.send(user.id, `Добавил в словарь: ${added} слов. Повторять: /drill`);
}

async function sendGrammar(env: Env, d: Db, user: User, arg: string): Promise<void> {
  const bot = tg(env);
  const a = await parseAyah(d, arg, user);
  if (!a) return void bot.send(user.id, "Напиши так: /grammar 6:71");
  await bot.sendChatAction(user.id, "typing");
  await bot.send(user.id, esc(await explainGrammar(env, a)), { plain: true });
}

async function sendDrill(env: Env, d: Db, user: User): Promise<void> {
  const bot = tg(env);
  const today = localDate(user);
  const words = await d.dueWords(user.id, today, 1);
  const st = await d.vocabStats(user.id, today);

  if (!words.length) {
    await bot.send(
      user.id,
      st?.total
        ? `Слова на сегодня кончились. Всего в словаре ${st.total}, усвоено ${st.learned ?? 0}.\nДобавить новые: /words ${user.cursor_surah}:${user.cursor_ayah}`
        : `Словарь пуст. Набери слова из того, что учишь:\n/words ${user.cursor_surah}:${user.cursor_ayah}`
    );
    return;
  }

  const w = words[0];
  await bot.send(
    user.id,
    `<b>${esc(w.word)}</b>${w.root ? `\n<i>корень: ${esc(w.root)}</i>` : ""}\n\nЧто значит?`,
    {
      buttons: [
        [
          { text: "❌ Не знаю", data: `w:${w.id}:0` },
          { text: "🤔 С трудом", data: `w:${w.id}:1` },
          { text: "✅ Знаю", data: `w:${w.id}:2` },
        ],
      ],
    }
  );
}

async function gradeWord(
  env: Env,
  d: Db,
  user: User,
  wordId: number,
  quality: 0 | 1 | 2,
  callbackId: string
): Promise<void> {
  const bot = tg(env);
  const today = localDate(user);
  const rows = await d.dueWords(user.id, today, 50);
  const w = rows.find((r: any) => r.id === wordId);
  if (!w) return void bot.answerCallback(callbackId, "Карточка не найдена");

  const next = nextWordState(
    { interval: w.interval, ease: w.ease, reps: w.reps, lapses: w.lapses },
    quality
  );
  await d.updateWord(wordId, next);
  await bot.answerCallback(callbackId);
  await bot.send(
    user.id,
    `<b>${esc(w.word)}</b> — ${esc(w.meaning)}` +
      (w.note ? `\n<i>${esc(w.note)}</i>` : "") +
      (w.ayah_key ? `\n<code>${w.ayah_key}</code>` : "")
  );
  await sendDrill(env, d, user);
}

async function sendStats(env: Env, d: Db, user: User): Promise<void> {
  const s = await snapshot(env, d, user);
  await tg(env).send(user.id, renderStats(s, user));
}

async function sendConfusions(env: Env, d: Db, user: User): Promise<void> {
  const bot = tg(env);
  const rows = await d.topConfusions(user.id, 15);
  if (!rows.length) {
    await bot.send(user.id, "Схожих мест, где ты путаешься, пока не зафиксировано.");
    return;
  }
  await bot.send(
    user.id,
    `<b>Муташабихат — где ты съезжаешь</b>\n\n` +
      rows
        .map(
          (r: any) =>
            `<b>${r.ayah_key}</b> → ${r.similar}  ·  ${r.hits} раз\n<i>${esc(r.note ?? "")}</i>`
        )
        .join("\n\n")
  );
}

async function sendReciters(env: Env, user: User): Promise<void> {
  const bot = tg(env);
  await bot.send(
    user.id,
    `Сейчас: <code>${esc(env.RECITER || "Husary_128kbps")}</code>\n\nВыбери, чтобы проверить доступность:`,
    {
      buttons: Object.entries(RECITERS).map(([k, v]) => [{ text: v, data: `rc:${k}` }]),
    }
  );
}

// ===========================================================================
//  Голосовая проверка
// ===========================================================================

async function handleVoice(
  env: Env,
  d: Db,
  user: User,
  m: TgMessage,
  taskId: number | null
): Promise<void> {
  const bot = tg(env);
  await d.setState(user.id, null);

  const fileId = (m.voice ?? m.audio ?? m.video_note)!.file_id;
  const seconds = (m.voice ?? m.audio ?? m.video_note)!.duration ?? 0;

  let task: Task | null = taskId ? await d.task(taskId) : null;
  if (!task) {
    // Не указано задание — берём первое открытое на сегодня.
    const tasks = await d.tasksForDay(user.id, localDate(user));
    task = tasks.find((t) => t.status === "open") ?? null;
  }
  if (!task) {
    await bot.send(
      user.id,
      "Не понял, что именно сверять. Открой /plan и нажми «🎙 Прочитать» под нужным заданием."
    );
    return;
  }

  const ayat = await d.range(task.from_n, task.to_n);
  if (!ayat.length) {
    await bot.send(user.id, "Не нашёл текст отрывка в базе.");
    return;
  }

  const status = await bot.send(user.id, "⏳ Слушаю…");

  try {
    const url = await bot.fileUrl(fileId);
    const audio = await (await fetch(url)).arrayBuffer();

    await bot.edit(user.id, status.message_id, "⏳ Сверяю с мусхафом…");
    const res = await checkRecitation(env, d, audio, ayat);

    const pct = Math.round(res.accuracy * 100);
    const mark = pct >= 99 ? "✅" : pct >= 95 ? "🟢" : pct >= 85 ? "🟡" : "🔴";

    await bot.edit(
      user.id,
      status.message_id,
      `${mark} <b>${pct}%</b> слов верно (${res.wordsTotal} слов в отрывке)\n\n${res.report}`
    );

    // Сохраняем и двигаем повторение.
    await d.addCheck({
      user_id: user.id,
      task_id: task.id,
      from_n: task.from_n,
      to_n: task.to_n,
      accuracy: res.accuracy,
      words_total: res.wordsTotal,
      errors_json: JSON.stringify(res.errors),
      transcript: res.transcript,
      report: res.report,
      seconds,
    });

    for (const c of res.confusions) {
      await d.noteConfusion(user.id, c.ayah, c.similar, c.note);
    }

    if (task.page) await applyReview(d, user.id, task.page, res.accuracy);
    await completeTask(d, user, task, res.accuracy);
    await d.bumpDay(user.id, localDate(user), { checks: 1, score: res.accuracy });

    if (pct < 85) {
      await bot.send(
        user.id,
        "Это пока не держится. Верну этот отрывок завтра и послезавтра, пока не сядет."
      );
    }
  } catch (e) {
    await bot.edit(
      user.id,
      status.message_id,
      `Не получилось проверить: ${esc(String((e as Error).message ?? e))}`
    );
  }
}

async function applyReview(d: Db, userId: number, page: number, accuracy: number): Promise<void> {
  const row = await d.page(userId, page);
  const prev = {
    stability: row?.stability ?? 1,
    reps: row?.reps ?? 0,
    lapses: row?.lapses ?? 0,
  };
  const next = review(prev, accuracy);
  await d.upsertPage(userId, page, {
    stability: next.stability,
    next_review: next.next_review,
    reps: next.reps,
    lapses: next.lapses,
    last_review: new Date().toISOString().slice(0, 19).replace("T", " "),
    last_score: accuracy,
  });
}

// ===========================================================================

async function parseAyah(d: Db, arg: string, user: User) {
  const m = arg.match(/(\d+)\s*[:\s]\s*(\d+)/);
  if (m) return d.ayahByKey(Number(m[1]), Number(m[2]));
  if (!arg.trim()) return d.ayahByKey(user.cursor_surah, user.cursor_ayah);
  return null;
}
