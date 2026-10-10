/**
 * Turning a tool invocation into a *classification* — never a copy of it.
 *
 * Knowing a fleet ran `Bash` 890 times is close to useless; knowing it ran
 * `git` 400 times, `npm` 200 and `grep` 150 is something you can act on. So the
 * learning store keeps a bounded label for each call and never the argument
 * itself. That is what makes the store small, fast, and structurally incapable
 * of holding a path or a secret (spec §11) — redaction here is not a filter
 * applied on the way out that a later query could route around, because the
 * content never arrives in the first place.
 */

/**
 * Binaries whose *second* token is the verb, so `git commit` and `git log`
 * separate instead of collapsing into one meaningless `git` bar.
 *
 * This list is a security control, not a convenience. Taking the second token
 * unconditionally would turn `cat /home/ghost/Desktop/hash.env` into a label
 * containing the path of a secret, and the whole no-content guarantee above
 * would be gone. Only binaries on this list get two tokens; everything else
 * stops at one.
 */
const MULTIPLEXERS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'docker',
  'systemctl',
  'kubectl',
  'cargo',
  'gh',
  'sudo',
]);

/** Shell operators that end one command and begin another. */
const CHAIN = new Set(['&&', '||', ';', '|']);

/** A bare subcommand: lowercase, no slashes, no dots, no leading dash. Anything
 *  that could be a path, a flag, a filename or a value fails this and is
 *  dropped rather than guessed at. */
const SUBCOMMAND = /^[a-z][a-z0-9:_-]*$/;

/** `FOO=bar` — an inline environment assignment, which precedes the real
 *  command and whose value is exactly the kind of thing we must not keep. */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** An extension longer than this is not an extension, it is an accident. */
const MAX_EXT = 12;

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The command word (and, for a multiplexer, its subcommand) from a shell line.
 *
 * Three things are stepped over before the first real token is taken, because
 * each of them is common in practice and each one would otherwise produce a
 * label that says nothing:
 *
 *   - inline env assignments — `ROOT_PWD=x sudo -S …` would classify as the
 *     assignment, and would carry its value into the database
 *   - a leading `cd <path> &&` — extremely common here, and classifying it as
 *     `cd` tells you only that we changed directory, never what we then ran
 *   - flags after a multiplexer — `sudo -u odoo psql` must not report `odoo`,
 *     which is a value, not a verb; when the next token is not plainly a
 *     subcommand we stop at one token rather than guess
 */
function classifyCommand(command: string): string | null {
  let tokens = command.trim().split(/\s+/).filter(Boolean);

  // Step over `cd <somewhere> &&`. Bounded to two hops: a genuine command has
  // no reason to chain further before starting, and an unbounded loop here
  // would be driven by input we do not control.
  for (let hop = 0; hop < 2 && tokens[0] === 'cd'; hop++) {
    const chain = tokens.findIndex((t) => CHAIN.has(t));
    if (chain === -1) return 'cd';
    tokens = tokens.slice(chain + 1);
  }

  while (tokens.length > 0 && ENV_ASSIGN.test(tokens[0] as string)) tokens = tokens.slice(1);

  const head = tokens[0];
  if (!head || CHAIN.has(head)) return null;

  // A path-shaped command keeps only its basename: `/usr/bin/python3` is the
  // same tool as `python3`, and the directories are not ours to store.
  const name = head.includes('/') ? (head.split('/').pop() ?? head) : head;
  if (!name) return null;
  if (!MULTIPLEXERS.has(name)) return name;

  const next = tokens[1];
  return next && SUBCOMMAND.test(next) ? `${name} ${next}` : name;
}

/** The extension of a path, lowercased, or `(none)`. Only the extension — the
 *  directories and the filename are content and are not kept. */
function classifyPath(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  // `dot > 0` rather than `!== -1`: a dotfile like `.gitignore` is a name, not
  // an extension, and reporting `.gitignore` as a file type would be a lie.
  if (dot <= 0) return '(none)';
  const ext = base.slice(dot).toLowerCase();
  return ext.length <= MAX_EXT ? ext : '(none)';
}

/**
 * The bounded label for one tool call, or null when the tool has nothing worth
 * classifying. Pure: no I/O, no clock, no database — which is why this is the
 * piece that carries the unit tests.
 */
export function classifyArg(toolName: string, input: unknown): string | null {
  const arg = asRecord(input);

  switch (toolName) {
    case 'Bash':
    case 'BashOutput': {
      const command = asString(arg['command']);
      return command.trim() ? classifyCommand(command) : null;
    }

    case 'Read':
    case 'Edit':
    case 'Write': {
      const path = asString(arg['file_path']);
      return path ? classifyPath(path) : null;
    }

    case 'NotebookEdit': {
      const path = asString(arg['notebook_path']);
      return path ? classifyPath(path) : null;
    }

    case 'Skill': {
      // The skill name is the whole point of the row — it is what feeds skill
      // demand, and it is a public identifier rather than user content.
      const skill = asString(arg['skill']).trim();
      return skill || null;
    }

    case 'Agent':
    case 'Task': {
      const kind = asString(arg['subagent_type']).trim();
      return kind || null;
    }

    default:
      // Grep, Glob, WebFetch and the rest classify to the tool name alone. A
      // URL or a search pattern is user content, and no bounded transform of
      // it is worth the risk of keeping.
      return null;
  }
}
