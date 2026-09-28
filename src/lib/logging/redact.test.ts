import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifySecret,
  entropyBits,
  isSecretKey,
  looksLikeToken,
  looksLikeWords,
  marker,
  redactText,
  serialise,
} from "./redact";

/** base64url of a JSON literal, which is how every JOSE segment is built. */
function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * A value this repository actually mints, in the format it mints it in.
 *
 * Each one is assembled here from its parts rather than pasted from a run, and
 * the reason is not style. The first version of this file pasted them, and
 * GitGuardian failed the pull request on two — a base64url token and a JWS —
 * which is the correct answer to a credential-shaped literal in a repository
 * and is also this item's own subject arriving from the other direction.
 * Building each value from an obviously fake body makes the *format* the
 * fixture, which is what these rules key on, and leaves nothing for a scanner
 * to find. The random bodies do a second job: a regex cannot be accidentally
 * satisfied by a constant it was written against.
 */
const SECRETS = {
  // `@auth/core/jwt`'s `encode` — five segments, A256CBC-HS512. The three
  // segment form everyone pictures is the one this application does not use.
  // Five segments, the second empty: `dir` key management has no encrypted key.
  sessionJwe: [
    segment({ alg: "dir", enc: "A256CBC-HS512" }),
    "",
    randomBytes(16).toString("base64url"),
    randomBytes(48).toString("base64url"),
    randomBytes(32).toString("base64url"),
  ].join("."),
  // `src/lib/password.ts`, current format.
  phcHash: "$scrypt$ln=16,r=8,p=2$c2FsdHNhbHRzYWx0c2FsdA$a2V5a2V5a2V5a2V5a2V5",
  // The format it wrote before the parameters were recorded: 128 hex, a dot,
  // 32 more. Rows in this shape are still in databases.
  legacyHash: `${"a1b2c3d4".repeat(16)}.${"f0e1d2c3".repeat(4)}`,
  databaseUrl: "postgresql://app_rls:s3cr3t-p4ss@db.internal:5432/nextjs",
  awsKeyId: "AKIAIOSFODNN7EXAMPLE",
  presignedPut:
    "https://bucket.s3.eu-west-1.amazonaws.com/quarantine/u1/a.png" +
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE" +
    "%2F20260928%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Expires=300" +
    "&X-Amz-Signature=3f1d0c9b8a7e6f5d4c3b2a1908f7e6d5c4b3a2910f8e7d6c5b4a3928",
  bearer: "Bearer 4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a",
  // The body is a sentence rather than base64 on purpose: what the rule keys
  // on is the header, and a fixture that looked like key material would be a
  // credential-shaped string in the repository for scanners to flag.
  privateKey:
    "-----BEGIN PRIVATE KEY-----\nthis is not a real key\n-----END PRIVATE KEY-----",
  // `randomBytes(32).toString("base64url")` — a reset link, an API key, a
  // webhook secret. No named format matches it; the entropy rule is why it is
  // still refused.
  opaqueToken: randomBytes(32).toString("base64url"),
} as const;

/**
 * Things this application logs on purpose, which must survive.
 *
 * This half of the table is the one that decides whether the feature is usable.
 * A redactor that eats `sid` leaves an audit trail nobody can correlate, which
 * is worse than the leak it prevents is bad — because the leak is hypothetical
 * and the unusable trail is certain.
 */
const PRINTABLE = {
  sid: "9c3f1e7a-2b45-4d81-9f6e-0a7c5d8b3e21",
  userId: "clw9x2k4p0001s8ta7v3q6mze",
  path: "/blog/what-server-components-actually-changed",
  slug: "what-server-components-actually-changed",
  receivedAt: "2026-09-11T00:00:00.000Z",
  objectKey: "quarantine/clw9x2k4p0001s8ta7v3q6mze/a4f1.png",
  errorName: "PrismaClientKnownRequestError",
  message: "Unique constraint failed on the fields: (`email`)",
} as const;

