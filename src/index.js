// Telegram-бот "Аят дня" на Cloudflare Workers
const API = "https://api.alquran.cloud/v1";
const TOTAL = 6236;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .catch(() => ({ ok: false }));

const say = (env, chat_id, text) => tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML" });

const localDate = (tz) => new Date(Date.now() + tz * 3600e3).toISOString().slice(0, 10);

const getU = (env, chat) => env.KV.get(`u:${chat}`, "json");
const putU = (env, chat, u) => env.KV.put(`u:${chat}`, JSON.stringify(u));

// ref: глобальный номер (1..6236) или "2:255"
async function getAyah(ref) {
  try {
    const r = await fetch(`${API}/ayah/${ref}/editions/quran-uthmani,ru.kuliev,ar.alafasy`);
    const j = await r.json();
    if (j.code !== 200) return null;
    const by = (id) => j.data.find((e) => e.edition.identifier === id);
    const ar = by("quran-uthmani"), ru = by("ru.kuliev"), au = by("ar.alafasy");
    let arabic = ar.text;
    // API добавляет басмалу к первому аяту сур — убираем
    if (ar.numberInSurah === 1 && ![1, 9].includes(ar.surah.number) && arabic.startsWith("بِسْمِ")) {
      arabic = arabic.split(" ").slice(4).join(" ");
    }
    return {
      num: ar.number,
      surah: ar.surah.number,
      ayah: ar.numberInSurah,
      name: ar.surah.name,
      en: ar.surah.englishName,
      arabic,
      ru: ru.text,
      audio: au.audio,
    };
  } catch {
    return null;
  }
}

// Фото -> текст+перевод -> аудио
async function sendAyah(env, chat, a, intro = "") {
  await tg(env, "sendPhoto", {
    chat_id: chat,
    photo: `https://cdn.islamic.network/quran/images/${a.surah}_${a.ayah}.png`,
  });
  const m = await say(
    env,
    chat,
    `${intro}<b>📖 ${esc(a.en)} (${esc(a.name)}) — ${a.surah}:${a.ayah}</b>\n\n${esc(a.arabic)}\n\n${esc(a.ru)}`
  );
  await tg(env, "sendAudio", {
    chat_id: chat,
    audio: a.audio,
    title: `${a.en} ${a.surah}:${a.ayah}`,
    performer: "Mishary Alafasy",
  });
  return m;
}

const HELP = `Ассаляму алейкум! Я буду присылать тебе по одному аяту в день для заучивания: картинка, текст, перевод и аудио.

<b>Как начать:</b> отправь номер аята, с которого начинаешь, например <code>2:255</code> (сура:аят).

<b>Команды:</b>
/next — следующий аят сейчас
/today — повторить текущий аят
/time 7 — час отправки (по твоему времени)
/tz 3 — твой часовой пояс (UTC+3 = Москва)
/stop — отписаться`;

function parseRef(s) {
  const m = s.match(/^(\d{1,3})\s*[:.\-\s]\s*(\d{1,3})$/);
  return m ? `${m[1]}:${m[2]}` : null;
}

async function handleMessage(env, msg) {
  const chat = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().split("@")[0];
  const arg = rest.join(" ").trim();
  let u = await getU(env, chat);

  const start = async (ref) => {
    const a = await getAyah(ref);
    if (!a) return say(env, chat, "Не нашёл такой аят. Пример: <code>2:255</code>");
    const base = u || { hour: 7, tz: 3 };
    u = { ...base, cur: a.num, n: a.num + 1, sentOn: localDate(base.tz) };
    await putU(env, chat, u);
    await sendAyah(env, chat, a, "🌱 Начинаем!\n\n");
    await say(env, chat, `Дальше буду присылать новый аят каждый день в ${u.hour}:00 (UTC${u.tz >= 0 ? "+" : ""}${u.tz}). Изменить: /time и /tz`);
  };

  if (cmd === "/start" || cmd === "/help") return say(env, chat, HELP);
  if (cmd === "/set") return start(parseRef(arg) || "x");
  const direct = parseRef(text);
  if (direct) return start(direct);

  if (cmd === "/stop") {
    await env.KV.delete(`u:${chat}`);
    return say(env, chat, "Отписал. Чтобы вернуться — отправь номер аята, например <code>2:255</code>");
  }

  if (!u) return say(env, chat, "Сначала отправь аят, с которого начинаешь, например <code>2:255</code>");

  if (cmd === "/next") {
    if (u.n > TOTAL) return say(env, chat, "🎉 Ты дошёл до конца Корана, макбуль!");
    const a = await getAyah(u.n);
    if (!a) return say(env, chat, "Не получилось загрузить аят, попробуй ещё раз.");
    u = { ...u, cur: a.num, n: a.num + 1, sentOn: localDate(u.tz) };
    await putU(env, chat, u);
    return sendAyah(env, chat, a);
  }
  if (cmd === "/today") {
    const a = await getAyah(u.cur);
    return a ? sendAyah(env, chat, a) : say(env, chat, "Не получилось загрузить аят.");
  }
  if (cmd === "/time") {
    const h = parseInt(arg, 10);
    if (!(h >= 0 && h <= 23)) return say(env, chat, "Напиши час от 0 до 23, например <code>/time 7</code>");
    await putU(env, chat, { ...u, hour: h });
    return say(env, chat, `Готово, буду присылать в ${h}:00`);
  }
  if (cmd === "/tz") {
    const z = parseInt(arg, 10);
    if (!(z >= -12 && z <= 14)) return say(env, chat, "Напиши смещение от UTC, например <code>/tz 3</code>");
    await putU(env, chat, { ...u, tz: z });
    return say(env, chat, `Часовой пояс: UTC${z >= 0 ? "+" : ""}${z}`);
  }
  return say(env, chat, HELP);
}

// Раз в час: рассылаем тем, у кого сейчас нужный час
async function daily(env) {
  const utcH = new Date().getUTCHours();
  let cursor;
  do {
    const l = await env.KV.list({ prefix: "u:", cursor });
    cursor = l.list_complete ? undefined : l.cursor;
    for (const k of l.keys) {
      const u = await env.KV.get(k.name, "json");
      if (!u) continue;
      const chat = k.name.slice(2);
      const localH = (((utcH + u.tz) % 24) + 24) % 24;
      if (localH !== u.hour || u.sentOn === localDate(u.tz) || u.n > TOTAL) continue;
      const a = await getAyah(u.n);
      if (!a) continue;
      const m = await sendAyah(env, chat, a, "🌅 Твой аят на сегодня\n\n");
      if (m.error_code === 403) {
        await env.KV.delete(k.name);
        continue;
      }
      await putU(env, chat, { ...u, cur: a.num, n: a.num + 1, sentOn: localDate(u.tz) });
    }
  } while (cursor);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "POST") return new Response("ok");
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    const update = await req.json().catch(() => null);
    if (update?.message) ctx.waitUntil(handleMessage(env, update.message).catch(() => {}));
    return new Response("ok");
  },
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(daily(env));
  },
};
