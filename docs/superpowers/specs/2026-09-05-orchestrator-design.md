# Orchestrator — Design Spec

**Date:** 2026-09-05
**Status:** Approved for implementation
**Author:** Claude Opus 5 (session ghost-56)

## 1. Purpose

Run, observe, and steer many Claude Code sessions as one fleet, from a skill
inside a Claude session and from a local web dashboard.

Today, parallel work on this machine means opening terminals by hand and
remembering what each one is doing. There is no queue, no dependency ordering,
no cost ceiling, no history, and no single view of what the fleet is doing
right now. The orchestrator supplies all six.

### Goals

- Dispatch a set of jobs with concurrency limits and dependency ordering.
- Observe every live session — spawned or not — in one view.
- Steer a running session: deliver an instruction into it from outside.
- Attach a terminal to any job for hands-on takeover.
- Record everything queryable: cost, duration, tool use, failures.
- Configure it all — model tier per job, budget caps, permission modes,
  allowed tools, retry policy — without editing code.

### Non-goals

- **Not a Claude Code replacement.** It drives the real CLI; it does not
  reimplement the agent loop.
- **Not remote-accessible in v1.** Loopback only. Remote is a later,
  deliberate Tailscale step (§9).
- **Not a transcript browser.** `~/.claude/projects/*.jsonl` (105 files,
  privacy-loaded, large) stays out of ingest. A per-job replay view is a
  possible later opt-in, not v1 scope.
- **Not a terminal multiplexer.** Terminals are an attach surface, not the
  control plane (§4.1).

## 2. Verified facts

Everything below was probed on this machine on 2026-09-05, not assumed. Each
one constrains the design; the citation is so a future reader can re-run it.

| # | Fact | Evidence |
|---|------|----------|
| F1 | `claude -p --output-format stream-json` emits a complete, parseable event stream with `session_id`, per-turn cost, and a terminal `result`. | Probe returned `is_error: false`, `permission_denials: []`. |
| F2 | A headless print session **can** call `SendMessage` to a named peer. | Courier probe: `result: 'SENT'`, no denials, $0.043; message physically arrived in the target session. |
| F3 | A running courier registers itself as a live peer in the session registry. | Probe appeared as `scratchpad-b2`, socket `/run/user/1000/cc-socks/254422.sock`. |
| F4 | `~/.claude/sessions/<pid>.json` is a live registry carrying **full session identity**, not just a handle: `pid`, `sessionId`, `procStart`, `pidDomain`, `cwd`, `name`, `nameSource`, `nameSince`, `kind`, `entrypoint`, `status`, `statusUpdatedAt`, `startedAt`, `updatedAt`, `bridgeSessionId`, `messagingSocketPath`, `peerProtocol`, `peerFeatures`, `version` — 19 keys, identical shape in every file. | 7 live records, all keys dumped and compared (re-verified 2026-09-05). |
| F5 | `~/.claude/jobs/<8hex>/` keys on `sessionId[:8]`, confirmed for all 7 dirs (`dirname == sessionId[:8] == daemonShort`). | Join test, 7/7 true. |
| F6 | `~/.claude/jobs/` covers **daemon-backed sessions only**. Zero of 7 live interactive sessions have a dir; all 7 existing dirs are `backend: "daemon"` and stale (Aug 9–18). | Same test, `jobdir=no` for every live session. |
| F7 | The **rich** status feed (`state`, `tempo`, `inFlight`, `fan`, `tokens`) exists only in that daemon-backed store — i.e. it is **not** available for an arbitrary interactive session. A **coarse** `status` (`shell` \| `idle` \| `busy`) is a separate thing and *is* published per-session by the registry (F4). | Key-shape dump of all 7 `state.json`; coarse status observed live across all 7 registry files. |
| F8 | ghostty has **no** send-to-existing-window IPC — spawn-only via `-e <cmd>`. konsole exposes full D-Bus via `qdbus6` while running. kitty needs `allow_remote_control` (not set). No tmux, no zellij installed. | Terminal capability probes. |
| F9 | Harness state can contain plaintext secrets. `jobs/0c762231/adopt.json` held a live `DATABASE_URL`, `SESSION_SECRET`, and `ADMIN_PASSWORD` inside a captured command string. | Direct read. |
| F10 | Model tier is a real cost lever: 5.8x Opus:Haiku on an identical trivial prompt ($0.274 vs $0.047). | Two probe runs. |
| F11 | Node 24.15.0 is installed, so `node:sqlite` is built in — no `better-sqlite3`, no native build step. | `node -v`. |
| F12 | `stream-json` stdout is **not** JSON-per-line: the CLI can emit a plaintext warning first (`Warning: no stdin data received in 3s`). It also *blocks 3 seconds* waiting on stdin unless stdin is already at EOF. | Captured stream, line 1. |
| F13 | Authoritative cost appears exactly once, in the terminal `result` as `total_cost_usd` (plus `modelUsage` per model). `assistant` events carry token `usage` but no money. | Same capture. |
| F14 | One API response can arrive as **several** `assistant` events sharing a single `message.id`, each repeating identical `usage`. Naive per-event summing double-counts. | Same capture: two events, same id, `usage` identical. |
| F15 | `system`/`init` carries `claude_code_version`, `model`, `cwd`, `permissionMode`, `messaging_socket_path`. `result` carries `permission_denials`, `num_turns`, `duration_ms`. | Same capture. |
| F16 | `--session-id <uuid>` is **accepted and honoured**: a pre-minted uuid comes back verbatim in every `session_id` field, exit 0. The job→session join therefore exists before the child produces a byte. |
| F17 | A killed child's `'close'` can never arrive while an orphaned grandchild holds the stdout pipe. Claude Code spawns subprocesses of its own, so the child must be spawned `detached` and signalled as a **process group**, with `'exit'` arming a bounded wait for `'close'`. |
| F18 | The registry's `procStart` equals field 22 of `/proc/<pid>/stat` (process start time in clock ticks since boot). Comparing them is therefore a sound liveness test that a **recycled pid cannot pass** — a registry file left behind by a killed session is detectable, where a bare `/proc/<pid>` existence check would be fooled. | Compared for all 7 live pids; 7/7 exact match. |
| F19 | Peer `name` is `nameSource: "derived"` for every live session (`ghost-71`, `ghost-93`, …) — generated, not operator-assigned, and therefore **not stable across a restart**. It is a delivery address for the courier, never an identity or a durable allowlist entry. | `nameSource` read from all 7 files. |

