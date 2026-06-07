/**
 * Shared AI completion helper for pi-git.
 *
 * Consolidates the duplicated pattern: resolveModel → getApiKeyAndHeaders →
 * build Context → completeSimple → extract text.
 */

import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./resolve-model.js";

export interface AICompletionOptions {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: "minimal" | "medium" | "high";
}

/**
 * Run an AI completion with automatic model resolution and auth.
 *
 * Returns `{ text, model }` on success, or `null` if no model is configured,
 * auth fails, or the configured model is unavailable.
 *
 * Callers should wrap in try/catch for network-level errors from the AI provider.
 */
export async function aiComplete(
  ctx: ExtensionContext,
  options: AICompletionOptions,
): Promise<{ text: string; model: Model<Api> } | null> {
  const model = resolveModel(ctx);
  if (!model) return null;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return null;

  const context: Context = {
    systemPrompt: options.systemPrompt,
    messages: [
      {
        role: "user",
        content: options.userMessage,
        timestamp: Date.now(),
      },
    ],
  };

  const result = await completeSimple(model, context, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    signal: ctx.signal,
    reasoning: options.reasoning ?? "minimal",
    temperature: options.temperature ?? 0,
    maxTokens: options.maxTokens ?? 1024,
  });

  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  return { text, model };
}
