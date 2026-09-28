/**
 * The serialiser every log line in this application goes through.
 *
 * ## What it is for
 *
 * A log line is the one place in a server where a value that is never allowed
 * to leave the process is written to a stream that is collected, shipped,
 * indexed and retained for a year, by a system whose access list is not the
 * database's. Nothing in TypeScript distinguishes a string that is a post title
 * from a string that is a session cookie, so the only way to keep the second
 * out of a log is to look at what is being written, at the moment it is
 * written, and refuse the ones that are shaped like a secret.
 *
 * This module is that check. `src/lib/logging/logger.ts` is the only caller in
 * the application, and `scripts/assert-log-redaction.ts` is what keeps it that
 * way — a `console.*` call anywhere outside the logging module fails the build,
 * because a redactor that can be bypassed by typing `console.error` is a
 * redactor with one call site and no coverage.
 *
 * ## Why shape, and not only key names
 *
 * The obvious design is a list of forbidden field names: drop `password`, drop
 * `token`, print everything else. That catches the log line somebody wrote on
 * purpose and misses every one that matters, because the lines that leak are
 * the ones nobody designed. The live instance in this repository was
 * `console.error("[action] " + name + " failed:", thrown)` in
 * `src/lib/actions/define-action.ts`: a thrown value, printed whole, from a
 * frame that wraps every Server Action including the password change. Node
 * formats an `Error` with `util.inspect`, which prints the stack *and every own
 * enumerable property*, and a `pg` driver error carries the statement it failed
 * on in `.detail` and friends — so the field name under which a fresh password
 * hash reaches stdout is `detail`, inside a message nobody wrote, on a code
 * path that only runs when the database is already having a bad day.
 * `src/lib/auth/password-upgrade.ts` knew this and works around it by logging
 * `error.name` and never `error.message`; the comment there says the general
 * fix is a separate item. This is that item.
 *
 * So both halves are needed and they catch different things. The key name is
 * how you redact a value with no distinguishing shape — a passphrase, a PIN, a
 * recovery code. The shape is how you redact a value nobody labelled.
 *
 * ## Why it is not an allowlist of printable fields
 *
 * Because a log nobody can read is a log that gets turned off, and the way that
 * happens is an incident where the line that would have explained it says
 * `{"event":"auth.session","sid":"[redacted]"}`. The audit trail this
 * application already writes is keyed on `sid`, a `crypto.randomUUID()`, and
 * every query anyone runs against it correlates on that value. A redactor that
 * eats identifiers destroys the log it is protecting, so the entropy rule below
 * excludes the identifier formats this application actually mints — UUID, cuid,
 * ULID — and says so out loud, along with what that costs: a bearer token that
 * happens to be a bare UUID passes the shape rules, and is caught only if the
 * field it sits under is named like a credential.
 *
 * ## Why the marker carries no digest
 *
 * A tempting refinement is to replace a secret with a hash of itself, so two
 * lines about the same token can be correlated without printing it. It is not
 * done here. Half of what this module redacts is low-entropy — a password a
 * person typed — and an unsalted digest of one is a reversible artefact sitting
 * in a log aggregator, which is the thing being prevented, moved one function
 * further away. Salting fixes that and breaks the use: the salt would have to
 * be per-process to be safe, and an incident spans restarts, so the correlation
 * would not survive the event it exists for. The marker carries the shape that
 * matched and the length of what it replaced, both of which are useful when
 * reading the line and neither of which narrows a guess.
 */

/** A value's reason for being refused. Appears in the marker. */
export type SecretShape =
  | "jwt"
  | "phc-hash"
  | "legacy-scrypt-hash"
  | "private-key"
  | "aws-access-key-id"
  | "sigv4-credential"
  | "url-credentials"
  | "authorization-header"
  | "high-entropy-token";

/**
 * How a redaction is spelled.
 *
 * One shape for every case, so a log query can find redactions — a sudden rise
 * in `high-entropy-token` inside error messages is somebody logging something
 * new — and so a test can assert an absence by searching for the secret rather
 * than for the marker.
 */
