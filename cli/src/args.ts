/**
 * A deliberately small flag parser.
 *
 * `orc` takes free text as a positional argument — a prompt, a steer — and that
 * text routinely contains hyphens, quotes and whole sentences. A parser clever
 * enough to guess where flags end is a parser that will one day eat half of
 * someone's prompt, so the rules here are blunt: a token is a flag only if it
 * starts with `--`, values are taken positionally, and `--` ends flag parsing
 * outright for the times when the blunt rule is still not blunt enough.
 */
export interface Parsed {
  readonly positional: string[];
  readonly flags: Map<string, string | true>;
}

/** Flags that take a value. Anything else is boolean, so `--steerable` works. */
const VALUED = new Set([
  'model',
  'cwd',
  'depends-on',
  'budget',
  'timeout',
  'name',
  'permission-mode',
  'terminal',
  'status',
  'reason',
  'port',
]);

export function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  let literal = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (literal || !arg.startsWith('--')) {
      // A lone `-f` is the one short flag worth supporting: `logs -f` is muscle
      // memory from every log tool anyone has ever used.
      if (!literal && arg === '-f') flags.set('follow', true);
      else positional.push(arg);
      continue;
    }
    if (arg === '--') {
      literal = true;
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    if (VALUED.has(body)) {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`--${body} needs a value`);
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }
  return { positional, flags };
}

export function str(flags: Parsed['flags'], key: string): string | undefined {
  const v = flags.get(key);
  return typeof v === 'string' ? v : undefined;
}

export function num(flags: Parsed['flags'], key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got "${v}"`);
  return n;
}

export function bool(flags: Parsed['flags'], key: string): boolean {
  return flags.get(key) === true || flags.get(key) === 'true';
}

/** `--depends-on a,b` and `--depends-on a --depends-on b` should both work;
 *  only the first is possible with a Map, so commas are the supported spelling. */
export function list(flags: Parsed['flags'], key: string): string[] {
  const v = str(flags, key);
  return v === undefined ? [] : v.split(',').map((s) => s.trim()).filter(Boolean);
}