## 3. Architecture

A single long-lived daemon owns all state. Every other piece — the skill, the
CLI, the web UI — is a client of its HTTP API. There is exactly one writer.

```
  orchestrator skill ─┐
  orc CLI ────────────┼──► orchestratord (127.0.0.1) ──► SQLite (queryable)
  web UI ─────────────┘         │                    └─► JSONL per job (truth)
                                │
                    ┌───────────┼───────────┬──────────────┐
                    ▼           ▼           ▼              ▼
              spawn child   registry     courier      terminal spawn
              claude -p     watcher      claude -p      ghostty -e
              stream-json   sessions/*   SendMessage    konsole D-Bus
```

**Why a daemon rather than the skill driving processes directly:** a Claude
session ends. Jobs outlive it, the dashboard must serve when no session is
open, and two sessions dispatching concurrently would race on the same job
table. One owner, many clients.

### 3.1 Rejected alternatives

- **Terminal-driven control** (write keystrokes into konsole/ghostty). Rejected
  on F8 and on principle: injected text yields characters on a screen, not
  events. You cannot build a status graph out of a scrollback buffer, and
  ghostty cannot receive at all.
- **Pure file-watching, no daemon.** Rejected on F6/F7: the rich feed does not
  exist for interactive sessions, so a watcher-only design would show an almost
  empty dashboard.
- **Reverse-engineering the peer unix sockets.** Rejected: `SendMessage` via a
  courier (F2) achieves the same on documented surface.

## 4. Identity and data model

Four identifier spaces exist on this machine. The design names one primary key
and treats the rest as joins.

- **`sessionId`** (UUID) — the harness's identity for one Claude session.
  **This is the primary key for anything session-shaped.**
- **`jobId`** (orchestrator-assigned ULID) — one unit of intended work. A job
  maps to *one or more* sessionIds over its life, because `--resume` and
  `--fork-session` mint new ones. Job ≠ session, and conflating them would
  break history the first time a job is resumed.
- **`pid`** — the registry filename (F4). Volatile; a join handle only, never
  stored as identity.
- **`sessionId[:8]`** — the harness `jobs/` directory name (F5). A *foreign*
  keyspace. Join on it, never mint it.