export function marker(shape: SecretShape | string, length?: number): string {
  return length === undefined
    ? `[redacted: ${shape}]`
    : `[redacted: ${shape}, ${length} chars]`;
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A JWS or a JWE: three or five base64url segments.
 *
 * Five matters more than three here. The session cookie this application issues
 * is an A256CBC-HS512 JWE from `@auth/core/jwt`, which has five segments; a
 * rule written for the three-segment form everyone pictures when they say "JWT"
 * would miss the only token the application actually mints.
 *
 * The segments after the first may be *empty*, which is not a detail that
 * survives a rule written from memory: the `dir` key-management algorithm those
 * cookies use has no encrypted key, so the real thing is `header..iv.body.tag`
 * and a `+` where this says `*` refuses it. That is the shape the tests here
 * pin, because it is the shape in the browser.
 */
const JWT = /\beyJ[\w-]{4,}(?:\.[\w-]*){2,4}(?![\w.-])/g;

/**
 * A PHC-format hash: `$scrypt$ln=16,r=8,p=2$salt$key`, and the bcrypt and
 * argon2 spellings a migrated deployment would have alongside it.
 *
 * `src/lib/password.ts` writes the first of these, and it is the value that
 * ends up inside a driver error, because the statement it is bound to is the
 * one that writes it.
 */
const PHC_HASH = /\$(?:scrypt|argon2(?:id|i|d)?|2[abxy]?)\$[^\s"'`);]{8,}/g;

/**
 * The format `src/lib/password.ts` wrote before it recorded its parameters:
 * 128 hex characters, a dot, 32 more. Rows in this shape are still in
 * databases — that is the whole reason `verifyPassword` still reads them — so
 * they are still what a failing statement binds.
 */
const LEGACY_SCRYPT_HASH = /\b[a-f0-9]{128}\.[a-f0-9]{32}\b/gi;

/** A PEM block. Matched on the header alone: the body is the part to not read. */
const PRIVATE_KEY =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g;

/** An AWS access key id. Long-lived (`AKIA`) or a session's (`ASIA`). */
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;

/**
 * SigV4 query parameters, as they appear in a presigned URL.
 *
 * `src/lib/s3.ts` mints these and `src/lib/uploads/storage.ts` logs the object
 * key next to a failure, so a presigned URL reaching a log line is one
 * refactor away. The credential parameter carries the access key id and the
 * signature is the authorisation itself: a presigned PUT in a log is a writable
 * URL for anyone who can read the log, until it expires.
 */
const SIGV4_CREDENTIAL =
  /[?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=[^&\s"'`]+/gi;

/**
 * A URL with a password in its authority: `postgresql://user:pw@host/db`.
 *
 * This is the shape of `DATABASE_URL`, and a connection error from `pg` prints
 * the connection string it failed to open.
 */
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:[^\s/@"'`]+@/gi;

/** `Authorization: Bearer …`, and the `Basic` spelling, wherever it appears. */
const AUTHORIZATION_HEADER =
  /\b(?:Bearer|Basic|Digest)\s+[A-Za-z0-9+/=_.~-]{8,}/g;

/**
 * The formats this application uses for identifiers, which the entropy rule
 * below must not eat.
 *
 * `sid` is a `crypto.randomUUID()` and is the correlation key of the auth audit
 * trail; every `id` column in `prisma/schema.prisma` is a cuid. ULID is here
 * because it is the third thing a team reaches for and looks exactly like a
 * token to an entropy test.
 */
const IDENTIFIER =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c[a-z0-9]{20,30}|[0-9A-HJKMNP-TV-Z]{26})$/i;

/** An ISO 8601 instant — `receivedAt` on every vitals line. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;

/** The character set a token-shaped run is drawn from, and how long it has to be. */
const TOKEN_RUN = /^[A-Za-z0-9+/=_-]{32,}$/;

/**
 * Shannon entropy per character, in bits.
 *
 * Measured over the string's own symbol distribution rather than against an
 * alphabet size, so `aaaaaaaa…` scores 0 however long it is.
 */
export function entropyBits(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/**
 * Whether a string reads as words joined by separators rather than as a token.
 *
 * This is what keeps a long slug printable. `a-very-long-post-about-streaming`
 * is 32 characters of lowercase and hyphens with an entropy of about 3.7 bits —
 * comfortably inside the range a base64 token occupies — and it is the single
 * most likely thing to be logged next to a request — and `/` is a separator
 * here as well as `-`, because the form it is actually logged in is a pathname
 * and `/` is in base64's alphabet, so a route would otherwise read as a token.
 * Requiring three or more
 * segments that are each a plausible word is a cheaper discriminator than any
 * entropy threshold, and it fails safe: a token containing three alphabetic
 * runs joined by hyphens is not a shape anything mints.
 */
export function looksLikeWords(value: string): boolean {
  const segments = value.split(/[-_./\s]+/).filter(Boolean);
  if (segments.length < 3) return false;
  return segments.every(
    (segment) => /^[A-Za-z]{2,14}$/.test(segment) || /^\d{1,4}$/.test(segment),
  );
}

/**
 * The catch-all: a long, dense, unstructured run of token characters.
 *
 * Every rule above names a format. This one exists for the formats that have no
 * name — the output of `randomBytes(32).toString("base64url")`, which is what a
 * password-reset link, an API key and a webhook secret all are, and what none
 * of the named patterns would match. It is deliberately the last thing tried
 * and the one with an escape hatch for identifiers, because it is the rule that
 * can take a useful value out of a log line.
 *
 * The threshold is 3.5 bits per character. A base64 run of random bytes sits
 * near 5.5, a hex digest near 4.0, and an English sentence near 4.2 — which is
 * why length and character set are checked first: prose does not survive
 * `TOKEN_RUN`, because it contains spaces.
 */
export const MIN_TOKEN_ENTROPY_BITS = 3.5;

export function looksLikeToken(value: string): boolean {
  if (!TOKEN_RUN.test(value)) return false;
  if (IDENTIFIER.test(value)) return false;
  if (ISO_INSTANT.test(value)) return false;
  if (looksLikeWords(value)) return false;
  return entropyBits(value) >= MIN_TOKEN_ENTROPY_BITS;
}

/**
 * Order matters. A presigned URL contains a base64 signature, and the
 * `sigv4-credential` marker says more about what leaked than
 * `high-entropy-token` does; a PHC hash's key segment is a token run.
 */
const NAMED_SHAPES: readonly (readonly [SecretShape, RegExp])[] = [
  ["private-key", PRIVATE_KEY],
  ["jwt", JWT],
  ["phc-hash", PHC_HASH],
  ["legacy-scrypt-hash", LEGACY_SCRYPT_HASH],
  ["url-credentials", URL_CREDENTIALS],
  ["sigv4-credential", SIGV4_CREDENTIAL],
  ["aws-access-key-id", AWS_ACCESS_KEY_ID],
  ["authorization-header", AUTHORIZATION_HEADER],
] as const;

/**
 * The shapes whose whole value is the secret, anchored and non-global.
 *
 * Anchoring is what separates a useful log line from a blank one, and leaving
 * it out was the first bug the tests here found: unanchored, a 600-character
 * driver message that *mentions* a hash classifies as a hash, and the whole
 * message — the table it failed on, the constraint, the stack under it — is
 * replaced by one marker. A value is classified whole only when it is the
 * secret end to end. A message carrying one falls through to `redactText`,
 * which takes out the span and leaves the sentence.
 *
 * Non-global for a second reason: `lastIndex` is state and survives between
 * calls on a `g` regex, so testing one pattern twice returns `true` and then
 * `false` on identical input — every second secret of a given shape would be
 * printed.
 */
const WHOLE_VALUE_SHAPES: readonly (readonly [SecretShape, RegExp])[] =
  NAMED_SHAPES.filter(
    ([shape]) => shape !== "url-credentials" && shape !== "sigv4-credential",
  ).map(
    ([shape, pattern]) =>
      [
        shape,
        new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace("g", "")),
      ] as const,
  );

/** The two shapes that are URL-borne, non-global for the same reason. */
const WHOLE_URL_SHAPES: readonly (readonly [SecretShape, RegExp])[] =
  NAMED_SHAPES.filter(
    ([shape]) => shape === "url-credentials" || shape === "sigv4-credential",
  ).map(
    ([shape, pattern]) =>
      [
        shape,
        new RegExp(pattern.source, pattern.flags.replace("g", "")),
      ] as const,
  );

/**
 * A bare URL: a scheme, an authority, and no whitespace anywhere.
 *
 * The two URL-borne shapes are treated differently from the rest, because what
 * they mark is not a span but the value around it. A presigned PUT is a
 * capability: strip the signature and what is left still names the bucket, the
 * key, the credential and the expiry, which is most of the way to using it. So
 * a URL carrying SigV4 parameters is refused whole, while the same parameters
 * quoted inside a sentence are taken out of the sentence.
 */
const BARE_URL = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/**
 * The whole-string verdict: what this value is, or `null` if it is printable.
 *
 * Exported because the gate probes it directly against values produced by this
 * repository's own modules, rather than against strings written to match.
 */
export function classifySecret(value: string): SecretShape | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (BARE_URL.test(trimmed)) {
    for (const [shape, pattern] of WHOLE_URL_SHAPES) {
      if (pattern.test(trimmed)) return shape;
    }
  }

  for (const [shape, pattern] of WHOLE_VALUE_SHAPES) {
    if (pattern.test(trimmed)) return shape;
  }

  return looksLikeToken(trimmed) ? "high-entropy-token" : null;
}

/**
 * Replaces every secret-shaped *substring* of a piece of text.
 *
 * Substrings and not whole values, because the strings that carry secrets in
 * this application are sentences somebody else wrote: `Key (password)=($scrypt$
 * ln=16,r=8,p=2$…) already exists` is a `pg` error's `detail`, and a rule that
 * only classified whole values would print all of it. The named patterns are
 * global for this reason. The entropy rule is not applied here — it is a
 * whole-value test, and running it over the words of a message would redact the
 * message rather than the secret in it.
 */
export function redactText(text: string): string {
  let result = text;
  for (const [shape, pattern] of NAMED_SHAPES) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (found) => marker(shape, found.length));
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A field name that means "whatever is in here is a credential".
 *
 * Anchored to word boundaries inside the key so that `passwordHash`,
 * `refresh_token` and `X-Api-Key` all match, and composed of whole words so
 * that the thing this repository logs deliberately does not.
 *
 * `key` on its own is deliberately absent, and it is the entry that would have
 * broken a working log: `src/lib/uploads/storage.ts` writes
 * `{"event":"upload.quarantine_delete_failed","key":"quarantine/…"}`, where
 * `key` is an S3 object key and the only thing in the line that says which
 * object failed to delete. Only the qualified spellings — `apiKey`,
 * `accessKey`, `secretKey`, `privateKey` — are credentials.
 */
const SECRET_KEY =
  /(?:^|[^a-z])(?:pass(?:word|phrase|wd)?|secret|token|jwt|credential|authorization|cookie|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|signing[_-]?key|session[_-]?key|salt|otp|pin|passcode|recovery[_-]?code|client[_-]?secret)s?(?:[^a-z]|$)/;

/**
 * `passwordHash` and `PASSWORD_HASH` reduced to one spelling: `password_hash`.
 *
 * Without this the rule above has to be case-insensitive, and a
 * case-insensitive `[^a-z]` also excludes `A-Z` — so `passwordHash` stops
 * matching, because the character after `password` is a capital. That is the
 * second bug the tests here found, and it is the one that would have mattered:
 * `passwordHash` is the exact field name this application would put a hash
 * under.
 */
export function normaliseKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(normaliseKey(key));
}

/* -------------------------------------------------------------------------- */
/* The walker                                                                  */
/* -------------------------------------------------------------------------- */

export interface RedactOptions {
  /**
   * How deep to walk before giving up. A log line is not a heap dump, and a
   * structure deeper than this is either a mistake or a Prisma result someone
   * passed whole.
   */
  maxDepth?: number;
  /** How many entries of an array or object to keep. */
  maxEntries?: number;
  /**
   * Where a string stops being a message and starts being a payload. A string
   * longer than this is truncated *after* redaction, never before — truncating
   * first would split a secret across the boundary and print the front of it.
   */
  maxStringLength?: number;
}

const DEFAULTS = {
  maxDepth: 6,
  maxEntries: 64,
  maxStringLength: 512,
} satisfies Required<RedactOptions>;

/**
 * Turns an arbitrary value into one that is safe to `JSON.stringify` and print.
 *
 * Total by construction: every branch returns something, and the default branch
 * refuses rather than guesses. That is the difference between this and a
 * `JSON.stringify` replacer — a replacer inherits `JSON.stringify`'s opinions
 * about what is printable, and those opinions include calling `toJSON()` on
 * anything that has one, dropping functions silently, and throwing on a
 * circular structure and on a `bigint`. A log line must not be able to throw
 * from inside a `catch` block, which is where most of them are written.
 */
export function redactValue(
  value: unknown,
  options: RedactOptions = {},
): unknown {
  const settings = { ...DEFAULTS, ...options };
  return walk(value, settings, 0, new Set());
}

function walk(
  value: unknown,
  settings: Required<RedactOptions>,
  depth: number,
  seen: Set<object>,
): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
      return redactString(value, settings);
    case "number":
      // `NaN` and the infinities are not JSON. `JSON.stringify` turns them into
      // `null`, which reads as "no measurement" rather than "a broken one".
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "undefined":
      return undefined;
    case "bigint":
      return `${value.toString()}n`;
    case "symbol":
      return `[symbol ${value.description ?? ""}]`;
    case "function":
      // Not printable and not empty: a function's source is as likely to hold a
      // literal as anything else here, and `JSON.stringify` would drop it
      // without saying so.
      return marker("function");
  }

  const object = value as object;
  if (seen.has(object)) return "[circular]";
  if (depth >= settings.maxDepth) return "[truncated: depth]";

  seen.add(object);
  try {
    return walkObject(object, settings, depth, seen);
  } finally {
    // Removed on the way out so a value appearing twice as siblings is printed
    // twice; only an actual cycle is refused.
    seen.delete(object);
  }
}

