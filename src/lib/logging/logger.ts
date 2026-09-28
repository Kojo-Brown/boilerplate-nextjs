/**
 * The only place in this application that writes to `console`.
 *
 * ## Why a module and not a convention
 *
 * `src/lib/logging/redact.ts` decides what a line may contain. It can only do
 * that for lines that go through it, and the previous state of this repository
 * is what that costs: twenty-odd `console.error` calls across the action
 * wrapper, the route wrapper, the idempotency runner, the outbox, the upload
 * path and two env modules, each formatting its own line, several of them
 * handing Node a thrown value to `util.inspect` at its own discretion. Any
 * redactor added next to that has coverage equal to the number of call sites
 * somebody remembered to change.
 *
 * So the rule is that there is one writer, and `scripts/assert-log-redaction.ts`
 * enforces it: a `console.*` call anywhere in `src/` outside this file fails the
 * build. That rule is the feature. The serialiser is just what the writer does.
 *
 * ## Why it still writes to stdout
 *
 * For the reason `src/lib/vitals/sink.ts` already gives: every platform this
 * boilerplate targets collects stdout and every log platform that collects it
 * can parse a JSON line, so this works on the first deploy with nothing
 * configured. A transport is a deployment's choice and is injectable here —
 * `setLogWriter` — rather than a dependency this repository picks for everyone.
 *
 * ## The shape of a line
 *
 * `{"level":"error","event":"action.failed", …}`. `event` is a dotted name
 * chosen from a closed set below, because the thing anyone does first with a
 * log platform is filter, and a filter needs a value that does not change when
 * somebody rewords a sentence. Everything else is fields, and every field goes
 * through the redactor.
 */
import { serialise } from "@/lib/logging/redact";

export type LogLevel = "error" | "warn" | "info";

/**
 * Where a serialised line goes.
 *
 * Separate functions per level rather than one taking a level, so that the
 * default is literally `console.error` / `console.warn` / `console.log` and a
 * platform that treats the three streams differently keeps doing so.
 */
export interface LogWriter {
  error(line: string): void;
  warn(line: string): void;
  info(line: string): void;
}

// The one writer. `no-console` is switched off for this file in
// `eslint.config.mjs` rather than with a disable comment here, because a
// comment is a thing any other file can also type.
const consoleWriter: LogWriter = {
  error: (line) => {
    console.error(line);
  },
  warn: (line) => {
    console.warn(line);
  },
  info: (line) => {
    console.log(line);
  },
};

let writer: LogWriter = consoleWriter;

/**
 * Replaces the writer, and returns the one it replaced.
 *
 * Used by a deployment that has a transport, and by tests that need to read
 * what was written. Returning the previous writer rather than exposing a
 * `reset` is what makes the test spelling `const restore = setLogWriter(spy)` —
 * a test that forgot to restore would otherwise silence every later test's
 * assertions about logging, which is the kind of failure that gets blamed on
 * the wrong file.
 */
export function setLogWriter(next: LogWriter): LogWriter {
  const previous = writer;
  writer = next;
  return previous;
}

/**
 * Every event name this application emits.
 *
 * A closed union rather than a `string`, because the alternative is what this
 * repository had: `[action] createDraft failed:` and `[api] POST /x failed:`
 * and `[idempotency] …`, three prefixes in three formats, none of which a
 * dashboard can group by. Adding a name here is the moment to ask whether the
 * line is worth writing.
 *
 * `password_change`, `password_rehash` and `auth.session` keep the names they
 * were already published under — `docs/session-hardening.md` tells an operator
 * to filter on them — rather than being renamed into a scheme for tidiness.
 */
export type LogEvent =
  | "action.failed"
  | "action.cross_origin_rejected"
  | "api.failed"
  | "auth.session"
  | "config.invalid"
  | "csp.warning"
  | "idempotency.replay_unreadable"
  | "idempotency.release_failed"
  | "idempotency.result_not_recorded"
  | "idempotency.claim_taken_over"
  | "outbox.dispatch_failed"
  | "outbox.receipt_failed"
  | "outbox.claim_taken_over"
  | "password_change"
  | "password_rehash"
  | "upload.quarantine_delete_failed"
  | "vitals.delivery_failed";

/** One line. `fields` may contain anything; none of it is trusted to be safe. */
export function log(
  level: LogLevel,
  event: LogEvent,
  fields: Record<string, unknown> = {},
): void {
  // `level` and `event` lead, and a field of either name is dropped rather
  // than merged: they are the two values a dashboard groups by, and a caller
  // that could overwrite them could hide a line inside another line's bucket.
  const line: Record<string, unknown> = { level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (key === "level" || key === "event") continue;
    line[key] = value;
  }

  writer[level](serialise(line));
}

export const logError = (
  event: LogEvent,
  fields?: Record<string, unknown>,
): void => {
  log("error", event, fields);
};

export const logWarn = (
  event: LogEvent,
  fields?: Record<string, unknown>,
): void => {
  log("warn", event, fields);
};

export const logInfo = (
  event: LogEvent,
  fields?: Record<string, unknown>,
): void => {
  log("info", event, fields);
};

/**
 * Writes a line that is already a complete JSON object, redacted.
 *
 * `src/lib/vitals/sink.ts` and `src/lib/uploads/verify.ts` build their own line
 * shapes and document why — one row per metric, a scanner's own record — and
 * both are part of a public interface a deployment replaces. They get this
 * rather than being rewritten around `log`, and they get it *through the
 * redactor*, which is the only property that matters here.
 */
export function writeLine(level: LogLevel, line: object): void {
  writer[level](serialise(line));
}
