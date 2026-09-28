/**
 * Holds every log line in this application to one writer, and that writer to
 * the redactor.
 *
 * ## What this gate is for
 *
 * `src/lib/logging/redact.ts` can only refuse a value it is shown. Before this
 * item there were twenty-odd `console.*` calls across the action wrapper, the
 * route wrapper, the idempotency runner, the outbox, the upload path and two
 * env modules, several of them handing Node a thrown value to format at its own
 * discretion — and the live defect was one of those:
 * `console.error("[action] " + name + " failed:", thrown)` wraps every Server
 * Action, the password change included, while `util.inspect` prints an Error's
 * stack *and every own enumerable property*, which is where `pg` puts the
 * statement it failed on.
 *
 * Adding a serialiser next to that gives coverage equal to the number of call
 * sites somebody remembered to change, and the number does not stay put: the
 * next `console.error` is one keystroke and passes review, because it looks
 * exactly like the twenty already there. So the invariant is not "lines are
 * redacted", which nothing can check, but "there is one writer" — which this
 * can.
 *
 * `no-console` in `eslint.config.mjs` is the first layer and catches the
 * typing of it. This is the second and catches what a lint rule cannot: an
 * `eslint-disable` comment, the rule being deleted from the config, a
 * `globalThis.console` or `process.stdout.write` spelling, a module dropping
 * its import of the logger and building the line itself, and the redactor being
 * quietly unwired from inside the writer.
 *
 * ## R — the rules
 *
 *   R1  No `console.*`, `process.stdout.write` or `process.stderr.write` in
 *       `src/` outside the writer and the enumerated exceptions. This is the
 *       rule; everything else here protects it.
 *   R2  The exceptions are the ones in `CONSOLE_EXCEPTIONS`, each with a
 *       reason, and each still a client-only module. An entry that stops being
 *       client-only — no `"use client"`, no browser-only role — is a hole,
 *       because the argument for every one of them is that its output reaches a
 *       browser console and not a collected stream.
 *   R3  A stale exception fails too. An entry that no longer writes to the
 *       console is an allowance sitting in the file waiting for a module of
 *       that name.
 *   R4  `eslint.config.mjs` still turns `no-console` on for `src/`, and turns
 *       it off for exactly the files in `CONSOLE_EXCEPTIONS` plus the writer.
 *       The two layers are only two layers while they agree.
 *   R5  The writer serialises through `@/lib/logging/redact`. Without this the
 *       gate is satisfied by one module printing whatever it likes — and the
 *       edit that does it is deleting one call inside a file the rules above
 *       are busy protecting.
 *   R6  Nothing outside the logging module imports `redact` to *stringify*.
 *       A module that redacts its own line and writes it with something else
 *       has re-created the problem with a second serialiser.
 *
 * ## P — what the serialiser actually does, probed
 *
 * The rules above are regexes over source, which answer "is the wiring still
 * here" and not "does it still work". So the gate imports the module — from
 * `root`, so the tests can sabotage a copy and watch these fail too — and runs
 * this repository's own secret formats through it.
 *
 *   P1  Every value in `SECRET_FIXTURES` is refused. Each one is a format this
 *       application mints, not a string written to match a regex: the
 *       five-segment JWE `@auth/core/jwt` issues, the PHC hash
 *       `src/lib/password.ts` writes *derived here by scrypt at the parameters
 *       that module declares*, the legacy hash format it replaced, the SigV4
 *       query a presigned PUT carries, the `DATABASE_URL` shape.
 *   P2  Every value in `PRINTABLE_FIXTURES` survives. This is the half that
 *       decides whether the feature is usable rather than merely safe: a
 *       redactor that eats `sid` leaves an audit trail nobody can correlate.
 *   P3  A secret inside a driver's message is taken out of the message, and the
 *       rest of the message survives. The whole-value and substring passes are
 *       separate code paths and this is the one the live defect needed.
 *   P4  The serialiser does not throw on a circular structure, a bigint or a
 *       getter that raises. Nearly every call site is inside a `catch`; a
 *       writer that throws turns a handled failure into an unhandled one.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { scryptSync, randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export interface Finding {
  rule: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "P1" | "P2" | "P3" | "P4";
  file: string;
  message: string;
}

export const REDACT_FILE = "src/lib/logging/redact.ts";
export const LOGGER_FILE = "src/lib/logging/logger.ts";
export const ESLINT_CONFIG = "eslint.config.mjs";

/**
 * Every module in `src/` allowed to touch the console, and why.
 *
 * All of them run only in a browser. That is the whole argument: redaction
 * exists to keep a secret out of a stream somebody collects, ships, indexes and
 * retains — and a browser console is the console of the person who caused the
 * error, holding a value that is already in that browser's memory. Routing
 * these through the serialiser would put it, and its pattern table, into the
 * client bundle to protect nothing.
 *
 * `src/lib/env/client.ts` has a second reason, and it is the stronger one: the
 * only thing it can print is a validation failure of a `NEXT_PUBLIC_*`
 * variable, and a schema that contains no secrets is the entire purpose of the
 * server/client env split.
 */