function walkObject(
  object: object,
  settings: Required<RedactOptions>,
  depth: number,
  seen: Set<object>,
): unknown {
  if (object instanceof Date) {
    return Number.isNaN(object.getTime())
      ? "[invalid date]"
      : object.toISOString();
  }

  if (object instanceof RegExp) return object.source;

  if (object instanceof URL) return redactString(object.href, settings);

  if (object instanceof Error) return walkError(object, settings, depth, seen);

  // Bytes are key material more often than they are anything a person reads,
  // and a base64 rendering of them would be handed to the string rules with no
  // idea what it was. The length is the useful part.
  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
    const length =
      "byteLength" in object ? (object.byteLength as number) : undefined;
    return marker("bytes", length);
  }

  if (object instanceof Map) {
    return walkEntries([...object.entries()], settings, depth, seen);
  }

  if (object instanceof Set) {
    return walkList([...object.values()], settings, depth, seen);
  }

  if (Array.isArray(object)) return walkList(object, settings, depth, seen);

  return walkEntries(ownEntries(object), settings, depth, seen);
}

/**
 * An `Error`, flattened to the three things worth logging plus whatever it was
 * carrying.
 *
 * The own enumerable properties are walked rather than dropped, because that is
 * where a driver puts its context — `pg` uses `detail`, `table`, `constraint`;
 * Prisma uses `meta`; `fetch` uses `cause` — and those are the fields that
 * explain a failure. They are also where the statement's bound parameters end
 * up, which is exactly why they go through the same rules as everything else
 * rather than being printed as a special case.
 *
 * The stack is kept. It names this repository's own files and holds no data;
 * losing it would make the redactor the reason an incident took a day longer.
 */
