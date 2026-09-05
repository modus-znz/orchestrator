import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EventBus } from '../bus.js';
import type { JobRecord } from '../types.js';
import { LineSplitter, StreamParser } from './stream.js';

export interface RunOptions {
  /** Emitting a stream_event per token is enormous and nothing on the
   *  dashboard consumes it, so partial messages are opt-in (§4.5). */
  readonly includePartialMessages?: boolean;
  readonly claudeBin?: string;
  /** Grace period between SIGTERM and SIGKILL. */
  readonly killGraceMs?: number;
  /** How long to wait after the child exits for its stdio to close before
   *  giving up on the tail of the stream. */
  readonly stdioGraceMs?: number;
}

export interface RunHandle {
  readonly jobId: string;
  readonly sessionId: string;
  readonly done: Promise<RunOutcome>;
  cancel(reason: string): void;
}

export interface RunOutcome {
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'budget_exceeded';
  readonly exitCode: number | null;
  readonly costUsd: number;
  readonly sessionId: string;
  readonly error: string | null;
  /** As reported by the child's own result line; 0 if it never got that far. */
  readonly numTurns: number;
}

export function buildArgs(job: JobRecord, sessionId: string, opts: RunOptions = {}): string[] {
  const args = [
    '-p',
    job.prompt,
    '--output-format',
    'stream-json',
    // stream-json with -p requires --verbose; without it the CLI refuses.
    '--verbose',
    '--session-id',
    sessionId,
    '--model',
    job.model,
    '--permission-mode',
    job.permissionMode,
  ];
  if (opts.includePartialMessages) args.push('--include-partial-messages');
  if (job.allowedTools?.length) args.push('--allowed-tools', job.allowedTools.join(','));
  return args;
}

/**
 * Spawns one Claude Code child and turns its stdout into events.
 *
 * Budget and timeout are enforced here rather than by the scheduler, because
 * this is the only place holding the process handle. A breach terminates the
 * child; it does not merely record a number.
 */
export class ChildRunner {
  readonly #bus: EventBus;
  readonly #opts: RunOptions;

  constructor(bus: EventBus, opts: RunOptions = {}) {
    this.#bus = bus;
    this.#opts = opts;
  }