### 4.1 Ingest sources, ranked

**Source A — spawned children (primary, rich).** Every job the orchestrator
starts runs as `claude -p --output-format stream-json --include-partial-messages
--session-id <uuid>`. The orchestrator pre-mints the session UUID, so the join
is known before the process starts. This stream carries messages, tool calls,
tool results, per-turn cost, and the terminal result. Everything the dashboard
promises about a job comes from here.

**Source B — session registry (fleet-wide, moderate).** Watch `~/.claude/sessions/*.json`.
Yields real `sessionId`, name, cwd, pid, coarse `status`, and liveness for
*every* session including ones the orchestrator never spawned (F4). This is what
makes the fleet view honest about the whole machine.

Two rules govern reading it. **Read narrowly** — the file carries 19 keys and a
live `peerToken`; every field depended on is a field that can break the daemon,
and the token must never reach an event payload. **Validate liveness, don't
assume it** — a registry file outlives a killed session, so a file counts as a
session only when `/proc` agrees the pid is alive *and* its start time still
matches the file's `procStart` (F18). Existence checks alone hand a dead
session's identity to whatever recycled its pid.

**Source C — harness daemon store (advisory, sparse).** `~/.claude/jobs/<sid8>/`
gives `state`, `tempo`, `inFlight`, `fan`, `tokens` — but only for daemon-backed
sessions (F6, F7). Read it when present, enrich the row, and **never** render a
placeholder when absent.

Because of F6/F7 the UI must distinguish two row classes and say so visibly:
**managed** (source A — full detail, including cost and the message stream) and
**observed** (source B — identity, cwd, coarse `status`, liveness). The coarse
status makes the observed class considerably more useful than a green dot, but
the classes are still not interchangeable: a dashboard that shows an empty
`tempo` or `$0.00` cost column for an observed row is lying by omission.

**Ephemeral couriers are filtered from the fleet view** on F3: a session whose
pid matches a courier the daemon spawned is suppressed.

### 4.2 Event envelope

One shape for all three sources:

```ts
interface Event {
  jobId: string | null;      // null for observed-only sessions
  sessionId: string;
  seq: number;               // monotonic per sessionId
  ts: string;                // ISO 8601
  source: 'child' | 'registry' | 'harness';
  type: EventType;
  payload: unknown;          // discriminated on type
}

type EventType =
  | 'job.queued' | 'job.started' | 'job.finished' | 'job.failed'
  | 'job.cancelled' | 'job.budget_exceeded'
  | 'msg.assistant' | 'msg.user'
  | 'tool.use' | 'tool.result'
  | 'cost.turn'
  | 'session.registered' | 'session.gone' | 'session.state'
  | 'steer.sent' | 'steer.failed';
```

`seq` is assigned by the daemon on ingest, not by the source, so ordering
survives a source that has no sequence of its own (registry files do not).

### 4.3 Storage

Two tiers, deliberately redundant:

- **`~/.claude/orchestrator/jobs/<jobId>/events.jsonl`** — append-only, fsync on
  terminal events. This is crash-truth.
- **`~/.claude/orchestrator/orchestrator.db`** — `node:sqlite` (F11). Tables:
  `jobs`, `sessions`, `events`, `costs`, `settings`. Queryable, indexed, and
  **fully rebuildable from the JSONL**. A corrupt DB is an inconvenience, never
  a data loss.

### 4.4 Redaction

On F9, every event payload passes a redaction filter before it touches either
tier. Patterns: `*_SECRET`, `*_PASSWORD`, `*_TOKEN`, `*_KEY`, `DATABASE_URL`,
`postgres://user:pass@`, `Authorization:` headers, and anything matching the
contents of `~/.claude/orchestrator/redact.txt` (a user-editable literal list).
Redaction happens at ingest, so the on-disk log never holds the secret — not at
render, which would leave it on disk forever.

### 4.5 Cost accounting

F13 forces a two-stage design, because budget enforcement must act *during* a
run while the only trustworthy number arrives at the *end* of it.

- **During the run:** each distinct `message.id` (F14) yields one `cost.turn`
  carrying token usage and a USD figure **estimated** from a price table in
  settings. Cache writes are charged above plain input and cache reads below
  it. An unrecognised model prices as the most expensive tier, so an unknown
  model kills early — stopping a job early is a far cheaper mistake than
  failing to stop a runaway one.
