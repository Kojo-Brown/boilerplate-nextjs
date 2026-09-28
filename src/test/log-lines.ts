/**
 * Captures the lines this application writes, for tests that assert on them.
 *
 * Before `@/lib/logging/logger` existed, a test that cared about a log line
 * spied on `console.error` and asserted the arguments it was called with. That
 * spelling asserts the *call*, not the line, and the two stopped being the same
 * thing once the serialiser went in between them: a spy would have been happy
 * with `console.error("token:", secret)` forever.
 *
 * So these helpers swap the writer instead, and what a test gets back is the
 * text that would have reached stdout — redaction included. That is what makes
 * "the log does not contain the password" a statement a test can make.
 */
import { setLogWriter } from "@/lib/logging/logger";
import type { LogLevel, LogWriter } from "@/lib/logging/logger";

export interface CapturedLogs {
  error: string[];
  warn: string[];
  info: string[];
  /** Every line, in the order it was written, whatever its level. */
  lines: string[];
  /** The parsed line at `index`, for asserting on fields rather than on text. */
  parsed(index?: number): Record<string, unknown>;
  /** Puts the previous writer back. Call it from a `finally` or an `afterEach`. */
  restore(): void;
}

export function captureLogs(): CapturedLogs {
  const captured: CapturedLogs = {
    error: [],
    warn: [],
    info: [],
    lines: [],
    parsed(index = 0) {
      return JSON.parse(captured.lines[index] ?? "{}") as Record<
        string,
        unknown
      >;
    },
    restore() {
      setLogWriter(previous);
    },
  };

  const record =
    (level: LogLevel) =>
    (line: string): void => {
      captured[level].push(line);
      captured.lines.push(line);
    };

  const writer: LogWriter = {
    error: record("error"),
    warn: record("warn"),
    info: record("info"),
  };

  const previous = setLogWriter(writer);
  return captured;
}
