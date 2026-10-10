# Orchestrator Phase H — The Learning Store

**Date:** 2026-09-06
**Status:** Approved, implementing
**Supersedes:** nothing. Extends `2026-09-05-orchestrator-design.md` (the base system).

---

## 1. What this is for

The orchestrator runs Claude Code jobs and already records, in fine detail, what
those jobs did. Until now it recorded them only so an operator could *watch* —
the events stream past, land in a projection, and answer questions about the
present. Phase H makes the same data answer questions about the *past*, so the
fleet gets better over time instead of merely visible:

- Which tools do our jobs actually reach for, and how often?
- Which operations fail, and — the part that matters — do they fail because the
  code is wrong or because the *configuration* is wrong?
- Where is token spend going, and which jobs are destroying their own prompt
  cache?
- Which skills are genuinely being invoked, as opposed to merely installed?

Every one of those is answerable from data the daemon captures today. Phase H
adds no new capture. It adds a durable place to keep it, a classification pass
that makes it queryable, and a view that turns each finding into a
recommendation.

## 2. The discovery that shaped the design

Before designing anything, we inspected the live store at
`~/.claude/orchestrator/orchestrator.db` and the job logs under
`~/.claude/orchestrator/jobs/*/events.jsonl`.

**Tool activity is already captured, in structured form.** Job streams carry
`tool.use` and `tool.result`, joined by `toolUseId`:

```json
{"id":"toolu_01VLw…","name":"Read","input":{…},"parentToolUseId":null}
{"toolUseId":"toolu_01VLw…","isError":true,"content":"…permissions…"}
```

`name` gives most-used commands. `isError` gives most-failing operations.
`parentToolUseId` attributes work to subagents. No transcript mining is required
for jobs the orchestrator runs.

**The `raw` bucket is not a coverage gap.** It was the largest single event type
by count, which raised the reasonable worry that unrecognised tool shapes were
landing there unclassified and would silently undercount any `GROUP BY`. They
are not:

| `raw` subtype | count |
|---|---|
| `thinking_tokens` | 32 |
| `hook_started` | 12 |
| `hook_response` | 12 |
| `permission_denied` | 2 |

`permission_denied` turned out to be a gift. It carries `tool_use_id`,
`decision_reason_type` (e.g. `workingDir`) and a human-readable reason, so it
joins directly onto `tool.use`. That is what lets Phase H separate a *config*
failure from a *code* failure — see §5.

**Cache economics are captured and then discarded.** A `cost.turn` payload
carries four token counts:

```json
{"model":"sonnet","usd":0.067,"inputTokens":2,"outputTokens":2,
 "cacheCreationTokens":16318,"cacheReadTokens":19293}
```

The existing `costs` projection stores only `input_tokens` and `output_tokens`.
The two cache figures — by far the most useful token-optimisation signal
available — are dropped on the floor today. Phase H keeps them.

**Registry-watched sessions carry no tool events.** Their JSONL holds only
`session.registered` and `session.gone`. This is a real boundary, stated as a
non-goal in §9 rather than discovered later.

## 3. Storage and lifecycle

**File:** `~/.claude/orchestrator/learning.db` — its own SQLite database, its own
connection, its own WAL, its own `LEARNING_SCHEMA_VERSION`.

### Why a separate file

`orchestrator.db` is explicitly a *projection* (base spec §4.3): on a
`SCHEMA_VERSION` bump it is dropped and rebuilt from the JSONL logs, because the
logs are authoritative and the projection is disposable. Learning data does not
fit that contract, for two reasons:

1. **JSONL retention is an observed absence, not a guarantee.** There is no
   pruning code in `daemon/src/` today — the only `rmSync` is the test-teardown
   helper at `store/index.ts:627`. But the `jobs/` directory grows without
   bound, so log rotation is a matter of *when*, not *if*. The first commit that
   adds it would silently and permanently destroy a projection-based learning
   table. A durable store survives that commit.
2. **Write contention.** `orchestrator.db-wal` already sits at ~4 MB against a
   241 KB main file. Analytic rollups over months of history should not contend
   with the daemon's hot ingest path. A separate file removes the question.