export const CONSOLE_EXCEPTIONS: readonly { file: string; why: string }[] = [
  {
    file: "src/lib/env/client.ts",
    why: "validates NEXT_PUBLIC_* only, which is public by construction, and runs in the browser",
  },
  {
    file: "src/app/blog/error.tsx",
    why: "a client error boundary: writes to the browser's own console",
  },
  {
    file: "src/app/blog/[slug]/error.tsx",
    why: "a client error boundary: writes to the browser's own console",
  },
  {
    file: "src/app/photos/error.tsx",
    why: "a client error boundary: writes to the browser's own console",
  },
  {
    file: "src/app/photos/[id]/error.tsx",
    why: "a client error boundary: writes to the browser's own console",
  },
  {
    file: "src/app/pricing/error.tsx",
    why: "a client error boundary: writes to the browser's own console",
  },
  {
    file: "src/app/pricing/v/[variant]/error.tsx",
    why: "a client error boundary: writes to the browser's own console",
  },
  {
    file: "src/app/(dashboard)/upload/error.tsx",
    why: "a client error boundary: writes to the browser's own console",
  },
  {
    file: "src/app/(dashboard)/settings/security/error.tsx",
    why: "a client error boundary: writes to the browser's own console",
  },
];

/** `console.x(`, `globalThis.console.x(`, and the two `process` streams. */
const CONSOLE_WRITE =
  /(?:\bglobalThis\s*\.\s*)?\bconsole\s*\.\s*(?:log|error|warn|info|debug|trace|dir)\s*\(|\bprocess\s*\.\s*std(?:out|err)\s*\.\s*write\s*\(/;

function read(root: string, relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/**
 * Comments stripped before every search.
 *
 * Both logging modules discuss `console.error` at length, and the exception
 * list's reasons name the thing they permit. A gate that matched its own
 * documentation would report every file that explains itself and pass one whose
 * prose is intact and whose code is gone.
 */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Line comments only, for `eslint.config.mjs`.
 *
 * `withoutComments` cannot be used on that file, and finding out why took a
 * failing gate: a glob like `"src/app/**\/error.tsx"` contains the four
 * characters `/`, `*`, `*`, `/`, which is a complete block comment to any
 * stripper that does not parse string literals — so removing comments removed
 * the globs this rule exists to read, and R4 reported eight files as unexempted
 * that the config exempts on one line. Every comment in that file is a `//`
 * one, so this is sufficient there and nowhere else.
 */
export function withoutLineComments(source: string): string {
  return source.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every `.ts`/`.tsx` under `src/` that is not a test, repo-relative. */
export function sourceFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
        found.push(child);
    }
  };

  walk("src");
  return found;
}

function staticRules(root: string): Finding[] {
  const findings: Finding[] = [];
  const exceptions = new Map(
    CONSOLE_EXCEPTIONS.map((entry) => [entry.file, entry]),
  );
  const writesToConsole = new Set<string>();

  // R1 — one writer.
  for (const file of sourceFiles(root)) {
    if (!CONSOLE_WRITE.test(withoutComments(read(root, file)))) continue;
    writesToConsole.add(file);

    if (file === LOGGER_FILE || exceptions.has(file)) continue;

    findings.push({
      rule: "R1",
      file,
      message:
        "writes to the console directly. Every line in this application goes " +
        `through ${LOGGER_FILE}, which is what puts it past ` +
        `${REDACT_FILE} — a redactor with a bypass this short has coverage ` +
        "equal to the number of call sites somebody remembered. If this line " +
        "genuinely cannot go through the logger, it belongs in " +
        "CONSOLE_EXCEPTIONS with the reason, and the reason has to be that it " +
        "never reaches a collected stream.",
    });
  }

  for (const entry of CONSOLE_EXCEPTIONS) {
    const full = path.join(root, entry.file);

    // R3 — no stale allowances.
    if (!existsSync(full)) {
      findings.push({
        rule: "R3",
        file: entry.file,
        message:
          "is in CONSOLE_EXCEPTIONS and does not exist. A stale allowance is " +
          "a hole waiting for a module of that name.",
      });
      continue;
    }

    if (!writesToConsole.has(entry.file)) {
      findings.push({
        rule: "R3",
        file: entry.file,
        message:
          "is in CONSOLE_EXCEPTIONS and no longer writes to the console. " +
          "Remove the entry rather than leaving the permission behind.",
      });
    }

    // R2 — every exception still runs only in a browser.
    //
    // Two shapes, because the list holds two kinds of module and only one of
    // them can say so in a directive. An error boundary is a client component
    // and carries `"use client"`. `src/lib/env/client.ts` is not a component
    // and carries nothing — it is a module a client component may import —
    // so what is checked there is the property its permission actually rests
    // on: it reads no server half of the environment and nothing but
    // `NEXT_PUBLIC_*`, which is the entire purpose of the split.
    const source = read(root, entry.file);
    const code = withoutComments(source);

    if (/^\s*["']use client["']/m.test(source)) {
      // A client component. Nothing more to check.
    } else if (entry.file === "src/lib/env/client.ts") {
      if (/from\s+"server-only"|import\s+"server-only"/.test(code)) {
        findings.push({
          rule: "R2",
          file: entry.file,
          message:
            "imports `server-only`, so it is a server module now and its " +
            "output is a collected stream. Its permission here rests on " +
            "running in a browser.",
        });
      }

      if (/from\s+"@\/lib\/env\/server"/.test(code)) {
        findings.push({
          rule: "R2",
          file: entry.file,
          message:
            "imports the server env. The reason it may print a validation " +
            "failure is that the schema it validates contains no secrets.",
        });
      }

      for (const reference of code.match(/process\.env\[?["']?([A-Z0-9_]+)/g) ??
        []) {
        const name = reference.replace(/^.*?["']?([A-Z0-9_]+)$/, "$1");
        if (name.startsWith("NEXT_PUBLIC_")) continue;

        findings.push({
          rule: "R2",
          file: entry.file,
          message:
            `reads ${name}, which is not a NEXT_PUBLIC_ variable. This ` +
            "module may print its own validation errors precisely because " +
            "everything it validates is already public.",
        });
      }
    } else {
      findings.push({
        rule: "R2",
        file: entry.file,
        message:
          "is allowed to use the console because it runs only in a browser, " +
          'and it no longer declares "use client". On a server its output is ' +
          "a collected, shipped, indexed and retained stream, which is the " +
          "thing redaction exists for.",
      });
    }

    if (entry.why.trim().length < 20) {
      findings.push({
        rule: "R2",
        file: entry.file,
        message:
          "has no real reason recorded in CONSOLE_EXCEPTIONS. The list is " +
          "where the argument for each hole lives.",
      });
    }
  }

  // R4 — the lint layer still agrees with this one.
  const eslintConfig = withoutLineComments(read(root, ESLINT_CONFIG));
  if (!/"no-console":\s*"error"/.test(eslintConfig)) {
    findings.push({
      rule: "R4",
      file: ESLINT_CONFIG,
      message:
        'no longer switches "no-console" on. That rule is the layer that ' +
        "catches this in an editor, before a branch exists; this gate is the " +
        "one that catches a disable comment. They are only two layers while " +
        "both are present.",
    });
  }

  for (const entry of CONSOLE_EXCEPTIONS) {
    // Bracketed segments are literal in a route path and special in a glob;
    // `eslint.config.mjs` covers the error boundaries with `src/app/**` rather
    // than by name, so match either spelling.
    const named =
      eslintConfig.includes(`"${entry.file}"`) ||
      (/\/error\.tsx$/.test(entry.file) &&
        eslintConfig.includes('"src/app/**/error.tsx"'));

    if (named) continue;

    findings.push({
      rule: "R4",
      file: ESLINT_CONFIG,
      message:
        `does not exempt ${entry.file}, which CONSOLE_EXCEPTIONS does. A ` +
        "file that this gate allows and the lint rule forbids fails `pnpm " +
        "lint` for a reason nobody can find in this file.",
    });
  }

  // R5 — the writer still redacts.
  const logger = withoutComments(read(root, LOGGER_FILE));
  if (!/from\s+"@\/lib\/logging\/redact"/.test(logger)) {
    findings.push({
      rule: "R5",
      file: LOGGER_FILE,
      message:
        `does not import ${REDACT_FILE}. Every rule above exists to funnel ` +
        "this application's log lines into this module; a module that then " +
        "prints them unchecked is the same leak with one call site.",
    });
  } else if (!/\bserialise\s*\(/.test(logger)) {
    findings.push({
      rule: "R5",
      file: LOGGER_FILE,
      message:
        "imports the redactor and does not call `serialise`. An import is " +
        "not a call, and `JSON.stringify` next to it looks identical in a " +
        "review.",
    });
  }

  if (/\bJSON\s*\.\s*stringify\s*\(/.test(logger)) {
    findings.push({
      rule: "R5",
      file: LOGGER_FILE,
      message:
        "calls JSON.stringify. The writer must serialise through " +
        "`serialise`, which is the only spelling that redacts; a direct " +
        "stringify here prints whatever it is handed.",
    });
  }

  // R6 — no second serialiser.
  for (const file of sourceFiles(root)) {
    if (file.startsWith("src/lib/logging/")) continue;
    const source = withoutComments(read(root, file));
    if (!/from\s+"@\/lib\/logging\/redact"/.test(source)) continue;

    findings.push({
      rule: "R6",
      file,
      message:
        "imports the redactor directly. Redacting a line and then writing it " +
        `with something other than ${LOGGER_FILE} re-creates the problem ` +
        "with a second serialiser to keep in step. Use `log`, or `writeLine` " +
        "for a module that owns its own line shape.",
    });
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* P — probes                                                                  */
/* -------------------------------------------------------------------------- */

interface RedactModule {
  classifySecret(value: string): string | null;
  redactText(text: string): string;
  serialise(value: unknown): string;
}

/**
 * A hash in the format `src/lib/password.ts` writes, derived here.
 *
 * Derived and not pasted: a fixture pasted from a run is a string somebody
 * chose, and the thing being checked is that the *format that module produces
 * today* is refused. `ln = 14` keeps the probe fast; the format is what matters
 * and the cost is not.
 */
function phcHash(): string {
  const salt = randomBytes(16);
  const key = scryptSync("probe", salt, 32, {
    N: 2 ** 14,
    r: 8,
    p: 1,
    maxmem: 128 * 8 * (2 ** 14 + 3),
  });
  return `$scrypt$ln=14,r=8,p=1$${salt.toString("base64url")}$${key.toString(
    "base64url",
  )}`;
}

export function secretFixtures(): Record<string, string> {
  return {
    // `@auth/core/jwt` issues an A256CBC-HS512 JWE with `dir` key management:
    // five segments, the second of them empty. A rule written for the
    // three-segment JWS everybody pictures refuses nothing this app mints.
    //
    // Assembled rather than pasted, like the hash below and for the same two
    // reasons: a pasted token is a credential-shaped literal in the repository
    // — GitGuardian failed this pull request on two of them — and a constant a
    // regex was written against can satisfy that regex by accident.
    sessionJwe: [
      Buffer.from(
        JSON.stringify({ alg: "dir", enc: "A256CBC-HS512" }),
      ).toString("base64url"),
      "",
      randomBytes(16).toString("base64url"),
      randomBytes(48).toString("base64url"),
      randomBytes(32).toString("base64url"),
    ].join("."),
    passwordHash: phcHash(),
    legacyPasswordHash: `${randomBytes(64).toString("hex")}.${randomBytes(16).toString("hex")}`,
    databaseUrl: "postgresql://app_rls:s3cr3t-p4ss@db.internal:5432/nextjs",
    presignedPut:
      "https://bucket.s3.eu-west-1.amazonaws.com/quarantine/u1/a.png" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300" +
      "&X-Amz-Signature=3f1d0c9b8a7e6f5d4c3b2a1908f7e6d5c4b3a2910f8e7d6c5b4a3928",
    awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
    opaqueToken: randomBytes(32).toString("base64url"),
    bearerHeader: `Bearer ${randomBytes(24).toString("hex")}`,
  };
}

/**
 * Things this application writes on purpose.
 *
 * Losing any of these is a worse outcome than the leak, because the leak is
 * hypothetical and an audit trail that cannot be correlated is certain.
 */
export const PRINTABLE_FIXTURES: Record<string, string> = {
  sid: "9c3f1e7a-2b45-4d81-9f6e-0a7c5d8b3e21",
  userId: "clw9x2k4p0001s8ta7v3q6mze",
  requestPath: "/blog/what-server-components-actually-changed",
  objectKey: "quarantine/clw9x2k4p0001s8ta7v3q6mze/a4f1c9.png",
  receivedAt: "2026-09-11T00:00:00.000Z",
  errorName: "PrismaClientKnownRequestError",
};

async function probes(root: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const url = pathToFileURL(path.join(root, REDACT_FILE)).href;
  const mod = (await import(url)) as RedactModule;

  // P1 — this repository's own secret formats are refused.
  for (const [name, value] of Object.entries(secretFixtures())) {
    if (mod.classifySecret(value) !== null) continue;

    findings.push({
      rule: "P1",
      file: REDACT_FILE,
      message:
        `prints a ${name}. That is a format this application mints, so the ` +
        "value is one an error message can quote and a log platform will " +
        "keep for a year.",
    });
  }

  // P2 — the things it logs on purpose survive.
  for (const [name, value] of Object.entries(PRINTABLE_FIXTURES)) {
    const verdict = mod.classifySecret(value);
    if (verdict === null) continue;

    findings.push({
      rule: "P2",
      file: REDACT_FILE,
      message:
        `refuses ${name} as \`${verdict}\`. This application logs that value ` +
        "on purpose, and the audit trail in `src/lib/auth/harden.ts` is " +
        "correlated on one of them — a redactor that eats identifiers " +
        "destroys the log it is protecting.",
    });
  }

  // P3 — a secret quoted inside a driver's message.
  const hash = phcHash();
  const detail = `Key (password)=(${hash}) already exists.`;
  // Through `serialise`, not `redactText`: the two passes are different code
  // paths and a message reaches a log line through both. Probing the substring
  // pass alone is what let the anchoring bug survive its first gate.
  const redacted = mod.serialise({ detail });

  if (redacted.includes(hash)) {
    findings.push({
      rule: "P3",
      file: REDACT_FILE,
      message:
        "leaves a hash quoted inside a driver's message. That is the shape " +
        "the live defect had: `pg` reports a failed statement by quoting it, " +
        "and what it quotes is the row being written.",
    });
  } else if (!redacted.includes("already exists")) {
    findings.push({
      rule: "P3",
      file: REDACT_FILE,
      message:
        "replaced the whole message rather than the secret in it. A line " +
        "with nothing left in it is a line nobody can act on, and the way " +
        "that happens is the whole-value patterns losing their anchors.",
    });
  }

  // P4 — a serialiser that cannot throw.
  const circular: Record<string, unknown> = { name: "root" };
  circular["self"] = circular;
  const hostile = {
    big: 10n,
    fn: () => "source",
    get boom(): string {
      throw new TypeError("nope");
    },
    circular,
  };

  try {
    // The keys have to survive, not just the call. `serialise` catches its own
    // failure and writes `log.serialisation_failed` instead, which is the
    // right behaviour and would make a probe that only checked for a throw
    // pass against a serialiser that no longer serialises anything.
    const parsed = JSON.parse(mod.serialise(hostile)) as Record<
      string,
      unknown
    >;
    const missing = ["big", "fn", "boom", "circular"].filter(
      (key) => !(key in parsed),
    );

    if (missing.length > 0) {
      findings.push({
        rule: "P4",
        file: REDACT_FILE,
        message:
          `dropped ${missing.join(", ")} from a hostile object — the line ` +
          `came back as ${JSON.stringify(parsed).slice(0, 80)}. A fallback ` +
          "line is not a serialised one, and the fields it lost are the " +
          "explanation the `catch` block was written to record.",
      });
    }
  } catch (error) {
    findings.push({
      rule: "P4",
      file: REDACT_FILE,
      message:
        "threw while serialising a circular structure with a bigint and a " +
        `throwing getter: ${error instanceof Error ? error.message : String(error)}. ` +
        "Nearly every call site is inside a `catch`; a writer that throws " +
        "turns a handled failure into an unhandled one, in the frame that " +
        "was about to explain it.",
    });
  }

  return findings;
}

export async function check(root: string): Promise<Finding[]> {
  return [...staticRules(root), ...(await probes(root))];
}

export async function main(root: string): Promise<number> {
  const findings = await check(root);

  if (findings.length > 0) {
    console.error("Log redaction gate failed:\n");
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(`\n${findings.length} finding(s).`);
    return 1;
  }

  console.log(
    "Log redaction OK — one writer, the lint rule and this gate agree on the " +
      "exceptions, and the serialiser refuses every secret format this " +
      "repository mints while printing the identifiers it correlates on.",
  );
  return 0;
}

/* c8 ignore start -- CLI entry; the logic above is what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.cwd())
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
