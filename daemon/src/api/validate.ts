import { statSync } from 'node:fs';
import type { SubmitSpec } from '../scheduler/index.js';
import {
  DEFAULT_SETTINGS,
  type ModelTier,
  type PermissionMode,
  type Settings,
} from '../types.js';
import { badRequest, forbidden } from './http.js';

const MODELS: readonly string[] = ['haiku', 'sonnet', 'opus', 'fable'];
const MODES: readonly string[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
/** One submission is a batch of related work, not a queue dump. */
const MAX_BATCH = 100;
const MAX_PROMPT_CHARS = 100_000;

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function positive(v: unknown, fallback: number, field: string): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw badRequest(`${field} must be a positive number`);
  return n;
}

function directory(v: unknown, fallback: string): string {
  const cwd = typeof v === 'string' && v ? v : fallback;
  try {
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch {
    // Rejecting here rather than at spawn: a job that dies instantly on a typo
    // still costs a queue slot, an event trail, and the operator's attention.
    throw badRequest(`cwd is not an existing directory: ${cwd}`);
  }
  return cwd;
}

/**
 * Turn a request body into job specs, or refuse it.
 *
 * Defaults come from live settings rather than constants, so changing the
 * default model in the UI changes what an under-specified submission means —
 * which is the only reading of "default" that is not a lie.
 */
export function parseJobSpecs(body: unknown, settings: Settings, daemonCwd: string): SubmitSpec[] {
  const root = obj(body);
  const raw = Array.isArray(root['jobs']) ? (root['jobs'] as unknown[]) : [body];
  if (raw.length === 0) throw badRequest('no jobs submitted');
  if (raw.length > MAX_BATCH) throw badRequest(`batch of ${raw.length} exceeds the limit of ${MAX_BATCH}`);

  return raw.map((entry, i) => {
    const j = obj(entry);
    const prompt = typeof j['prompt'] === 'string' ? j['prompt'].trim() : '';
    if (!prompt) throw badRequest(`jobs[${i}]: prompt is required`);
    if (prompt.length > MAX_PROMPT_CHARS) throw badRequest(`jobs[${i}]: prompt exceeds ${MAX_PROMPT_CHARS} characters`);

    const model = j['model'] === undefined ? settings.defaultModel : String(j['model']);
    if (!MODELS.includes(model)) throw badRequest(`jobs[${i}]: unknown model "${model}"`);

    const mode = j['permissionMode'] === undefined ? settings.defaultPermissionMode : String(j['permissionMode']);
    if (!MODES.includes(mode)) throw badRequest(`jobs[${i}]: unknown permissionMode "${mode}"`);
    // Closed by default, and not merely a setting to flip carelessly: this API
    // is meant to be reachable over Tailscale one day (§11), and a route that
    // can spawn an agent with permission prompts disabled is the single most
    // dangerous thing in the whole system. The operator opts in on the box.
    if (mode === 'bypassPermissions' && !settings.allowBypassPermissions) {
      // Name the *only* lever that opens this. Pointing at the settings route
      // would be advice the settings route refuses to take, and an error that
      // sends the operator somewhere they will be refused again is worse than
      // a bare denial.
      throw forbidden(
        `jobs[${i}]: permissionMode "bypassPermissions" is disabled; ` +
          'start the daemon with ORCHESTRATOR_ALLOW_BYPASS=1 to allow it',
      );
    }

    const deps = j['dependsOn'];
    const dependsOn = Array.isArray(deps) ? deps.map(String) : [];
    const tools = j['allowedTools'];

    return {
      ...(typeof j['name'] === 'string' && j['name'] ? { name: j['name'] } : {}),
      prompt,
      cwd: directory(j['cwd'], daemonCwd),
      model: model as ModelTier,
      budgetUsd: positive(j['budgetUsd'], settings.defaultBudgetUsd, `jobs[${i}].budgetUsd`),
      timeoutMs: positive(j['timeoutMs'], settings.defaultTimeoutMs, `jobs[${i}].timeoutMs`),
      permissionMode: mode as PermissionMode,
      ...(Array.isArray(tools) ? { allowedTools: tools.map(String) } : {}),
      dependsOn,
      steerable: j['steerable'] === true,
    } satisfies SubmitSpec;
  });
}

/** Settings keys a client may write, with the shape each must have. */
const SETTING_GUARDS: { [K in keyof Settings]: (v: unknown) => boolean } = {
  maxConcurrency: (v) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 64,
  defaultModel: (v) => MODELS.includes(String(v)),
  defaultBudgetUsd: (v) => Number.isFinite(v) && (v as number) > 0,
  defaultTimeoutMs: (v) => Number.isFinite(v) && (v as number) > 0,
  defaultPermissionMode: (v) => MODES.includes(String(v)),
  retryLimit: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10,
  terminal: (v) => ['ghostty', 'konsole', 'auto', 'none'].includes(String(v)),
  steerAllowlist: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  steerRateLimitPerHour: (v) => Number.isInteger(v) && (v as number) >= 0,
  redactPatterns: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  // Deliberately absent from the writable set — see parseSettingsPatch.
  allowBypassPermissions: () => false,
};

/**
 * Validate a settings patch.
 *
 * Unknown keys are rejected rather than ignored: silently dropping a key means
 * an operator who misspells `maxConcurency` gets a 200 and no change, and then
 * spends an afternoon wondering why the fleet ignores them.
 *
 * `allowBypassPermissions` is not writable here at all. A gate a caller can
 * open with one extra request to the same API is not a gate — so that one is
 * read from the daemon's environment at startup, which requires reaching the
 * box rather than reaching the box's web UI.
 */
export function parseSettingsPatch(body: unknown): Partial<Settings> {
  const patch = obj(body);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'allowBypassPermissions') {
      throw forbidden(
        'allowBypassPermissions is not settable through the API; ' +
          'start the daemon with ORCHESTRATOR_ALLOW_BYPASS=1',
      );
    }
    const guard = (SETTING_GUARDS as Record<string, ((v: unknown) => boolean) | undefined>)[key];
    if (!guard) throw badRequest(`unknown setting "${key}"`);
    if (!guard(value)) throw badRequest(`invalid value for setting "${key}"`);
    out[key] = value;
  }
  if (Object.keys(out).length === 0) throw badRequest('no settings supplied');
  return out as Partial<Settings>;
}

export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
