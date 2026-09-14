#!/usr/bin/env node
/**
 * Привязывает Telegram-вебхук к задеплоенному Worker'у.
 *
 *   TELEGRAM_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... WORKER_URL=https://quran-bot.<sub>.workers.dev \
 *     npm run hook:set
 *
 *   npm run hook:info   — посмотреть текущее состояние вебхука
 */
const token = process.env.TELEGRAM_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const url = process.env.WORKER_URL;

if (!token) {
  console.error("Нужна переменная TELEGRAM_TOKEN");
  process.exit(1);
}
const api = (m, body) =>
  fetch(`https://api.telegram.org/bot${token}/${m}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

if (process.argv.includes("--info")) {
  console.log(JSON.stringify(await api("getWebhookInfo"), null, 2));
  process.exit(0);
}

if (!secret || !url) {
  console.error("Нужны переменные TELEGRAM_WEBHOOK_SECRET и WORKER_URL");
  process.exit(1);
}

const res = await api("setWebhook", {
  url: `${url.replace(/\/$/, "")}/telegram`,
  secret_token: secret,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
console.log(JSON.stringify(res, null, 2));