describe("classifySecret", () => {
  it.each(Object.entries(SECRETS))("refuses %s", (_name, value) => {
    expect(classifySecret(value)).not.toBeNull();
  });

  it.each(Object.entries(PRINTABLE))("prints %s", (_name, value) => {
    expect(classifySecret(value)).toBeNull();
  });

  it("names the five-segment JWE, not just the three-segment JWS", () => {
    // The session cookie is a JWE. A rule written for the shape everyone
    // pictures when they say "JWT" would miss the only token this application
    // actually issues.
    expect(classifySecret(SECRETS.sessionJwe)).toBe("jwt");
    const jws = [
      segment({ alg: "HS256" }),
      segment({ sub: "1" }),
      randomBytes(32).toString("base64url"),
    ].join(".");
    expect(classifySecret(jws)).toBe("jwt");
  });

  it("prefers the specific shape over the entropy catch-all", () => {
    // Both would fire on a presigned URL. Which marker is written decides
    // whether the person reading the line knows a writable URL leaked or just
    // that "something long" did.
    expect(classifySecret(SECRETS.presignedPut)).toBe("sigv4-credential");
    expect(classifySecret(SECRETS.phcHash)).toBe("phc-hash");
    expect(classifySecret(SECRETS.opaqueToken)).toBe("high-entropy-token");
  });

  it("does not hold `lastIndex` between calls", () => {
    // A `g` regex carries position state, so testing the same pattern twice
    // returns true and then false. The whole-value table is a non-global copy
    // for this reason, and without it every second secret of a given shape
    // would be printed.
    expect(classifySecret(SECRETS.phcHash)).toBe("phc-hash");
    expect(classifySecret(SECRETS.phcHash)).toBe("phc-hash");
    expect(classifySecret(SECRETS.awsKeyId)).toBe("aws-access-key-id");
    expect(classifySecret(SECRETS.awsKeyId)).toBe("aws-access-key-id");
  });
});

describe("the entropy catch-all", () => {
  it("leaves a long slug alone", () => {
    // 43 characters of lowercase and hyphens, entropy around 3.7 bits — inside
    // the range a base64 token occupies. The word structure is what separates
    // them, and a slug next to a request is the single most likely thing to be
    // logged.
    expect(entropyBits(PRINTABLE.slug)).toBeGreaterThan(3.5);
    expect(looksLikeWords(PRINTABLE.slug)).toBe(true);
    expect(looksLikeToken(PRINTABLE.slug)).toBe(false);
  });

  it("leaves this repository's two identifier formats alone", () => {
    // `sid` is a randomUUID and `id` is a cuid. Both are high-entropy by
    // construction and both are the correlation key of a log somebody reads
    // during an incident.
    expect(looksLikeToken(PRINTABLE.sid)).toBe(false);
    expect(looksLikeToken(PRINTABLE.userId)).toBe(false);
  });

  it("scores a repeated character at zero however long it is", () => {
    expect(entropyBits("a".repeat(64))).toBe(0);
    expect(looksLikeToken("a".repeat(64))).toBe(false);
  });

  it("does not fire on anything short enough to be a word", () => {
    expect(looksLikeToken("draft")).toBe(false);
    expect(looksLikeToken("POST")).toBe(false);
  });
});

