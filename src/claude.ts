import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";

/**
 * Обёртка над Messages API.
 *
 * Ответ забираем строгим инструментом (strict tool use) — так Claude обязан
 * вернуть валидный JSON по схеме, а не текст, который потом придётся парсить.
 * Включён серверный fallback: если запрос отклонён классификатором, Anthropic
 * сам переадресует его на резервную модель, а не вернёт пустоту.
 */
export function anthropic(env: Env) {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export interface JsonCallOpts {
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** Постоянная часть промпта кэшируется — повторные проверки дешевле. */
  cacheSystem?: boolean;
}

export async function askJson<T>(env: Env, o: JsonCallOpts): Promise<T | null> {
  const client = anthropic(env);

  const res = await client.beta.messages.create({
    model: env.CLAUDE_MODEL || "claude-opus-5",
    max_tokens: o.maxTokens ?? 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: (env.CLAUDE_EFFORT || "high") as any },
    system: [
      {
        type: "text",
        text: o.system,
        ...(o.cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}),
      },
    ],
    messages: [{ role: "user", content: o.user }],
    tools: [
      {
        name: o.toolName,
        description: o.toolDescription,
        strict: true,
        input_schema: o.schema as any,
      },
    ],
    tool_choice: { type: "tool", name: o.toolName },
  } as any);

  if ((res as any).stop_reason === "refusal") return null;

  for (const block of res.content) {
    if (block.type === "tool_use") return block.input as T;
  }
  return null;
}

/** Свободный текстовый ответ — для объяснений грамматики и разборов. */
export async function askText(
  env: Env,
  system: string,
  user: string,
  maxTokens = 2000
): Promise<string> {
  const client = anthropic(env);
  const res = await client.beta.messages.create({
    model: env.CLAUDE_MODEL || "claude-opus-5",
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: (env.CLAUDE_EFFORT || "high") as any },
    system,
    messages: [{ role: "user", content: user }],
  } as any);

  if ((res as any).stop_reason === "refusal") {
    return "Не получилось разобрать — попробуй ещё раз.";
  }
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
