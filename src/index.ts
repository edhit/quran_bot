import type { Env } from "./env";
import { handleUpdate } from "./router";
import { tick } from "./cron";
import type { TgUpdate } from "./telegram";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      const n = await env.DB.prepare("SELECT COUNT(*) AS c FROM ayat").first<{ c: number }>();
      return Response.json({ ok: true, ayat: n?.c ?? 0 });
    }

    if (url.pathname !== "/telegram" || req.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    const update = (await req.json()) as TgUpdate;

    // Telegram ждёт быстрый 200, иначе шлёт апдейт повторно. Распознавание и
    // разбор занимают десятки секунд, поэтому делаем их после ответа.
    ctx.waitUntil(
      handleUpdate(env, update).catch((e) => console.error("update failed:", e))
    );

    return new Response("ok");
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env).catch((e) => console.error("cron failed:", e)));
  },
};
