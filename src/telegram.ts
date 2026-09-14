import type { Env } from "./env";

export interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  text?: string;
  voice?: { file_id: string; duration: number; mime_type?: string };
  audio?: { file_id: string; duration: number; mime_type?: string };
  video_note?: { file_id: string; duration: number };
}
export interface TgCallback {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

export type Button = { text: string; data: string } | { text: string; url: string };

export class Telegram {
  constructor(private token: string) {}

  private async call<T = any>(method: string, body: unknown): Promise<T> {
    const r = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await r.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) {
      throw new Error(`Telegram ${method}: ${json.description ?? "unknown error"}`);
    }
    return json.result;
  }

  send(chatId: number | string, text: string, opts: SendOpts = {}) {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: opts.plain ? undefined : "HTML",
      disable_web_page_preview: true,
      reply_markup: markup(opts),
    });
  }

  edit(chatId: number | string, messageId: number, text: string, opts: SendOpts = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: opts.plain ? undefined : "HTML",
      disable_web_page_preview: true,
      reply_markup: markup(opts),
    }).catch(() => {
      /* «message is not modified» — не повод падать */
    });
  }

  answerCallback(id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text }).catch(
      () => {}
    );
  }

  sendAudio(chatId: number | string, url: string, caption?: string) {
    return this.call("sendAudio", {
      chat_id: chatId,
      audio: url,
      caption,
      parse_mode: "HTML",
    });
  }

  sendChatAction(chatId: number | string, action: string) {
    return this.call("sendChatAction", { chat_id: chatId, action }).catch(() => {});
  }

  async fileUrl(fileId: string): Promise<string> {
    const f = await this.call<{ file_path: string }>("getFile", { file_id: fileId });
    return `https://api.telegram.org/file/bot${this.token}/${f.file_path}`;
  }
}

export interface SendOpts {
  buttons?: Button[][];
  keyboard?: string[][];
  removeKeyboard?: boolean;
  plain?: boolean;
}

function markup(o: SendOpts) {
  if (o.buttons) {
    return {
      inline_keyboard: o.buttons.map((row) =>
        row.map((b) =>
          "url" in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }
        )
      ),
    };
  }
  if (o.keyboard) {
    return { keyboard: o.keyboard.map((r) => r.map((t) => ({ text: t }))), resize_keyboard: true };
  }
  if (o.removeKeyboard) return { remove_keyboard: true };
  return undefined;
}

export const tg = (env: Env) => new Telegram(env.TELEGRAM_TOKEN);

/** Экранирование под parse_mode=HTML. */
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