function walkError(
  error: Error,
  settings: Required<RedactOptions>,
  depth: number,
  seen: Set<object>,
): unknown {
  const flattened: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message, settings),
  };

  if (typeof error.stack === "string") {
    flattened["stack"] = redactString(error.stack, {
      ...settings,
      // A stack is long by nature and cutting it at the message budget would
      // leave one frame.
      maxStringLength: Math.max(settings.maxStringLength, 4_096),
    });
  }

  for (const [key, value] of ownEntries(error)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    flattened[key] = isSecretKey(key)
      ? marker(`key ${JSON.stringify(key)}`)
      : walk(value, settings, depth + 1, seen);
  }

  return flattened;
}

function walkList(
  list: readonly unknown[],
  settings: Required<RedactOptions>,
  depth: number,
  seen: Set<object>,
): unknown[] {
  const kept = list
    .slice(0, settings.maxEntries)
    .map((entry) => walk(entry, settings, depth + 1, seen));

  if (list.length > settings.maxEntries) {
    kept.push(`[truncated: ${list.length - settings.maxEntries} more]`);
  }
  return kept;
}

function walkEntries(
  entries: readonly (readonly [unknown, unknown])[],
  settings: Required<RedactOptions>,
  depth: number,
  seen: Set<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [rawKey, value] of entries.slice(0, settings.maxEntries)) {
    const key = typeof rawKey === "string" ? rawKey : String(rawKey);

    // The key check comes first and does not look at the value. That is the
    // whole point of having it: a password is a string with no distinguishing
    // shape, and `{"password":"hunter2"}` is only recognisable by its label.
    result[key] = isSecretKey(key)
      ? marker(`key ${JSON.stringify(key)}`)
      : walk(value, settings, depth + 1, seen);
  }

  if (entries.length > settings.maxEntries) {
    result["…"] = `[truncated: ${entries.length - settings.maxEntries} more]`;
  }
  return result;
}

