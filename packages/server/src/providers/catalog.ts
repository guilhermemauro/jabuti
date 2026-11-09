// Models the UI can choose from, with prices for the cost budget (C1).
// Catalog ids are "<provider>/<model>". Prices in USD per million tokens;
// verify against each provider's pricing page when adding a model.
import type { Usage } from "./types.ts";

interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CatalogModel {
  id: string;
  provider: string;
  model: string;
  label: string;
  pricing: Pricing;
  /** Input tokens the model accepts in one request. */
  contextWindow: number;
}

function anthropic(model: string, label: string, input: number, output: number, cacheRead: number) {
  // Anthropic bills 5-minute cache writes at 1.25x the input price.
  const pricing = { input, output, cacheRead, cacheWrite: input * 1.25 };
  // Every current Claude model takes 1M tokens of context (models overview, 2026-11).
  const contextWindow = 1_000_000;
  return { id: `anthropic/${model}`, provider: "anthropic", model, label, pricing, contextWindow };
}

export const CATALOG: readonly CatalogModel[] = [
  anthropic("claude-opus-5-5", "Claude Opus 5.5", 4, 20, 0.2),
  anthropic("claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10, 0.2),
  anthropic("claude-haiku-5-5", "Claude Haiku 5.5", 0.1, 0.5, 0.01),
  anthropic("claude-fable-5-1", "Claude Fable 5.1", 10, 50, 0.25),
];

export function costUsd(model: CatalogModel, usage: Usage): number {
  const p = model.pricing;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}