### What "durable" obliges us to do

A store that cannot be fixed by drop-and-rebuild must be correct on the way in.
Three disciplines follow, and they are not optional:

**Additive-only migrations.** New columns arrive via `ALTER TABLE ADD COLUMN`
with defaults. No migration ever drops or renames a column. Schema version is
tracked in a `meta` table and migrations run in order on open.

**Idempotency by construction.** Every row is keyed on `(session_id, seq)` — the
same uniqueness the `events` table already enforces — and written with
`INSERT OR IGNORE`. A daemon restart, a crash between the JSONL write and the
SQLite write, or a full `rebuildFromLogs()` all re-present the same events, and
all of them no-op. This is what makes replay safe on a store that never resets.

**Failure isolation.** Learning ingest is wrapped so it can never throw into the
operational path. If `learning.db` is locked, corrupt or missing, jobs keep
running and the fleet keeps streaming; the daemon counts the drop and surfaces
it in Settings. An observability layer that can take down the thing it observes
is a worse deal than no observability at all.

### Backfill

Backfill is not a separate program. First launch on an existing install replays
`jobs/*/events.jsonl` through the ordinary ingest path; because every write is
idempotent, this is safe to run at any time and any number of times. Subsequent
runs resume from a `watermark(session_id, last_seq)` table.

## 4. Schema

Four fact tables, four views. **Tool content is never stored** — only derived
classifications. That single rule is what keeps the store small, keeps it fast,
and makes it structurally incapable of leaking a path or a secret.

### Fact tables

**`tool_calls`** — one row per `tool.use`.

| column | note |
|---|---|
| `session_id`, `seq` | primary key; the idempotency contract |
| `job_id`, `ts` | |
| `tool_use_id` | the join key to outcomes |
| `parent_tool_use_id` | non-null means a subagent did this work |
| `tool_name` | `Bash`, `Read`, `Skill`, `Agent`, … |
| `arg_class` | the classified shape of the argument — see below |

**`tool_outcomes`** — one row per `tool.result` **or** `permission_denied`.

| column | note |
|---|---|
| `tool_use_id` | primary key |
| `ts` | |
| `outcome` | `ok` \| `error` \| `denied` |
| `deny_reason_type` | e.g. `workingDir`, only for denials |
| `deny_reason` | the harness's own reason, redacted and clipped to 200 chars — the one free-text column, see §11 |

**`turn_costs`** — one row per `cost.turn`.

| column | note |
|---|---|
| `session_id`, `seq` | primary key |
| `job_id`, `ts` | |
| `model`, `wire_model` | |
| `usd`, `estimated` | |
| `input`, `output` | |
| `cache_creation`, `cache_read` | **the columns the existing projection discards** |

**`session_thinking`** — one row per session, holding the maximum
`estimated_tokens` seen. The CLI emits this as a running estimate; we keep the
high-water mark and label it as an estimate wherever it is shown.

Plus **`meta`** (schema version) and **`watermark`** (ingest resume point).

### Two design choices worth defending

**Use and outcome are separate tables joined by a view, not one row updated in
place.** They arrive as separate events. If a `tool.result` were to arrive for a
`tool.use` outside the ingest window, an in-place `UPDATE` would either silently
drop it or race. As two independent append-only facts, both written with
`INSERT OR IGNORE`, arrival order stops mattering entirely and an unmatched
result remains visible as a countable anomaly rather than vanishing.

**`arg_class` is the real answer to "most used commands".** Knowing a fleet ran
`Bash` 890 times is nearly useless; knowing it ran `git` 400 times, `npm` 200 and
`grep` 150 is actionable. So we store a classified shape and never the argument:

| tool | `arg_class` |
|---|---|
| `Bash` | first token of the command — plus the **second** token for an allowlist of multiplexers |
| `Read`, `Edit`, `Write` | file extension only (`.ts`, `.md`, …) |
| `Skill` | the skill name |
| `Agent` | the `subagent_type` |
| anything else | `null` |

The multiplexer allowlist is `git`, `npm`, `pnpm`, `yarn`, `docker`,
`systemctl`, `kubectl`, `cargo`, `gh` — binaries where the subcommand *is* the
verb, so `git commit` and `git log` separate cleanly.

