/**
 * USD cost per 1M tokens, by model ID. Anthropic figures are current as of
 * this file's last update (see README) -- OpenAI/Google entries are left
 * unset by default since this project has no authoritative live source for
 * them; fill in `EXTRA_PRICING` (or edit this table) with current numbers
 * rather than trusting stale hardcoded values.
 */
export type ModelPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
};

const PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": { inputPerMillion: 10.0, outputPerMillion: 50.0 },
  "claude-opus-5": { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  // Sonnet 5 has an introductory rate through 2026-08-31 ($2/$10); this uses the standard rate.
  "claude-sonnet-5": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  "claude-haiku-4-5": { inputPerMillion: 1.0, outputPerMillion: 5.0 },
};

/** Fill in current OpenAI/Google pricing here to get cost estimates for those providers. */
const EXTRA_PRICING: Record<string, ModelPricing> = {};

export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = EXTRA_PRICING[modelId] ?? PRICING[modelId];
  if (!pricing) return null;
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}
