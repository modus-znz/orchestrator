/**
 * Proof that `types.ts` still matches the daemon it describes.
 *
 * `types.ts` is a hand-kept copy of `daemon/src/types.ts`, for the reasons its
 * own header gives — and it ends by admitting the cost: "a drift shows up as a
 * runtime `undefined`". Nothing checked it, so a field renamed on the daemon
 * side reached the browser as a blank cell in a table nobody was looking at.
 *
 * This file closes that. It imports the daemon's types directly and asserts
 * mutual assignability, which makes a drift a compile error in `npm run
 * typecheck` instead of a silent hole in the dashboard. Nothing imports this
 * module and nothing needs to: `tsconfig.app.json` includes all of `src`, so it
 * is checked, and being type-only it contributes nothing to the bundle.
 *
 * The reach across the workspace is deliberately confined to this one file. The
 * UI still builds standalone, because a type-only import is erased before the
 * bundler ever sees it — what the header warns against is a project reference,
 * which this is not. Verified two ways: `npm run build -w ui` leaves the bundle
 * unchanged, and renaming a field in `daemon/src/types.ts` fails
 * `npm run typecheck -w ui` even against warm `tsc -b` buildinfo.
 *
 * One gap worth naming: mutual assignability alone does not catch a field that
 * is optional on one side and absent on the other, because an optional property
 * is satisfied by its own absence in both directions. The `keyof` assertions
 * further down close that for the record types, which is where optional keys
 * actually accumulate. Required fields, renames, removals and type changes are
 * all caught by assignability on its own.
 *
 * That split is measured, not assumed: adding `readonly _probe?: string` to the
 * daemon's `Settings` leaves `_Settings` green and turns `_SettingsKeys` red,
 * which is exactly the division of labour claimed above.
 */

import type * as D from '../../../daemon/src/types.js';
import type * as U from './types.js';

/**
 * `true` only when A and B are mutually assignable.
 *
 * The false branches yield `false` and not `never`, which is not a stylistic
 * choice: `never` is assignable to every type, so `Assert<never>` satisfies
 * `T extends true` and the whole contract passes vacuously. That is how the
 * first draft of this file compiled clean while asserting that JobStatus and
 * SessionStatus were the same type. `_MechanismWorks` below now guards that
 * regression in-band, so it cannot come back quietly.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Instantiating this with anything but `true` is the compile error. */
type Assert<T extends true> = T;

/**
 * `true` only for literal `false` — and deliberately NOT for `never`.
 *
 * The `never` arm has to come first and cannot be folded into `Same`. Ask
 * `Same<never, false>` and you get: `[never] extends [false]` is true, then
 * `[false] extends [never]` is false, so it returns whatever its mismatch
 * branch returns — which under a regressed `Same` is `never` again, and passes.
 * A guard built out of the very helper it is guarding inherits the bug. This
 * one tests for `never` structurally instead.
 */
type IsExactlyFalse<T> = [T] extends [never] ? false : [T] extends [false] ? true : false;

/**
 * The negative control, live rather than commented out.
 *
 * JobStatus and SessionStatus are genuinely different types, so `Same` must
 * report `false` for them. If someone refactors `Same` back to a `never`
 * mismatch branch, this line goes red while every assertion below would have
 * gone quietly vacuous. It is the one assertion here that fails when the
 * mechanism breaks rather than when the types drift.
 */
export type _MechanismWorks = Assert<IsExactlyFalse<Same<D.JobStatus, U.SessionStatus>>>;

// Enums and unions. A value the daemon can emit and the UI does not list is
// the shape of bug that renders as a missing badge rather than as an error.
export type _JobStatus = Assert<Same<D.JobStatus, U.JobStatus>>;
export type _ModelTier = Assert<Same<D.ModelTier, U.ModelTier>>;
export type _PermissionMode = Assert<Same<D.PermissionMode, U.PermissionMode>>;
export type _FleetKind = Assert<Same<D.FleetKind, U.FleetKind>>;
export type _SessionStatus = Assert<Same<D.SessionStatus, U.SessionStatus>>;
export type _EventType = Assert<Same<D.EventType, U.EventType>>;

// Records. These are the ones that carry numbers onto charts.
export type _StoredEvent = Assert<Same<D.StoredEvent, U.StoredEvent>>;
export type _JobRecord = Assert<Same<D.JobRecord, U.JobRecord>>;
export type _SessionRecord = Assert<Same<D.SessionRecord, U.SessionRecord>>;
export type _HarnessState = Assert<Same<D.HarnessState, U.HarnessState>>;

// Settings is the one the operator writes back, so a drift here is not a
// display bug — it is a PUT the daemon rejects, or worse, silently accepts
// under a key that no longer means what the form thinks it means.
export type _Settings = Assert<Same<D.Settings, U.Settings>>;

// Key sets for the record types, closing the optional-vs-absent gap described
// in the header. Settings is the live case: `prices` was deliberately kept out
// of the writable set, so the next optional key here is a matter of when, not
// whether.
export type _StoredEventKeys = Assert<Same<keyof D.StoredEvent, keyof U.StoredEvent>>;
export type _JobRecordKeys = Assert<Same<keyof D.JobRecord, keyof U.JobRecord>>;
export type _SessionRecordKeys = Assert<Same<keyof D.SessionRecord, keyof U.SessionRecord>>;
export type _HarnessStateKeys = Assert<Same<keyof D.HarnessState, keyof U.HarnessState>>;
export type _SettingsKeys = Assert<Same<keyof D.Settings, keyof U.Settings>>;

// ---------------------------------------------------------------------------
// Phase H is NOT covered here yet, and the reason is worth writing down so the
// next person does not spend the same hour finding it out.
//
// `ToolHealthRow`, `DenialRow`, `TokenRow` and `SkillRow` are exported, so the
// assertions look like four cheap lines — but they live in
// `learning/queries.ts`, next to the SQL that produces them, which imports
// `node:sqlite`. This project sets `"types": []` in `tsconfig.app.json`, and
// that is a guard worth keeping: it is what stops browser code reaching for
// `process.env`. So importing those modules costs four TS2307s, and the fix is
// not to widen `types` — it is to give the row types a node-free home
// (`learning/types.ts`) that both `queries.ts` and this file can import.
//
// `LearningStatus` is a second, separate problem. The daemon's version and the
// UI's are *meant* to differ: the API wraps the daemon shape in an
// `available: false | true` discriminant, so the honest assertion compares the
// daemon type against the `available: true` arm with the discriminant removed,
// not against the union. A plain `Same` here reports a drift that isn't one.
//
// The four `*Response` envelopes are a third: the daemon builds them inline in
// its route handlers, so there is no daemon-side type to compare against at all.
//
// All three are real work rather than extra lines, and this branch is already a
// wide diff waiting to merge. They belong in the follow-up that extracts
// `analytics.ts`, which is queued behind the same merge.
// ---------------------------------------------------------------------------
