export interface Env {
  DB: D1Database;
  AI: Ai;

  // секреты
  TELEGRAM_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  OWNER_ID: string;

  // переменные
  CLAUDE_MODEL: string;
  CLAUDE_EFFORT: string;
  WHISPER_MODEL: string;
  RECITER: string;
  QURAN_API_BASE: string;
  TRANSLATION_ID: string;
  TAFSIR_ID: string;
  PARTNER_CHAT_ID: string;
}