**The allowlist is a security control, not a convenience.** Taking the second
token unconditionally would turn `cat /home/ghost/Desktop/hash.env` into an
`arg_class` containing a secret's path, and the entire redaction-safety argument
would collapse. Only known multiplexers get two tokens; everything else stays at
one.

### Views

Duration is **derived, not stored**: it is the `ts` delta between a `tool_calls`
row and its matching `tool_outcomes` row. Storing it on either table would mean
one of the two append-only facts had to wait for the other, which is exactly the
in-place-update coupling the split above exists to avoid.

| view | answers |
|---|---|
| `v_tool_health` | calls · ok · error · denied · error-rate · p50/p95 duration, per tool and `arg_class` |
| `v_denials` | denials grouped by `deny_reason_type`, tool and `arg_class` — never by path, which the store does not hold |
| `v_token_economics` | per job and model: cache-hit ratio, cost per turn, estimated-vs-actual |
| `v_skill_demand` | Skill invocations by name — the `claude-metrics` export seam |

## 5. Why failures are split two ways

`v_tool_health` and `v_denials` deliberately separate `error` from `denied`.

A permission denial means the *configuration* is wrong: a path outside
`allowedTools`, a `cwd` that does not cover the work. It is fixed once, in
settings, and never recurs. A tool error means the *code* or the *request* is
wrong, and it is fixed in the job.

Averaging them into a single "failure rate" produces a number that recommends
nothing. Separated, each one points at its own fix — which is the whole
difference between a dashboard that diagnoses and one that helps.

## 6. Ingest path

Three new files, so `store/index.ts` does not acquire a second responsibility:

| file | responsibility |
|---|---|
| `daemon/src/learning/classify.ts` | pure `(toolName, input) → argClass`; no I/O, no DB |
| `daemon/src/learning/store.ts` | schema, additive migrations, `ingest()`, watermark |
| `daemon/src/learning/queries.ts` | the read side behind the views |

`classify.ts` is pure and is where all the edge cases live (empty commands,
quoted paths, `env VAR=x cmd` prefixes, extensionless files), so it carries real
unit tests.

`Store.appendEvent` gains one guarded call after its existing events insert:

```ts
try { this.#learning?.ingest(event); }
catch (e) { this.#learningDrops++; }
```

That single call site inherits everything — live ingest, crash replay, and
`rebuildFromLogs()` backfill — because all three already funnel through
`appendEvent`. This mirrors exactly how the `costs` table is already populated
in the same function.

Routing inside `ingest`:

| event | destination |
|---|---|
| `tool.use` | `tool_calls`, `arg_class` via `classify.ts` |
| `tool.result` | `tool_outcomes` — `ok`/`error` from `isError` |
| `raw` + `subtype === 'permission_denied'` | `tool_outcomes` as `denied`, with reason type and text |
| `cost.turn` | `turn_costs`, **including both cache columns** |
| `raw` + `subtype === 'thinking_tokens'` | `session_thinking`, keeping the max |

## 7. API

Five read-only endpoints, behind the existing bearer auth, loopback-only:

```
GET /api/learning/tools    ?since=&job=&limit=   → v_tool_health
GET /api/learning/denials  ?since=               → v_denials
GET /api/learning/tokens   ?groupBy=job|model    → v_token_economics
GET /api/learning/skills                         → v_skill_demand
GET /api/learning/status                         → watermark, row counts, drops, db size
```

`/status` exists so an operator can tell the difference between "no failures"
and "ingest is broken" — a distinction a dashboard must never blur.

## 8. UI — the Phase H controls

A fifth view, **Insights**, reachable on `g` `5`, with four panels:

1. **Tool health** — sortable table of calls / ok / error / denied / p95, with
   error-rate drawn as a bar so outliers find the operator rather than the
   reverse.
2. **Denials → config** — grouped by reason type and path prefix, each row
   ending in a concrete recommendation and a copy button yielding the
   `allowedTools` or `cwd` snippet to paste. This is the panel that makes Phase H
   solution-finding rather than merely diagnostic.
