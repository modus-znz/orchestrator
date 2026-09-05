import type { UnsequencedEvent } from '../types.js';
import { estimateUsd, priceKeyFor, type ModelPrice, type Usage } from './pricing.js';

/**
 * Parses Claude Code's `--output-format stream-json` into orchestrator events.
 *
 * Written against a real captured stream, not against memory of the format.
 * Three properties of the real stream drive this code (spec §2, F12-F14):
 *
 *  1. Not every line is JSON. The CLI can emit a plaintext warning on stdout
 *     before the stream begins. A parser that assumes JSON-per-line dies on
 *     line one.
 *  2. One API response can arrive as *several* `assistant` events sharing a
 *     single `message.id` — a thinking block and a tool_use block, each
 *     carrying the same `usage`. Summing usage per event double-counts. Cost
 *     is therefore emitted once per distinct message id.
 *  3. Unknown event types are stored raw rather than dropped or thrown on, so
 *     a CLI upgrade degrades the dashboard instead of breaking ingest.
 */
export class StreamParser {
  readonly #jobId: string;
  #sessionId: string;
  readonly #prices: Readonly<Record<string, ModelPrice>> | undefined;
  /** Message ids already billed — see property 2 above. */
  readonly #billed = new Set<string>();

  constructor(
    jobId: string,
    fallbackSessionId: string,
    prices?: Readonly<Record<string, ModelPrice>>,
  ) {
    this.#jobId = jobId;
    this.#sessionId = fallbackSessionId;
    this.#prices = prices;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  #ev(type: UnsequencedEvent['type'], payload: unknown): UnsequencedEvent {
    return {
      jobId: this.#jobId,
      sessionId: this.#sessionId,
      ts: new Date().toISOString(),
      source: 'child',
      type,
      payload,
    };
  }

  parseLine(line: string): UnsequencedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Property 1: plaintext on stdout. Keep it — a warning about stdin or a
      // deprecation notice is exactly the thing you want in the log later.
      return [this.#ev('raw', { text: trimmed, parsed: false })];
    }

    const sid = msg['session_id'];
    if (typeof sid === 'string' && sid) this.#sessionId = sid;

    switch (msg['type']) {
      case 'system':
        return this.#system(msg);
      case 'assistant':
        return this.#assistant(msg);
      case 'user':
        return this.#user(msg);
      case 'result':
        return this.#result(msg);
      case 'rate_limit_event':
        return [this.#ev('rate.limit', msg['rate_limit_info'] ?? null)];
      default:
        return [this.#ev('raw', msg)];
    }
  }

  #system(msg: Record<string, unknown>): UnsequencedEvent[] {
    if (msg['subtype'] !== 'init') {
      return [this.#ev('raw', msg)];
    }
    return [
      this.#ev('job.started', {
        cliVersion: msg['claude_code_version'] ?? null,
        model: msg['model'] ?? null,
        cwd: msg['cwd'] ?? null,
        permissionMode: msg['permissionMode'] ?? null,
        messagingSocketPath: msg['messaging_socket_path'] ?? null,
        tools: msg['tools'] ?? null,
      }),
    ];
  }

  #assistant(msg: Record<string, unknown>): UnsequencedEvent[] {
    const out: UnsequencedEvent[] = [];
    const message = (msg['message'] ?? {}) as Record<string, unknown>;
    const parentToolUseId = msg['parent_tool_use_id'] ?? null;
    const blocks = Array.isArray(message['content']) ? message['content'] : [];

    for (const raw of blocks) {
      const block = (raw ?? {}) as Record<string, unknown>;
      if (block['type'] === 'text') {
        out.push(this.#ev('msg.assistant', { text: block['text'], parentToolUseId }));
      } else if (block['type'] === 'tool_use') {
        out.push(
          this.#ev('tool.use', {
            id: block['id'],
            name: block['name'],
            input: block['input'],
            parentToolUseId,
          }),
        );
      }
      // `thinking` blocks are intentionally not logged. They are the model's
      // scratch work, they are large, and nothing on the dashboard reads them.
    }

    const id = typeof message['id'] === 'string' ? message['id'] : null;
    if (id && !this.#billed.has(id)) {
      this.#billed.add(id);
      const usage = message['usage'] as Usage | undefined;
      const model = message['model'] as string | undefined;
      out.push(
        this.#ev('cost.turn', {
          messageId: id,
          model: priceKeyFor(model),
          wireModel: model ?? null,
          usd: estimateUsd(model, usage, this.#prices),
          estimated: true,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
        }),
      );
    }
    return out;
  }

  #user(msg: Record<string, unknown>): UnsequencedEvent[] {
    const message = (msg['message'] ?? {}) as Record<string, unknown>;
    const blocks = Array.isArray(message['content']) ? message['content'] : [];
    const out: UnsequencedEvent[] = [];
    for (const raw of blocks) {
      const block = (raw ?? {}) as Record<string, unknown>;
      if (block['type'] === 'tool_result') {
        out.push(
          this.#ev('tool.result', {
            toolUseId: block['tool_use_id'],
            isError: block['is_error'] === true,
            content: block['content'],
            parentToolUseId: msg['parent_tool_use_id'] ?? null,
          }),
        );
      }
    }
    return out;
  }

  #result(msg: Record<string, unknown>): UnsequencedEvent[] {
    const failed = msg['is_error'] === true || msg['subtype'] !== 'success';
    return [
      this.#ev(failed ? 'job.failed' : 'job.finished', {
        subtype: msg['subtype'] ?? null,
        isError: msg['is_error'] === true,
        /** Authoritative — supersedes every accumulated cost.turn estimate. */
        costUsd: typeof msg['total_cost_usd'] === 'number' ? msg['total_cost_usd'] : null,
        numTurns: msg['num_turns'] ?? null,
        durationMs: msg['duration_ms'] ?? null,
        result: msg['result'] ?? null,
        permissionDenials: msg['permission_denials'] ?? null,
        modelUsage: msg['modelUsage'] ?? null,
        usage: msg['usage'] ?? null,
        error: failed ? String(msg['result'] ?? msg['subtype'] ?? 'unknown error') : null,
        exitCode: failed ? 1 : 0,
      }),
    ];
  }
}

/** Split a chunked stdout stream into whole lines. */
export class LineSplitter {
  #buffer = '';
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const parts = this.#buffer.split('\n');
    this.#buffer = parts.pop() ?? '';
    return parts;
  }
  flush(): string[] {
    const rest = this.#buffer;
    this.#buffer = '';
    return rest ? [rest] : [];
  }
}