- **At the end:** `result.total_cost_usd` overwrites the accumulated estimate.
  The stored cost for a finished job is always the authoritative figure.

Estimated values are flagged `estimated: true` in the event payload, and the UI
labels a running job's cost as an estimate rather than presenting it as fact.

F12 additionally requires that children are spawned with **stdin already at
EOF**, or every job pays a silent 3-second startup tax.

## 5. orchestratord

Node 24, TypeScript strict. Modules, each independently testable:

- **`registry/`** — watches `~/.claude/sessions/`, debounced; emits
  `session.registered` / `session.gone`. Reads source C when present.
- **`runner/`** — spawns children, parses `stream-json` line-delimited, enforces
  per-job budget and timeout, kills on breach.
- **`scheduler/`** — concurrency limit and dependency DAG. Cycle detection at
  submit time, refusing the batch rather than deadlocking at run time.
- **`bus/`** — assigns `seq`, redacts, fans out to store and SSE subscribers.
- **`store/`** — SQLite + JSONL writer, plus `rebuild()` from JSONL.
- **`courier/`** — steer delivery (§6).
- **`api/`** — REST + SSE.

### 5.1 API

```
GET    /api/health
GET    /api/fleet                  -> managed + observed sessions
GET    /api/jobs?status=&since=
POST   /api/jobs                   -> submit one or a batch with deps
GET    /api/jobs/:id
GET    /api/jobs/:id/events?from=seq
POST   /api/jobs/:id/cancel
POST   /api/sessions/:sessionId/steer   -> { text }  (opt-in gated, §6)
POST   /api/sessions/:sessionId/attach  -> spawn terminal
GET    /api/stats/{cost,concurrency,tools,failures}?bucket=
GET    /api/settings
PUT    /api/settings
GET    /api/stream                 -> SSE, all events, resumable via Last-Event-ID
```

Steer and attach are addressed by `sessionId`, not `jobId`, precisely because
an observed session has no job (§4.1) yet must still be steerable and
attachable. For a managed job the daemon resolves its current sessionId first.

Binds `127.0.0.1` only. A bearer token from `~/.claude/orchestrator/token`
(mode 600) is required on every route including loopback, because any process
on this box can reach loopback and this API spawns Claude sessions.

## 6. Steering

Confirmed buildable by F2. The daemon spawns a short-lived
`claude -p --allowed-tools SendMessage --model haiku` that relays the text to the
target peer by name. Cost is ~$0.04 per steer.

Two hard rules:

1. **Opt-in per session, off by default.** A session accepts steering only if
   explicitly enabled in settings or marked steerable at submit. Steering is
   remote instruction injection into an agent with tool access; it is not a
   default-on capability.
2. **Couriers for writes only, never reads.** A status poll through a courier
   costs real money for information already free in sources A/B/C. The daemon
   must never issue a courier to *ask* anything.

A consequence of F19 worth stating outright: the courier addresses its target by
peer **name**, but names are derived and change across a restart. So the
allowlist is checked against the name *as resolved from the live fleet row*, and
the durable record of "who may be steered" is the sessionId. A name that no
longer resolves to a live session is a refusal, never a best-effort send — the
alternative is paying $0.04 to deliver an instruction to whoever inherited the
name.

For jobs the daemon itself spawned there is a cheaper future path — keeping the
child alive on `--input-format stream-json` and writing to its stdin, no courier
and no cost. Noted as a v2 optimisation; v1 uses the courier uniformly so both
managed and observed sessions steer through one code path.

## 7. orc CLI

Thin HTTP client, no logic of its own:

```
orc run <prompt> [--model] [--cwd] [--depends-on] [--budget <usd>] [--steerable]
orc batch <file.json>
orc ps [--all]
orc logs <job> [-f]
orc cancel <job>
orc steer <job> <text>
orc attach <job> [--terminal ghostty|konsole]
orc fleet
orc daemon [start|stop|status]
```

## 8. The skill

`~/.claude/skills/orchestrator/SKILL.md`. Description ≤135 chars, trigger
first, no `when_to_use` (listing-budget rule). Content teaches: decompose work
into a job DAG, choose a model tier per job (F10 — Haiku for search and
mechanical edits, Opus for judgment), set budgets, dispatch via `orc`, monitor,
collect results, report. References in separate files so the SKILL.md body
stays small.