3. **Token economics** — cache-hit ratio per job and model, cost per turn, and
   the estimated-vs-actual spread. A job whose cache-hit ratio collapses is a
   job whose prompt prefix is being destabilised, which is the highest-leverage
   token finding available.
4. **Skill demand** — invocations by name.

Settings gains a **Learning** section: ingest status and watermark, row counts,
database size, a manual backfill trigger, a retention control, and the export
described below.

## 9. Integration, and what this deliberately is not

### The `claude-metrics` seam

A separate, designed-but-unbuilt system (`claude_metrics`, a loopback PostgreSQL
database read by Grafana) answers the *supply-side* question: which of the
listed skills burn listing budget at zero invocations. Its demand-side data was
to come from mining ~800 MB of transcripts.

For orchestrator-run jobs, that mining is unnecessary — we have the same facts
in structured form at source. So Phase H exposes one endpoint,
`GET /api/learning/export?format=metrics`, emitting `tool_event`-shaped rows.
When `claude_metrics` is eventually built, its collector reads that instead.

**No coupling today; a documented contract for tomorrow.** Phase H must not
block on a system that does not exist.

### The three feedback loops

The integration with existing instructions, tools, skills and token
optimisation lands as three concrete loops:

- **Denials → `allowedTools` edits.** The denial panel names the exact setting.
- **Cache-hit ratio → prompt-prefix stability.** A collapsing ratio is a
  destabilised prefix, and that is a fixable cause.
- **Skill demand → listing-budget decisions.** The invocation counts feed the
  budget arithmetic `CLAUDE.md` currently tracks by hand.

### Non-goals

Stated explicitly so the spec cannot quietly grow them:

- No PostgreSQL, no Grafana, no OpenTelemetry.
- No cross-machine aggregation.
- No prediction, scoring or ML.
- **No storing tool content, ever.** Classifications only.
- **No coverage of registry-watched sessions.** Phase H learns from jobs the
  orchestrator *runs*. Observed sessions emit only `session.registered` and
  `session.gone` — verified against their JSONL. Machine-wide coverage belongs
  to `claude_metrics`, not here.

## 10. Testing

| layer | approach |
|---|---|
| `classify.ts` | unit tests on the edge cases — empty command, `env` prefixes, quoted paths, multiplexer vs non-multiplexer second token, extensionless files, unknown tools |
| `store.ts` | idempotency (double-ingest the same event, assert one row), migration from an older version, failure isolation (a broken DB must not throw into `appendEvent`) |
| `queries.ts` | fixture-driven assertions on each view, including the error/denied split |
| API | auth required, shape of each response, `since` filtering |
| end-to-end | backfill the real `jobs/*/events.jsonl` and assert the counts match the event totals already measured (10 `tool.use`, 10 `tool.result`, 2 `permission_denied`, 15 `cost.turn`) |

## 11. Security

Phase H inherits the base spec's §11 posture unchanged: loopback bind only,
bearer token required even on loopback, no new listening ports, no new
credentials, nothing written outside `~/.claude/orchestrator/`.

It adds one control of its own, and it is the important one: **the store is
structurally incapable of holding tool content.** Redaction is not a filter
applied at render time that a future query could bypass — the content simply
never enters the database. `arg_class` is a bounded classification and the
multiplexer allowlist (§4) is the guard that keeps it bounded.

**One column is a documented exception, and it is worth being exact about it.**
`deny_reason` is free text authored by the harness, and while it is close to a
fixed set in practice (`Path is outside allowed working directories`), one
observed variant quotes the command it refused: `find with '-exec' executes
commands or modifies files — cannot be auto-allowed by a Bash(find:*) prefix
rule`. So it is not a bounded enum and cannot honestly be described as one.

It is kept, because dropping it would leave the denials panel able to say only
that *something* was refused — which recommends nothing, and recommending
something is the entire reason the panel exists. It is made safe by passing it
through the daemon's own `redactString` and clipping it to 200 characters
before it is stored. That reuses one redaction implementation rather than
inventing a second rule for this column, and the clip bounds the blast radius
of any future harness message that turns out to be chattier than these two.
Every other column in the store remains content-free by construction.
