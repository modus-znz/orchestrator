/**
 * Cost estimation.
 *
 * Ground truth from a captured stream (spec §2, F13): a Claude Code
 * `stream-json` run reports authoritative cost exactly once, in the terminal
 * `result` event as `total_cost_usd`. Per-turn `assistant` events carry token
 * *usage* but no money.
 *
 * Budget enforcement has to act mid-run, so it works off an estimate derived
 * from usage and this price table, and the final `result` then overwrites the
 * accumulated estimate with the authoritative figure. The estimate is a kill
 * switch, never a billing record — and the UI labels it as such.
 */

export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/** Standard Anthropic cache ratios: writes cost more than input, reads far less. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export const DEFAULT_PRICES: Readonly<Record<string, ModelPrice>> = {
  haiku: { inputPerMTok: 1, outputPerMTok: 5 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },
  opus: { inputPerMTok: 15, outputPerMTok: 75 },
  fable: { inputPerMTok: 30, outputPerMTok: 150 },
  unknown: { inputPerMTok: 15, outputPerMTok: 75 },
};

export interface Usage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

/** Map a wire model id like `claude-haiku-4-5-20251001` onto a price row.
 *  Unknown models price as opus — an over-estimate kills early, and killing a
 *  job early is a far cheaper mistake than not killing a runaway one. */
export function priceKeyFor(model: string | undefined): string {
  const m = (model ?? '').toLowerCase();
  for (const key of ['haiku', 'sonnet', 'opus', 'fable']) {
    if (m.includes(key)) return key;
  }
  return 'unknown';
}

export function estimateUsd(
  model: string | undefined,
  usage: Usage | undefined,
  prices: Readonly<Record<string, ModelPrice>> = DEFAULT_PRICES,
): number {
  if (!usage) return 0;
  const key = priceKeyFor(model);
  const price = prices[key] ?? DEFAULT_PRICES['unknown']!;
  const input = usage.input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;

  const inputCost =
    (input + cacheWrite * CACHE_WRITE_MULTIPLIER + cacheRead * CACHE_READ_MULTIPLIER) *
    (price.inputPerMTok / 1_000_000);
  const outputCost = output * (price.outputPerMTok / 1_000_000);
  return inputCost + outputCost;
}