Registered in `claude-router` in the same edit as any visibility change.

## 9. Terminal attach

`orc attach` spawns a fresh terminal running `claude --resume <sessionId>`:

- **ghostty:** `ghostty -e claude --resume <sid>` (spawn-only, F8).
- **konsole:** new tab via `qdbus6` when a konsole is already running,
  otherwise `konsole -e`.
- Anything else: print the command for the user to paste.

Attach is a handover, not a control channel. Once a human is driving that
terminal, the orchestrator keeps observing but stops steering it.

## 10. Web UI

React + Vite + TypeScript strict, Tailwind, Recharts. Mobile-first. Built with
the existing `react-vite-dashboard` skill. Served by the daemon on loopback.

Views:

- **Fleet** — live table, managed vs observed clearly distinguished (§4.1),
  state, cwd, model, cost so far, age.
- **Job detail** — live event stream, tool timeline, cost accumulation,
  steer box (only if steerable), attach button.
- **Graphs** — fleet Gantt of job spans; concurrency over time; cost by
  job/model/hour; queue depth; tool-call histogram; state distribution;
  failure taxonomy.
- **Settings** — concurrency, default model tier, budget caps, permission
  mode, allowed-tools presets, retry policy, terminal preference, steer
  allowlist, redaction patterns.

Every number on every chart traces to an event in the store. No derived value
is hand-computed in the UI.

## 11. Security

This box runs arbitrary Bash and keeps `hash.env` on the Desktop. Therefore:

- Loopback bind only. No `0.0.0.0`, ever, at any point of the build.
- Bearer token required even on loopback; token file mode 600.
- Redaction at ingest (§4.4), on the evidence of F9.
- Hard budget caps with automatic kill. Budgets are **USD, per job**, checked
  against accumulated `cost.turn` events after every turn; breaching one emits
  `job.budget_exceeded` and SIGTERMs the child. Mid-run the check uses the
  estimate (§4.5); it is a kill switch, not a billing record. **The bound is the
  cap plus one turn's overshoot**, not the cap: a turn's cost is only known once
  its `assistant` event arrives, which is after the tool calls it paid for. A
  runaway *loop* is therefore bounded by construction, but a single enormous
  turn can exceed the cap once before the kill lands.
- Children are spawned `detached` and killed as a **process group** (F17).
  Signalling only the parent leaves Claude Code's own subprocesses running —
  which both burns money after a "kill" and holds the stdout pipe open, hanging
  the job in `running`.
- Steering opt-in, off by default (§6).
- The repo `.gitignore`s `*.db`, `events.jsonl`, `token`, `redact.txt` — the
  code is shareable, the captured session data is not.
- Remote access, when it comes, is Tailscale-only and a separate decision.

## 12. Testing

- **Unit:** event normalisation from recorded `stream-json` fixtures; redaction
  filter against a fixture derived from the F9 `adopt.json` shape; DAG cycle
  detection; scheduler concurrency.
- **Integration:** real `claude -p --model haiku` child on a trivial prompt,
  asserting the full event sequence and a terminal `result`. Cheap enough
  (~$0.05) to run.
- **Recovery:** kill the daemon mid-job, restart, assert the DB rebuilds from
  JSONL and the orphaned job is marked, not lost.
- **UI:** the dashboard renders correctly with zero jobs, with observed-only
  sessions, and with a failed job. Empty and degraded states are tested, not
  assumed.

## 13. Build order

1. Event model + types + redaction (blocks everything).
2. Store: SQLite + JSONL + rebuild.
3. Runner + scheduler.
4. Registry watcher.
5. API: REST + SSE.
6. `orc` CLI.
7. Skill + `claude-router` entry.
8. Web UI.
9. Packaging: `claude-hub` mirror, close-out.

## 14. Open risks

- **`stream-json` is not a frozen contract.** A CLI upgrade could change event
  shapes. Mitigation: the parser tolerates unknown event types by storing them
  raw rather than throwing, and the CLI version is recorded per job.
- **Courier cost drift.** At ~$0.04 a steer, a chatty operator is a real bill.
  Mitigation: steer rate limit in settings, cost surfaced in the UI next to the
  steer box.
- **Source C may be a private harness detail.** It is advisory only (§4.1), so
  if it disappears the dashboard degrades from rich to thin rather than
  breaking.