describe("isSecretKey", () => {
  it.each([
    "password",
    "passwordHash",
    "refresh_token",
    "accessToken",
    "NEXTAUTH_SECRET",
    "X-Api-Key",
    "authorization",
    "set-cookie",
    "clientSecret",
    "privateKey",
    "salt",
  ])("refuses the field %s", (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each(["key", "keyword", "path", "id", "sid", "userId", "status", "name"])(
    "prints the field %s",
    (key) => {
      expect(isSecretKey(key)).toBe(false);
    },
  );

  it("prints a bare `key`, which is an S3 object key here", () => {
    // `src/lib/uploads/storage.ts` writes `{"event":"upload.quarantine_delete_
    // failed","key":"quarantine/…"}`, where `key` is the only thing in the line
    // that says which object failed to delete. Only the qualified spellings are
    // credentials.
    const line = serialise({ key: PRINTABLE.objectKey, apiKey: "anything" });
    expect(line).toContain(PRINTABLE.objectKey);
    expect(line).not.toContain("anything");
  });
});

describe("redactText", () => {
  it("replaces a secret inside a sentence somebody else wrote", () => {
    // This is the shape that matters, and it is not a whole value: a driver
    // reports a failed statement by quoting it, and what it quotes is the row
    // that was being written.
    const detail = `Key (password)=(${SECRETS.phcHash}) already exists.`;
    const redacted = redactText(detail);

    expect(redacted).not.toContain(SECRETS.phcHash);
    expect(redacted).toContain("Key (password)=(");
    expect(redacted).toContain("already exists.");
  });

  it("replaces every occurrence, not only the first", () => {
    const text = `${SECRETS.awsKeyId} and again ${SECRETS.awsKeyId}`;
    expect(redactText(text)).not.toContain(SECRETS.awsKeyId);
  });

  it("leaves a message with nothing in it byte-identical", () => {
    expect(redactText(PRINTABLE.message)).toBe(PRINTABLE.message);
  });
});

describe("redactValue", () => {
  it("refuses a secret-shaped value under an innocent key", () => {
    const line = serialise({ detail: SECRETS.opaqueToken });
    expect(line).not.toContain(SECRETS.opaqueToken);
    expect(line).toContain("high-entropy-token");
  });

  it("refuses an innocent-shaped value under a secret key", () => {
    // The other half. `hunter2` is a string with no shape at all; the label is
    // the only thing that identifies it.
    const line = serialise({ password: "hunter2" });
    expect(line).not.toContain("hunter2");
    expect(line).toBe(JSON.stringify({ password: marker('key "password"') }));
  });

  it("walks nested structures, arrays, Maps and Sets", () => {
    const line = serialise({
      a: [{ b: { c: { token: SECRETS.opaqueToken } } }],
      m: new Map([["nested", SECRETS.awsKeyId]]),
      s: new Set([SECRETS.bearer]),
    });

    expect(line).not.toContain(SECRETS.opaqueToken);
    expect(line).not.toContain(SECRETS.awsKeyId);
    expect(line).not.toContain(SECRETS.bearer);
  });

  it("survives a circular structure rather than throwing", () => {
    // Most of these lines are written from a `catch` block. A serialiser that
    // can throw turns a handled failure into an unhandled one.
    const node: Record<string, unknown> = { name: "root" };
    node["self"] = node;

    expect(serialise(node)).toBe(
      JSON.stringify({ name: "root", self: "[circular]" }),
    );
  });

  it("survives a getter that throws", () => {
    const hostile = {
      ok: 1,
      get boom(): string {
        throw new TypeError("nope");
      },
    };

    expect(JSON.parse(serialise(hostile))).toEqual({
      ok: 1,
      boom: "[unreadable: TypeError]",
    });
  });

  it("survives a bigint, a function and a symbol, which JSON does not", () => {
    // `JSON.stringify` throws on the first and silently drops the other two.
    const line = JSON.parse(
      serialise({ n: 10n, fn: () => "source", sym: Symbol("s") }),
    ) as Record<string, string>;

    expect(line["n"]).toBe("10n");
    expect(line["fn"]).toBe(marker("function"));
    expect(line["sym"]).toBe("[symbol s]");
  });

  it("refuses raw bytes by length rather than rendering them", () => {
    expect(JSON.parse(serialise({ buf: new Uint8Array(32) }))).toEqual({
      buf: marker("bytes", 32),
    });
  });

  it("stops at a depth limit instead of walking a whole object graph", () => {
    let deep: unknown = SECRETS.opaqueToken;
    for (let level = 0; level < 12; level += 1) deep = { deep };

    const line = serialise(deep);
    expect(line).toContain("[truncated: depth]");
    expect(line).not.toContain(SECRETS.opaqueToken);
  });

  it("truncates a long string after redacting it, never before", () => {
    // Truncating first would cut a secret at the boundary and print its front
    // half, which is the one outcome worse than printing nothing.
    const padding = "context. ".repeat(60);
    const line = serialise({ detail: padding + SECRETS.phcHash });

    expect(line).not.toContain("$scrypt$");
    expect(line).toContain("[truncated:");
  });
});

describe("an Error", () => {
  it("keeps the name and the stack, and redacts the message", () => {
    const error = new Error(`writing ${SECRETS.phcHash} failed`);
    const flattened = JSON.parse(serialise({ error })) as {
      error: { name: string; message: string; stack: string };
    };

    expect(flattened.error.name).toBe("Error");
    expect(flattened.error.message).not.toContain("$scrypt$");
    expect(flattened.error.message).toContain("phc-hash");
    // The stack names this repository's own files and carries no data; losing
    // it would make the redactor the reason an incident took a day longer.
    expect(flattened.error.stack).toContain("redact.test.ts");
  });

  it("walks the properties a driver attaches, which is where the row is", () => {
    // `pg` puts the failing statement's context on `detail`, `table` and
    // `constraint`; Prisma uses `meta`. Node's own formatter prints all of them
    // and that is how a password hash reaches stdout under a field name nobody
    // chose.
    const error = Object.assign(new Error("duplicate key value"), {
      table: "users",
      detail: `Key (password)=(${SECRETS.phcHash}) already exists.`,
      parameters: [SECRETS.opaqueToken],
    });

    const line = serialise({ error });

    expect(line).not.toContain("$scrypt$");
    expect(line).not.toContain(SECRETS.opaqueToken);
    // Still says which table, which is the half worth having.
    expect(line).toContain("users");
  });

  it("redacts a property named like a credential without looking at it", () => {
    const error = Object.assign(new Error("nope"), { token: "short" });
    expect(serialise({ error })).not.toContain("short");
  });
});

describe("serialise", () => {
  it("writes one line, with no newline in it", () => {
    const line = serialise({ event: "auth.session", stack: "a\nb" });
    expect(line.includes("\n")).toBe(false);
  });

  it("never throws and never returns an empty string", () => {
    expect(serialise(undefined)).toBe("null");
    expect(serialise(Symbol("x"))).toBe('"[symbol x]"');
  });
});