  start(job: JobRecord): RunHandle {
    // Pre-minting the session id means the join to the harness registry is
    // known before the process exists, rather than raced for afterwards (§4.1).
    const sessionId = job.sessionId ?? randomUUID();
    const parser = new StreamParser(job.id, sessionId);
    const splitter = new LineSplitter();
    const errSplitter = new LineSplitter();
    const bin = this.#opts.claudeBin ?? 'claude';
    const graceMs = this.#opts.killGraceMs ?? 5_000;
    const stdioGraceMs = this.#opts.stdioGraceMs ?? 2_000;

    const child: ChildProcess = spawn(bin, buildArgs(job, sessionId, this.#opts), {
      cwd: job.cwd,
      // stdin at EOF, or the CLI blocks 3 seconds waiting for input (F12).
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      // Its own process group. Claude Code spawns subprocesses of its own
      // (every Bash tool call is one), and signalling only the parent leaves
      // those grandchildren alive — holding the stdout pipe open, so 'close'
      // never fires and the job hangs in 'running'. Killing the group is the
      // only way to actually stop the tree.
      detached: true,
    });

    let estimatedUsd = 0;
    let authoritativeUsd: number | null = null;
    let outcome: RunOutcome['status'] = 'failed';
    let error: string | null = null;
    let settled = false;
    /** Whether the child published its own terminal event, which decides
     *  whether the runner still owes the log a closing one. */
    let childAnnounced = false;
    let numTurns = 0;

    /** Signal the whole process group, falling back to the bare child if the
     *  group is already gone (ESRCH) or the platform refuses. */
    const signalTree = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already reaped; nothing left to signal.
        }
      }
    };

    const terminate = (why: RunOutcome['status'], message: string): void => {
      if (settled) return;
      settled = true;
      outcome = why;
      error = message;
      signalTree('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalTree('SIGKILL');
      }, graceMs).unref();
    };

    const timer = setTimeout(
      () => terminate('failed', `timeout after ${job.timeoutMs}ms`),
      job.timeoutMs,
    );
    timer.unref();

    const handleLine = (line: string): void => {
      for (const event of parser.parseLine(line)) {
        if (event.type === 'cost.turn') {
          const p = event.payload as { usd?: number };
          estimatedUsd += p.usd ?? 0;
        }
        if (event.type === 'job.finished' || event.type === 'job.failed') {
          const p = event.payload as {
            costUsd?: number | null;
            error?: string | null;
            numTurns?: number | null;
          };
          if (typeof p.costUsd === 'number') authoritativeUsd = p.costUsd;
          if (typeof p.numTurns === 'number') numTurns = p.numTurns;
          // The child has announced its own outcome. The runner's closing
          // event exists to cover the case where it never does, so publishing
          // one now would put two terminal events on the same job — which
          // double-counts in any chart that groups by event type.
          childAnnounced = true;
          if (!settled) {
            settled = true;
            outcome = event.type === 'job.finished' ? 'succeeded' : 'failed';
            error = p.error ?? null;
          }
          // The child emits its own terminal event; the runner records the
          // outcome and lets the process exit on its own.
          this.#bus.publish(event);
          continue;
        }
        this.#bus.publish(event);

        if (estimatedUsd > job.budgetUsd && !settled) {
          this.#bus.publish({
            jobId: job.id,
            sessionId: parser.sessionId,
            ts: new Date().toISOString(),
            source: 'child',
            type: 'job.budget_exceeded',
            payload: { budgetUsd: job.budgetUsd, estimatedUsd, estimated: true },
          });
          terminate('budget_exceeded', `estimated spend $${estimatedUsd.toFixed(4)} exceeded budget $${job.budgetUsd}`);
        }
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) handleLine(line);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of errSplitter.push(chunk)) {
        if (!line.trim()) continue;
        this.#bus.publish({
          jobId: job.id,
          sessionId: parser.sessionId,
          ts: new Date().toISOString(),
          source: 'child',
          type: 'raw',
          payload: { stderr: line },
        });
      }
    });

    const done = new Promise<RunOutcome>((resolve) => {
      let finished = false;
      const finish = (exitCode: number | null): void => {
        // 'exit' and 'close' both route here, and either may arrive first.
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        for (const line of splitter.flush()) handleLine(line);
        const costUsd = authoritativeUsd ?? estimatedUsd;
        const type =
          outcome === 'succeeded' ? 'job.finished'
          : outcome === 'cancelled' ? 'job.cancelled'
          : outcome === 'budget_exceeded' ? 'job.budget_exceeded'
          : 'job.failed';
        // A closing event lands whenever the child did NOT announce one
        // itself — otherwise a killed job would hang in 'running' forever in
        // both the DB and the dashboard. A cancel or a budget kill still needs
        // one even after the child spoke, because the child's word was
        // 'finished' and the truth is that we stopped it.
        if (!childAnnounced || outcome === 'cancelled' || outcome === 'budget_exceeded') {
          this.#bus.publish({
            jobId: job.id,
            sessionId: parser.sessionId,
            ts: new Date().toISOString(),
            source: 'child',
            type,
            payload: { exitCode, costUsd, estimated: authoritativeUsd === null, error, final: true },
          });
        }
        resolve({ status: outcome, exitCode, costUsd, sessionId: parser.sessionId, error, numTurns });
      };

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          outcome = 'failed';
          error = err.message;
        }
        finish(null);
      });
      // 'close' is preferred — it means stdio reached EOF, so the last line of
      // the stream has certainly been read. But it can never arrive if an
      // orphaned grandchild still holds the pipe, so 'exit' arms a bounded
      // wait and then closes the job out regardless.
      child.on('close', (code) => finish(code));
      child.on('exit', (code) => {
        setTimeout(() => finish(code), stdioGraceMs).unref();
      });
    });

    return {
      jobId: job.id,
      get sessionId() {
        return parser.sessionId;
      },
      done,
      cancel: (reason: string) => terminate('cancelled', reason),
    };
  }
}
