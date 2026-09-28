import { afterEach, describe, expect, it } from "vitest";
import { log, logError, logWarn, setLogWriter, writeLine } from "./logger";
import type { LogWriter } from "./logger";

interface Captured {
  error: string[];
  warn: string[];
  info: string[];
}

function capture(): Captured {
  const lines: Captured = { error: [], warn: [], info: [] };
  const writer: LogWriter = {
    error: (line) => lines.error.push(line),
    warn: (line) => lines.warn.push(line),
    info: (line) => lines.info.push(line),
  };
  restore = setLogWriter(writer);
  return lines;
}

let restore: LogWriter | null = null;

afterEach(() => {
  if (restore) setLogWriter(restore);
  restore = null;
});

describe("log", () => {
  it("writes one JSON line, level and event first", () => {
    // Both of those are what a dashboard groups by, and they lead so that a
    // line is recognisable when it is truncated by whatever is reading it.
    const lines = capture();
    logError("action.failed", { action: "createDraft" });

    expect(lines.error).toHaveLength(1);
    expect(lines.error[0]).toBe(
      JSON.stringify({
        level: "error",
        event: "action.failed",
        action: "createDraft",
      }),
    );
  });

  it("sends each level to its own stream", () => {
    const lines = capture();
    logError("api.failed", {});
    logWarn("password_change", {});
    log("info", "auth.session", {});

    expect(lines.error).toHaveLength(1);
    expect(lines.warn).toHaveLength(1);
    expect(lines.info).toHaveLength(1);
  });

  it("refuses to let a field relabel the line", () => {
    // `event` is the value every filter is written against. A caller that could
    // set it could file a line under somebody else's bucket, which is the log
    // equivalent of deleting it.
    const lines = capture();
    log("error", "api.failed", { event: "auth.session", level: "info" });

    expect(JSON.parse(lines.error[0] ?? "")).toEqual({
      level: "error",
      event: "api.failed",
    });
  });

  it("puts every field through the redactor", () => {
    // The property the whole item rests on. Not "the fields somebody remembered
    // to redact" — every field, because the leak is the line nobody designed.
    const lines = capture();
    logError("action.failed", {
      action: "changePassword",
      error: new Error(
        "insert failed: $scrypt$ln=16,r=8,p=2$c2FsdHNhbHQ$a2V5a2V5a2V5a2V5",
      ),
      password: "hunter2",
    });

    const written = lines.error[0] ?? "";
    expect(written).not.toContain("$scrypt$");
    expect(written).not.toContain("hunter2");
    // Still says what failed and where.
    expect(written).toContain("changePassword");
    expect(written).toContain("insert failed");
  });

  it("does not throw on a value JSON cannot take", () => {
    // Almost every call site is inside a `catch`. A writer that throws turns a
    // handled failure into an unhandled one, in the frame that was about to
    // explain it.
    const lines = capture();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(() => {
      logError("api.failed", { circular, big: 2n });
    }).not.toThrow();
    expect(lines.error[0]).toContain("[circular]");
  });
});

describe("setLogWriter", () => {
  it("returns the writer it replaced", () => {
    // So a test's restore is `setLogWriter(previous)` rather than a reset that
    // reaches for the default — a test that reset to the console would silence
    // every later test's assertions about logging, and the failure would be
    // blamed on the wrong file.
    const lines = capture();
    const second: LogWriter = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    const previous = setLogWriter(second);

    logError("api.failed", {});
    expect(lines.error).toHaveLength(0);

    setLogWriter(previous);
    logError("api.failed", {});
    expect(lines.error).toHaveLength(1);
  });
});

describe("writeLine", () => {
  it("redacts a line a module built itself", () => {
    // `src/lib/vitals/sink.ts` and `src/lib/uploads/verify.ts` own their line
    // shapes and document why. What they do not get to own is whether the line
    // is checked.
    const lines = capture();
    writeLine("info", {
      event: "web-vitals",
      path: "/blog",
      apiKey: "sk-live",
    });

    expect(lines.info[0]).not.toContain("sk-live");
    expect(lines.info[0]).toContain("/blog");
  });
});
