/**
 * Redaction (§4.4 of the design spec).
 *
 * Runs at *ingest*, before an event reaches the store or the SSE bus. That
 * placement is the whole point: redacting at render would leave the secret on
 * disk forever. This exists on direct evidence — a harness `adopt.json` on this
 * machine held a live DATABASE_URL, SESSION_SECRET and ADMIN_PASSWORD inside a
 * captured command string (spec §2, F9).
 *
 * The bias is deliberate over-redaction. Losing a token *count* to an
 * over-eager pattern is an inconvenience; leaking a password is not.
 */

export const REDACTED = '[redacted]';

/**
 * Keys whose value is replaced wholesale.
 *
 * Written as anchored/boundaried patterns rather than loose substrings for two
 * specific reasons: `sessionId` is our primary key and must never be redacted,
 * and the harness emits a `tokens` object of token *counts* that is not a
 * secret. A naive /token/i would destroy both.
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /^token$/i,
  /(?:^|[_-])(?:secret|password|passwd|passphrase|credential|credentials)s?$/i,
  /(?:^|[_-])(?:api|access|private|secret|auth|encryption|signing)[_-]?keys?$/i,
  /(?:^|[_-])(?:auth|access|refresh|bearer|id|session)[_-]?tokens?$/i,
  /^authorization$/i,
  /^set-cookie$/i,
  /^cookie$/i,
  /(?:^|[_-])database[_-]?url$/i,
  /(?:^|[_-])dsn$/i,
];

/** Free-text scrubbers, applied to every string we keep. */
const VALUE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // KEY=value / KEY='value' / KEY="value" inside a command line.
  [
    /\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|KEY|CREDENTIAL|DATABASE_URL|DSN)[A-Za-z0-9_]*)\s*=\s*('[^']*'|"[^"]*"|\S+)/gi,
    `$1=${REDACTED}`,
  ],
  // Credentials embedded in a URL: postgres://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, `$1$2:${REDACTED}@`],
  // Authorization headers, with or without a scheme.
  [/\b(authorization\s*:\s*)(?:bearer\s+|basic\s+)?\S+/gi, `$1${REDACTED}`],
  // A bare bearer token anywhere else.
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/g, `Bearer ${REDACTED}`],
  // Anthropic-style keys, which are recognisable on sight.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
];

const MAX_DEPTH = 12;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactString(
  input: string,
  literals: readonly string[] = [],
): string {
  let out = input;
  for (const [pattern, replacement] of VALUE_RULES) {
    out = out.replace(pattern, replacement);
  }
  for (const literal of literals) {
    // Short literals would shred ordinary prose, so they are ignored rather
    // than silently making the log unreadable.
    if (literal.length < 4) continue;
    out = out.replace(new RegExp(escapeRegExp(literal), 'g'), REDACTED);
  }
  return out;
}

/**
 * Deep-redact any value. Returns a new structure; the input is never mutated.
 * Cycles and runaway nesting are truncated rather than thrown on, because a
 * redaction failure must never be able to take the ingest path down.
 */
export function redact(
  value: unknown,
  literals: readonly string[] = [],
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';

  if (typeof value === 'string') return redactString(value, literals);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, literals, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key)
      ? REDACTED
      : redact(item, literals, depth + 1, seen);
  }
  return out;
}
