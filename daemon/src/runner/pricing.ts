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

/**
 * Published per-model rates, in USD per million tokens.
 *
 * Maintained by hand, which makes every figure derived from them a guess whose
 * accuracy depends on how current this table was on the day the job ran. An
 * operator who does not want to wait for a release can override any row from
 * `prices.json` (see `mergePrices` and the daemon's loader) — that file is read
 * at start and is deliberately NOT an API setting, because a caller able to
 * rewrite prices can set every row to 0.0001 and switch off the budget kill
 * fleet-wide. That is the same gate `allowBypassPermissions` refuses to expose.
 */
const BASE_PRICES: Readonly<Record<string, ModelPrice>> = {
  haiku: { inputPerMTok: 1, outputPerMTok: 5 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },
  opus: { inputPerMTok: 15, outputPerMTok: 75 },
  fable: { inputPerMTok: 30, outputPerMTok: 150 },
};

/** Wire-id substrings we can price. Order matters only for readability; a wire
 *  id matches at most one of them in practice. */
export const KNOWN_PRICE_KEYS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

/**
 * The fallback row, derived per-field rather than written down.
 *
 * A model we failed to recognise has to price at least as high as the priciest
 * one we do, or the estimate under-shoots exactly where we know least and the
 * budget kill fires late. Writing the row as a literal is how that invariant
 * rots unnoticed: it sat at 15/75 — a copy of the opus row — while fable was
 * 30/150, so an unrecognised fable-tier model was estimated at half rate for
 * kill purposes. Deriving it means adding or repricing any row keeps the
 * guarantee without anyone having to remember this paragraph.
 */
function pessimisticRow(prices: Readonly<Record<string, ModelPrice>>): ModelPrice {
  let inputPerMTok = 0;
  let outputPerMTok = 0;
  for (const [key, price] of Object.entries(prices)) {
    if (key === 'unknown') continue;
    inputPerMTok = Math.max(inputPerMTok, price.inputPerMTok);
    outputPerMTok = Math.max(outputPerMTok, price.outputPerMTok);
  }
  return { inputPerMTok, outputPerMTok };
}

/**
 * Layer operator overrides over the published table.
 *
 * `unknown` is always recomputed and never taken from the overrides: it is an
 * invariant over the other rows, not a rate anyone publishes, and letting it be
 * set directly would reintroduce the drift `pessimisticRow` exists to prevent.
 */
export function mergePrices(
  overrides: Readonly<Record<string, ModelPrice>> = {},
): Readonly<Record<string, ModelPrice>> {
  const merged: Record<string, ModelPrice> = { ...BASE_PRICES, ...overrides };
  delete merged['unknown'];
  merged['unknown'] = pessimisticRow(merged);
  return merged;
}

export const DEFAULT_PRICES: Readonly<Record<string, ModelPrice>> = mergePrices();

export interface Usage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

/** Map a wire model id like `claude-haiku-4-5-20251001` onto a price row.
 *  Anything we cannot place falls to the derived `unknown` row, which prices at
 *  the highest rate we know of — an over-estimate kills a job early, and that
 *  is a far cheaper mistake than failing to kill a runaway one. */
export function priceKeyFor(model: string | undefined): string {
  const m = (model ?? '').toLowerCase();
  for (const key of KNOWN_PRICE_KEYS) {
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
