/**
 * Password hashing, in a format that records the cost it was produced at.
 *
 * ## Why the format is the feature
 *
 * The previous version of this module derived a key with `scrypt(password,
 * salt, 64)` and stored `hex.salt`. That is a correct hash and an unraisable
 * one. Nothing in the stored string says what work produced it, so the only
 * way to read one back is to repeat whatever the code happens to do *today* —
 * which means the parameters can never change. Raising them is not a
 * deployment, it is a migration that invalidates every account at once, and
 * the fact that a repository cannot do it is invisible: every test passes,
 * every sign-in works, and the cost silently stays at whatever was normal the
 * year the module was written.
 *
 * So the hash carries its own parameters, in PHC string format:
 *
 *     $scrypt$ln=16,r=8,p=2$<salt>$<key>
 *
 * with both trailing fields in unpadded standard base64, as the format
 * specifies. `verifyPassword` derives with the parameters it reads out of the
 * stored string rather than with the current policy, so an old hash keeps
 * verifying at the cost it was made at; `needsRehash` reports that it is below
 * policy, and the sign-in path re-derives it from the plaintext it is holding
 * anyway. See `@/lib/auth/password-upgrade`.
 *
 * ## A second thing pinned the old parameters, and it is not obvious
 *
 * `crypto.scrypt` defaults `maxmem` to 32 MiB and refuses any parameter set
 * needing more — with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`, at call time, not at
 * review time. scrypt's working set is `128 * N * r` bytes, which at Node's
 * default `N = 2^14, r = 8` is 16 MiB; one step up to `N = 2^15` is 32 MiB and
 * throws. Measured, not assumed: on Node 22, `scrypt(pw, salt, 64, { N: 2**15,
 * r: 8, p: 1 })` with no `maxmem` raises, and so does every larger N.
 *
 * So the old module could not have had its cost raised even with a format that
 * recorded it. `maxmem` is now derived from the parameters in use rather than
 * left to the default, which is also what makes the ceiling below meaningful:
 * a hash cannot ask for more memory than this module is willing to allocate,
 * because the number is computed from the hash's own fields and checked.
 *
 * ## Why these parameters
 *
 * OWASP's Password Storage cheat sheet gives a row of equivalent scrypt
 * configurations — `N=2^17,r=8,p=1`, `N=2^16,r=8,p=2`, `N=2^15,r=8,p=3` — and
 * this takes the second rather than the first, deliberately. They cost the
 * same (measured here: 386 ms and 414 ms for one derivation), but peak memory
 * is `128 * N * r` and halves with N: 128 MiB against 64 MiB. That difference
 * is multiplied by concurrency, because Node runs `scrypt` on the libuv thread
 * pool — four derivations in flight by default, so the choice is between
 * 512 MiB and 256 MiB of transient allocation on a box also running the
 * renderer. p is the parallelism parameter in name only here: OpenSSL walks
 * the p blocks sequentially, so raising it buys work without buying memory,
 * which is exactly the trade a shared server wants.
 *
 * Credential stuffing is bounded separately, at 10 attempts a minute per
 * client, and that rule counts the NextAuth callback endpoint directly — see
 * `docs/rate-limiting.md`. It has to: a 414 ms verification is a rate limiter's
 * problem before it is a hash function's.
 */
