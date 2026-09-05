#!/usr/bin/env node
import { parseArgs } from './args.js';
import { ApiError, NotRunningError } from './client.js';
import * as cmd from './commands.js';
import { bold, dim } from './format.js';

const HELP = `${bold('orc')} — orchestrate Claude Code sessions

  orc run <prompt>            submit one job
      --model haiku|sonnet|opus|fable   --cwd <dir>       --budget <usd>
      --timeout <ms>          --name <label>              --depends-on a,b
      --permission-mode default|acceptEdits|plan          --steerable
  orc batch <file.json>       submit many (array, or {"jobs":[…]})
  orc ps [--all] [--status s] list jobs; live ones by default
  orc logs <job> [-f]         replay a job's events, optionally following
  orc cancel <job> [--reason] stop a job
  orc steer <job|session> <text>   relay an instruction to a running session
  orc attach <job|session>    open a terminal on that session and hand it over
  orc fleet                   every live session, managed and observed
  orc ui [--print]            open the dashboard (token in the URL fragment)
  orc daemon [start|stop|status]

${dim('Talks only to http://127.0.0.1 — set ORCHESTRATOR_PORT to change the port.')}`;

/**
 * Every flag each command actually reads.
 *
 * The parser cannot police this: it does not know the command, and it treats an
 * unrecognised `--foo` as a boolean so that `--steerable` works without a table
 * of every flag in the CLI. The cost of that leniency lands here — a typo'd
 * `--file x.json` on `orc run` leaves `x.json` sitting in the positionals,
 * which become the prompt, and the daemon dutifully spawns a billable session
 * whose entire instruction is a file path. That happened, and it cost $0.13.
 *
 * So an unknown flag is a hard error rather than a warning. This is a tool that
 * spends money on the strength of its arguments.
 */
const KNOWN: Readonly<Record<string, readonly string[]>> = {
  run: ['model', 'cwd', 'budget', 'timeout', 'name', 'depends-on', 'permission-mode', 'steerable'],
  batch: [],
  ps: ['all', 'status'],
  logs: ['follow'],
  cancel: ['reason'],
  steer: [],
  attach: ['terminal'],
  fleet: [],
  ui: ['print'],
  daemon: ['port'],
};

function rejectUnknownFlags(command: string, parsed: ReturnType<typeof parseArgs>): void {
  const allowed = KNOWN[command];
  if (allowed === undefined) return; // Unknown command; the switch reports it.
  for (const flag of parsed.flags.keys()) {
    if (!allowed.includes(flag)) {
      const suffix = allowed.length ? ` — it takes ${allowed.map((f) => `--${f}`).join(', ')}` : ' — it takes no flags';
      throw new Error(`orc ${command} has no --${flag}${suffix}`);
    }
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const parsed = parseArgs(rest);
  rejectUnknownFlags(command, parsed);

  switch (command) {
    case 'run': await cmd.run(parsed); return 0;
    case 'batch': await cmd.batch(parsed); return 0;
    case 'ps': await cmd.ps(parsed); return 0;
    case 'logs': await cmd.logs(parsed); return 0;
    case 'cancel': await cmd.cancel(parsed); return 0;
    case 'steer': await cmd.steer(parsed); return 0;
    case 'attach': await cmd.attach(parsed); return 0;
    case 'fleet': await cmd.fleet(); return 0;
    case 'ui': await cmd.ui(parsed); return 0;
    case 'daemon': await cmd.daemon(parsed); return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}\n`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // Three shapes of failure, three different fixes — so three messages, and
    // never a stack trace, which tells an operator nothing they can act on.
    if (err instanceof NotRunningError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 3;
    } else if (err instanceof ApiError) {
      process.stderr.write(`daemon refused (${err.status}): ${err.message}\n`);
      process.exitCode = 4;
    } else {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  });