/**
 * Own enumerable properties, with a getter that throws reported rather than
 * propagated.
 *
 * A log line is written from a `catch` block in every interesting case. A
 * serialiser that can throw turns a handled failure into an unhandled one, and
 * the frame it throws from is the one that was about to explain what went
 * wrong.
 */
function ownEntries(object: object): (readonly [string, unknown])[] {
  const entries: (readonly [string, unknown])[] = [];

  for (const key of Object.keys(object)) {
    try {
      entries.push([key, (object as Record<string, unknown>)[key]]);
    } catch (thrown) {
      entries.push([
        key,
        `[unreadable: ${thrown instanceof Error ? thrown.name : "threw"}]`,
      ]);
    }
  }
  return entries;
}

/**
 * A string, redacted and then bounded.
 *
 * Whole-value classification first, because it produces the better marker — a
 * field that *is* a session cookie should read `[redacted: jwt, 312 chars]`
 * rather than a sentence with a hole in it. Substring replacement second, for
 * the case the value is a message carrying one.
 */
function redactString(
  value: string,
  settings: Required<RedactOptions>,
): string {
  const shape = classifySecret(value);
  if (shape) return marker(shape, value.length);

  const redacted = redactText(value);
  if (redacted.length <= settings.maxStringLength) return redacted;

  return `${redacted.slice(0, settings.maxStringLength)}… [truncated: ${
    redacted.length - settings.maxStringLength
  } chars]`;
}

/**
 * The serialiser proper: a redacted value as one line of JSON.
 *
 * Never throws and never returns an empty string. `JSON.stringify` can still
 * fail on a structure this module handed back — it cannot, by construction, but
 * "cannot" is what the `catch` is for, because the alternative is a logging
 * call that takes down the request it was reporting on.
 */
export function serialise(value: unknown, options: RedactOptions = {}): string {
  try {
    return JSON.stringify(redactValue(value, options)) ?? "null";
  } catch (thrown) {
    return JSON.stringify({
      event: "log.serialisation_failed",
      reason: thrown instanceof Error ? thrown.name : "unknown",
    });
  }
}