import {
  scrypt,
  randomBytes,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * `scrypt` as a promise, written out rather than `promisify`d.
 *
 * `promisify(scrypt)` resolves to the three-argument overload, so passing
 * options — which is how the cost stops being Node's defaults — is a type
 * error, and the usual way round it is a cast that also throws away the
 * callback's `Buffer`. One wrapper keeps both ends typed.
 */
function derive(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** The tunable cost of one derivation. `ln` is log2 of scrypt's `N`. */
export interface ScryptParameters {
  /** log2 of the CPU/memory cost. Working set is `128 * 2**ln * r` bytes. */
  ln: number;
  /** Block size. Scales both memory and time. */
  r: number;
  /** Iteration count over the working set. Scales time only. */
  p: number;
}

/**
 * What new hashes are made at, and what `needsRehash` measures against.
 *
 * A constant and not an environment variable. The point of recording the
 * parameters is that this line can move; an env var would instead make the
 * cost a per-deployment accident, and the failure it invites is one-way —
 * nobody notices a deployment that quietly hashes at `ln=10`.
 */
export const PASSWORD_HASH_POLICY: ScryptParameters = { ln: 16, r: 8, p: 2 };

/** Bytes of salt for a new hash. */
export const SALT_BYTES = 16;

/** Derived key length for a new hash. */
export const KEY_BYTES = 32;

/**
 * The widest hash this module will agree to evaluate.
 *
 * A stored hash is an input. It is one this application wrote, but "the only
 * writer is us" is the assumption every deserialisation bug is built on, and
 * the cost of being wrong here is specific: the parameters in the string are
 * an allocation size and a loop count, so a row reading `ln=30` is a request
 * to allocate 137 GiB inside an unauthenticated POST handler. The ceiling is
 * on the product rather than on `ln` alone, because `r` multiplies it just as
 * directly and bounding the two separately still permits their product.
 *
 * 256 MiB: four times the working set of `PASSWORD_HASH_POLICY`, which is room
 * to raise `ln` by one step or `r` from 8 to 16 before this line has to move
 * with it, and well under what a single request should ever be able to ask a
 * server for.
 */
const MAX_WORKING_SET_BYTES = 256 * 1024 * 1024;

/**
 * What OpenSSL will allocate for one derivation at `params`.
 *
 * Its own accounting, not an approximation of it: `128 * r * (N + 2)` for the
 * scratch vector and `128 * r * p` for the blocks walked over it. The usual
 * shorthand — `128 * N * r` — is the first term with the `+ 2` dropped, which
 * is a rounding error at `N = 2^16` and is larger than the whole allocation at
 * `N = 2`. That matters because this number is also `maxmem`, and the tests
 * hash at the cheapest parameters the module accepts.
 */
function workingSetBytes(params: ScryptParameters): number {
  return 128 * params.r * (2 ** params.ln + params.p + 2);
}

/**
 * Per-field bounds, checked before the product above.
 *
 * These are not security-critical on their own — the working-set ceiling is
 * what stops the allocation — but they keep a malformed field from being
 * interpreted at all. `p` is bounded because it costs time without costing
 * memory, so it is the one parameter the ceiling does not constrain; 16 is
 * roughly eight seconds of derivation at the policy's N.
 */
const LIMITS = {
  ln: { min: 1, max: 24 },
  r: { min: 1, max: 32 },
  p: { min: 1, max: 16 },
  saltBytes: { min: 8, max: 64 },
  keyBytes: { min: 16, max: 64 },
} as const;

/** A stored hash, parsed. */
export interface ParsedPasswordHash {
  params: ScryptParameters;
  salt: Buffer;
  key: Buffer;
  /**
   * `true` for the parameterless `hex.salt` strings this module used to write.
   *
   * They are readable — the parameters were Node's defaults, and Node's
   * defaults are a documented constant — but they are always below policy, so
   * a legacy hash is a rehash on its owner's next sign-in.
   */
  legacy: boolean;
}

/** What `crypto.scrypt`'s options argument needs, derived from `params`. */
function scryptOptions(params: ScryptParameters): {
  N: number;
  r: number;
  p: number;
  maxmem: number;
} {
  const N = 2 ** params.ln;
  return {
    N,
    r: params.r,
    p: params.p,
    // Derived from the parameters rather than left at Node's 32 MiB default,
    // which is the second thing that pinned the old module's cost. A megabyte
    // of slack on top of OpenSSL's accounting so that a build whose OpenSSL
    // counts slightly differently degrades to allocating a little more rather
    // than to throwing on every verification. It is a cap and not a
    // reservation, so the slack costs nothing; the number that actually bounds
    // the allocation is `MAX_WORKING_SET_BYTES`, checked before this is reached.
    maxmem: workingSetBytes(params) + 1024 * 1024,
  };
}

/** Whether a parameter set is inside the bounds above. */
function withinLimits(params: ScryptParameters): boolean {
  const inRange = (value: number, { min, max }: { min: number; max: number }) =>
    Number.isInteger(value) && value >= min && value <= max;

  if (!inRange(params.ln, LIMITS.ln)) return false;
  if (!inRange(params.r, LIMITS.r)) return false;
  if (!inRange(params.p, LIMITS.p)) return false;

  return workingSetBytes(params) <= MAX_WORKING_SET_BYTES;
}

/** PHC's B64: standard base64 alphabet, no padding. */
function toB64(bytes: Buffer): string {
  return bytes.toString("base64").replace(/=+$/, "");
}

/**
 * PHC B64 back to bytes, rejecting anything that is not canonical.
 *
 * `Buffer.from(s, "base64")` is famously lenient: it skips characters outside
 * the alphabet and truncates on a partial group, so `"!!!!"` decodes to an
 * empty buffer rather than failing. Re-encoding and comparing is what turns it
 * into a parse — a string that does not round-trip did not mean what it was
 * read as, and this module would rather refuse a hash than silently compare
 * against the wrong bytes.
 */
function fromB64(text: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0) return null;
  return toB64(bytes) === text ? bytes : null;
}

/** The parameters Node's `scrypt` uses when it is passed none. */
const NODE_DEFAULT_PARAMS: ScryptParameters = { ln: 14, r: 8, p: 1 };

const LEGACY_PATTERN = /^([0-9a-f]+)\.([0-9a-f]+)$/;

/**
 * Reads a stored hash, or returns `null` if it is not one.
 *
 * Exported because the two callers that are not `verifyPassword` need the
 * fields rather than a boolean: `needsRehash` compares the parameters against
 * policy, and `scripts/assert-password-hashing.ts` reads a hash produced by
 * the live module to check the format it claims to write.
 */
export function parsePasswordHash(encoded: string): ParsedPasswordHash | null {
  const legacy = LEGACY_PATTERN.exec(encoded);
  if (legacy) {
    const [, keyHex, saltHex] = legacy;
    // The salt went in as a hex *string* and was passed to `scrypt` as one, so
    // the bytes it was derived over are that string's own encoding and not the
    // bytes it spells. Re-deriving from the decoded value would fail every legacy
    // verification, quietly, for exactly as long as nobody had an old row to
    // test against.
    return {
      params: NODE_DEFAULT_PARAMS,
      salt: Buffer.from(saltHex as string, "utf8"),
      key: Buffer.from(keyHex as string, "hex"),
      legacy: true,
    };
  }

  const fields = encoded.split("$");
  // A PHC string starts with `$`, so the split's first field is empty:
  // ["", "scrypt", "ln=…,r=…,p=…", salt, key].
  if (fields.length !== 5) return null;
  const [empty, algorithm, paramText, saltText, keyText] = fields;
  if (empty !== "" || algorithm !== "scrypt") return null;

  const matched = /^ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,3})$/.exec(
    paramText as string,
  );
  if (!matched) return null;

  const params: ScryptParameters = {
    ln: Number(matched[1]),
    r: Number(matched[2]),
    p: Number(matched[3]),
  };
  if (!withinLimits(params)) return null;

  const salt = fromB64(saltText as string);
  const key = fromB64(keyText as string);
  if (!salt || !key) return null;

  if (salt.length < LIMITS.saltBytes.min || salt.length > LIMITS.saltBytes.max)
    return null;
  if (key.length < LIMITS.keyBytes.min || key.length > LIMITS.keyBytes.max)
    return null;

  return { params, salt, key, legacy: false };
}

