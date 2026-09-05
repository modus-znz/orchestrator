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
  orc daemon [start|stop|status]

${dim('Talks only to http://127.0.0.1 — set ORCHESTRATOR_PORT to change the port.')}`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const parsed = parseArgs(rest);

  switch (command) {
    case 'run': await cmd.run(parsed); return 0;
    case 'batch': await cmd.batch(parsed); return 0;
    case 'ps': await cmd.ps(parsed); return 0;
    case 'logs': await cmd.logs(parsed); return 0;
    case 'cancel': await cmd.cancel(parsed); return 0;
    case 'steer': await cmd.steer(parsed); return 0;
    case 'attach': await cmd.attach(parsed); return 0;
    case 'fleet': await cmd.fleet(); return 0;
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