/** Renders a parsed hash back to its stored form. */
function encode(params: ScryptParameters, salt: Buffer, key: Buffer): string {
  const fields = `ln=${params.ln},r=${params.r},p=${params.p}`;
  return `$scrypt$${fields}$${toB64(salt)}$${toB64(key)}`;
}

/**
 * Hashes a password at `params`, defaulting to the current policy.
 *
 * The parameter exists for two callers and no others: the tests, which would
 * otherwise pay 414 ms per hash to assert things about a string, and
 * `@/lib/auth/password-upgrade`, which passes the policy explicitly so that
 * what it rehashes to is the same value `needsRehash` measured against rather
 * than whatever the default happens to be by the time the call lands.
 */
export async function hashPassword(
  password: string,
  params: ScryptParameters = PASSWORD_HASH_POLICY,
): Promise<string> {
  if (!withinLimits(params)) {
    throw new RangeError(
      `scrypt parameters out of range: ln=${params.ln}, r=${params.r}, ` +
        `p=${params.p}. The working set may not exceed ` +
        `${MAX_WORKING_SET_BYTES} bytes.`,
    );
  }

  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, scryptOptions(params));

  return encode(params, salt, key);
}

/**
 * Whether `password` produced `encoded`.
 *
 * The derivation uses the parameters read out of `encoded`, which is the whole
 * point of recording them, and the key length comes from the stored key rather
 * than from `KEY_BYTES` — so a hash written before that constant moves still
 * verifies. Both are bounded by `parsePasswordHash`; an unparseable string is
 * `false` rather than a throw, because the caller is a sign-in path and a
 * corrupt row should fail one login, not the request.
 */
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;

  const derived = await derive(
    password,
    parsed.salt,
    parsed.key.length,
    scryptOptions(parsed.params),
  );

  // Lengths match by construction — `parsed.key.length` was the requested key
  // length — but `timingSafeEqual` throws rather than returning false on a
  // mismatch, and this is the one call that must not throw.
  if (derived.length !== parsed.key.length) return false;
  return timingSafeEqual(derived, parsed.key);
}

/**
 * Whether `encoded` was produced below `policy` and should be replaced.
 *
 * Deliberately per-field, and deliberately not a single "work factor" score. A
 * scalar would let a hash at `ln=8, p=200` — trivial memory, and memory
 * hardness is the entire reason to run scrypt rather than PBKDF2 — outscore
 * one at policy and report as current. Comparing each field means a hash is
 * acceptable only if it is at least as expensive as policy in every dimension
 * that matters, which is the conservative direction: the cost of a false
 * positive is one extra derivation and one `UPDATE` on a sign-in that is
 * already paying for both.
 *
 * It is not symmetric. A hash *above* policy — someone's parameters after the
 * line was lowered, or a row written by a newer deployment during a rollout —
 * is left alone. Rehashing it would be a downgrade performed automatically on
 * everyone who signs in, which is a worse failure than the one this prevents.
 *
 * An unparseable string reports `true`: it cannot be verified, so the only
 * path on which this is reached at all is one where it somehow was, and
 * replacing it is strictly better than keeping it.
 */
export function needsRehash(
  encoded: string,
  policy: ScryptParameters = PASSWORD_HASH_POLICY,
): boolean {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return true;
  if (parsed.legacy) return true;

  if (parsed.params.ln < policy.ln) return true;
  if (parsed.params.r < policy.r) return true;
  if (parsed.params.p < policy.p) return true;
  if (parsed.salt.length < SALT_BYTES) return true;
  if (parsed.key.length < KEY_BYTES) return true;

  return false;
}
