/**
 * Holds the password hash, and the path that upgrades it, to this tree.
 *
 * ## What this gate is for
 *
 * Before this item, `src/lib/password.ts` stored `hex.salt` and derived with
 * `scrypt(password, salt, 64)`. That is a correct hash whose cost can never
 * change: nothing in the stored string says what produced it, so reading one
 * back means repeating whatever the code does today. Raising the parameters
 * would have invalidated every account in the database at once.
 *
 * Every part of the fix has the same failure mode, and it is the reason this
 * file exists. Delete the `upgradePasswordHash` call from `authorize` and
 * every sign-in still works — hashes simply stop being upgraded, forever, with
 * no error anywhere. Lower `PASSWORD_HASH_POLICY` and the whole unit suite
 * stays green, because `needsRehash` compares against that same constant, so a
 * weaker policy makes every hash "current" by definition. Drop the legacy
 * branch from the parser and nothing fails until the first person with an
 * account older than the change tries to sign in. Drop `maxmem` and the module
 * works right up to the moment somebody raises the cost, which is the one
 * thing it was rewritten to allow.
 *
 * None of those are things a unit test catches, because a unit test asserts
 * what the module in front of it does and each of these is a property of the
 * module *together with* its callers, or of a constant the tests read too.
 *
 * ## R — the wiring, read off the source
 *
 *   R1  The credentials provider calls `upgradePasswordHash`, awaited, after
 *       `verifyPassword` has returned. Sign-in is the only request in an
 *       account's life that holds the plaintext; if this call is not on it,
 *       there is no other place to put it. Awaited because a floating promise
 *       is cancelled with the request in a serverless runtime, so the
 *       difference between the two spellings is visible only in production.
 *   R2  Nothing but `@/lib/password` derives a password. A second `scrypt`
 *       call site is a second format, and the one that is not this module's
 *       records nothing.
 *   R3  Nothing but an enumerated set of modules writes a `password` field.
 *       The set is small on purpose: registration, the upgrade, and the seed.
 *       A fourth writer is a fourth thing that can put a value in that column
 *       which `verifyPassword` was never asked about.
 *   R4  `PASSWORD_HASH_POLICY` is at or above a floor. This is the rule that
 *       makes the other three worth having: a self-describing format is a way
 *       to *change* the cost, and nothing else in this repository would notice
 *       it changing downwards.
 *
 * ## P — what the module actually does, probed
 *
 * The rules above are regexes over source, which is the right tool for "is
 * this call still here" and the wrong one for "does this still work". So the
 * gate also imports the module — from `root`, so the tests can sabotage a copy
 * and watch these fail too — and runs four derivations against it.
 *
 *   P1  A hash at policy verifies, reports as current, and is in the format
 *       this module documents.
 *   P2  A hash written by the *previous* implementation still verifies, and
 *       reports as needing a rehash. The old code is reproduced here rather
 *       than imported, because the point is a string this module no longer
 *       knows how to write: a row already in somebody's `users` table. Losing
 *       this locks out every account predating the change.
 *   P3  The cost is raisable. One step above policy hashes and verifies —
 *       which is the whole claim of the item, and which fails the moment
 *       `maxmem` stops being derived from the parameters, because Node
 *       defaults it to 32 MiB and refuses anything larger.
 *   P4  A stored hash demanding more memory than the module's ceiling is
 *       refused rather than allocated. The parameters in a hash are an
 *       allocation size read on an unauthenticated POST.
 */
import { readFileSync, readdirSync } from "node:fs";
import { scrypt, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export interface Finding {
  rule: "R1" | "R2" | "R3" | "R4" | "P1" | "P2" | "P3" | "P4";
  file: string;
  message: string;
}

export const PASSWORD_FILE = "src/lib/password.ts";
export const UPGRADE_FILE = "src/lib/auth/password-upgrade.ts";
export const AUTH_FILE = "src/auth.ts";

/**
 * Every module allowed to write a `password` column, and why.
 *
 * `prisma/seed.ts` is in the list because a seed that wrote a hash of its own
 * making would be a demo account nobody can sign into, discovered by hand.
 */
export const PASSWORD_WRITERS = [
  "src/actions/auth.ts",
  UPGRADE_FILE,
  "prisma/seed.ts",
] as const;

/**
 * The lowest parameters this repository will ship.
 *
 * `ln = 15` and `r = 8` is a 32 MiB working set, which is one step below the
 * policy and one step above what Node's own defaults give. It is a floor and
 * not a target: it exists so that lowering the policy — a one-character edit
 * that no test in this repository can fail on, because they all measure
 * against the policy itself — has to be argued for here instead.
 */
export const POLICY_FLOOR = { ln: 15, r: 8, p: 1 } as const;

const scryptAsync = promisify(scrypt);

function read(root: string, relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/**
 * Comments stripped before every search below.
 *
 * These modules explain at length why the write is a compare-and-set and why
 * the upgrade happens on sign-in. A gate that matched its own documentation
 * would pass on a file whose prose is intact and whose code is gone.
 */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The `{ ln, r, p }` literal assigned to `name`, read off the source. */
export function parameterLiteral(
  source: string,
  name: string,
): { ln: number; r: number; p: number } | null {
  const matched = new RegExp(
    `${name}[^=]*=\\s*\\{\\s*ln:\\s*(\\d+),\\s*r:\\s*(\\d+),\\s*p:\\s*(\\d+)`,
  ).exec(withoutComments(source));
  if (!matched) return null;

  return {
    ln: Number(matched[1]),
    r: Number(matched[2]),
    p: Number(matched[3]),
  };
}

/** The module's public surface, as the probes below use it. */
interface PasswordModule {
  hashPassword(
    password: string,
    params?: { ln: number; r: number; p: number },
  ): Promise<string>;
  verifyPassword(password: string, encoded: string): Promise<boolean>;
  needsRehash(
    encoded: string,
    policy?: { ln: number; r: number; p: number },
  ): boolean;
  PASSWORD_HASH_POLICY: { ln: number; r: number; p: number };
}

/**
 * The previous implementation, reproduced byte for byte.
 *
 * Two details decide whether P2 means anything. The salt reached `scrypt` as a
 * hex *string*, so the bytes hashed were that string's own and not the ones it
 * spells; and the key was 64 bytes, not 32. Getting either wrong here would
 * produce a fixture that the current module fails on for reasons that have
 * nothing to do with a real row.
 */
async function legacyHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${derived.toString("hex")}.${salt}`;
}

function staticRules(root: string): Finding[] {
  const findings: Finding[] = [];

  // R1 — sign-in upgrades.
  const authCode = withoutComments(read(root, AUTH_FILE));
  const verifyAt = authCode.indexOf("verifyPassword(");
  const upgradeAt = authCode.search(/await\s+upgradePasswordHash\s*\(/);

  if (verifyAt === -1) {
    findings.push({
      rule: "R1",
      file: AUTH_FILE,
      message:
        "no longer calls verifyPassword. The credentials provider is the " +
        "only caller of the password module in the application.",
    });
  } else if (upgradeAt === -1) {
    findings.push({
      rule: "R1",
      file: AUTH_FILE,
      message:
        "does not `await upgradePasswordHash(...)`. Without it every hash " +
        "stays at the cost it was written at forever, which is exactly the " +
        "state this item was opened to fix — and sign-in keeps working, so " +
        "nothing else reports it. A floating call is not enough: a promise " +
        "not awaited here is cancelled with the request on a serverless " +
        "runtime.",
    });
  } else if (upgradeAt < verifyAt) {
    findings.push({
      rule: "R1",
      file: AUTH_FILE,
      message:
        "upgrades the hash before verifying the password. Re-deriving from " +
        "an unverified plaintext writes an attacker's guess into the column.",
    });
  }

  // R2 — one derivation site.
  for (const file of [UPGRADE_FILE, AUTH_FILE, "src/actions/auth.ts"]) {
    const source = withoutComments(read(root, file));
    if (!/\bscrypt\b|\bpbkdf2\b/.test(source)) continue;

    findings.push({
      rule: "R2",
      file,
      message:
        "derives a key itself. Every password in this application is hashed " +
        `by ${PASSWORD_FILE} and nowhere else; a second call site is a ` +
        "second format, and it is the one that records nothing.",
    });
  }

  // R3 — one small set of writers.
  const writers = new Set<string>(PASSWORD_WRITERS);
  for (const file of sourceFiles(root)) {
    if (writers.has(file)) continue;
    const source = withoutComments(read(root, file));
    if (!/data:\s*\{[^}]*\bpassword\b\s*:/s.test(source)) continue;

    findings.push({
      rule: "R3",
      file,
      message:
        "writes a password field. The writers are enumerated in " +
        "PASSWORD_WRITERS; a new one is a new way for a value to enter that " +
        "column without hashPassword having produced it.",
    });
  }

  // R4 — the policy has a floor.
  const policy = parameterLiteral(
    read(root, PASSWORD_FILE),
    "PASSWORD_HASH_POLICY",
  );
  if (!policy) {
    findings.push({
      rule: "R4",
      file: PASSWORD_FILE,
      message:
        "declares no PASSWORD_HASH_POLICY as an `{ ln, r, p }` literal, so " +
        "the cost new hashes are written at cannot be read from here.",
    });
  } else {
    for (const key of ["ln", "r", "p"] as const) {
      if (policy[key] >= POLICY_FLOOR[key]) continue;

      findings.push({
        rule: "R4",
        file: PASSWORD_FILE,
        message:
          `PASSWORD_HASH_POLICY.${key} is ${policy[key]}, below the floor of ` +
          `${POLICY_FLOOR[key]}. Nothing else in this repository fails when ` +
          "the policy is lowered — `needsRehash` measures against it, so a " +
          "weaker policy makes every stored hash read as current.",
      });
    }
  }

  return findings;
}

/**
 * Runs one probe, turning a throw into that probe's finding.
 *
 * Without this the gate reports a rule for a module that misbehaves and a
 * stack trace for one that explodes — and the second is the more likely
 * regression, because every parameter here is an argument to `scrypt`, which
 * signals a bad one by raising. A stack trace still fails CI, but it fails it
 * without naming the property that was lost, and it stops the probes after it
 * from running at all.
 */
async function probe(
  rule: Finding["rule"],
  body: () => Promise<Finding[]>,
): Promise<Finding[]> {
  try {
    return await body();
  } catch (error) {
    return [
      {
        rule,
        file: PASSWORD_FILE,
        message:
          "threw while being probed: " +
          `${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
}

/** P1 — a hash at policy round-trips, reads as current, and is in format. */
async function probeCurrent(mod: PasswordModule): Promise<Finding[]> {
  const findings: Finding[] = [];
  const current = await mod.hashPassword("a correct horse battery staple");

  if (
    !/^\$scrypt\$ln=\d+,r=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(
      current,
    )
  ) {
    findings.push({
      rule: "P1",
      file: PASSWORD_FILE,
      message:
        `writes ${JSON.stringify(current.slice(0, 40))}…, which is not the ` +
        "documented `$scrypt$ln=…,r=…,p=…$salt$key` form. A hash that does " +
        "not carry its parameters cannot have them raised.",
    });
  }

  if (!(await mod.verifyPassword("a correct horse battery staple", current))) {
    findings.push({
      rule: "P1",
      file: PASSWORD_FILE,
      message: "does not verify a hash it just produced.",
    });
  }

  if (await mod.verifyPassword("a wrong horse", current)) {
    findings.push({
      rule: "P1",
      file: PASSWORD_FILE,
      message: "verifies the wrong password.",
    });
  }

  if (mod.needsRehash(current)) {
    findings.push({
      rule: "P1",
      file: PASSWORD_FILE,
      message:
        "reports a hash it just wrote at policy as needing a rehash, which " +
        "would re-derive and re-write on every sign-in, for every account, " +
        "forever.",
    });
  }

  return findings;
}

/** P2 — the format this module replaced still opens. */
async function probeLegacy(mod: PasswordModule): Promise<Finding[]> {
  const findings: Finding[] = [];
  const legacy = await legacyHash("a correct horse battery staple");

  if (!(await mod.verifyPassword("a correct horse battery staple", legacy))) {
    findings.push({
      rule: "P2",
      file: PASSWORD_FILE,
      message:
        "cannot verify a hash in the `hex.salt` format this module used to " +
        "write. Every account created before that change is locked out, and " +
        "nothing in a fresh database would show it.",
    });
  }

  if (await mod.verifyPassword("a wrong horse", legacy)) {
    findings.push({
      rule: "P2",
      file: PASSWORD_FILE,
      message: "verifies the wrong password against a legacy hash.",
    });
  }

  if (!mod.needsRehash(legacy)) {
    findings.push({
      rule: "P2",
      file: PASSWORD_FILE,
      message:
        "reports a legacy hash as current, so the accounts most in need of " +
        "an upgrade are the ones that never get one.",
    });
  }

  return findings;
}

/** P3 — the cost is raisable, which is the whole of the item. */
async function probeRaisable(mod: PasswordModule): Promise<Finding[]> {
  const raised = { ...mod.PASSWORD_HASH_POLICY };
  raised.ln += 1;

  let stronger: string;
  try {
    stronger = await mod.hashPassword("pw", raised);
  } catch (error) {
    return [
      {
        rule: "P3",
        file: PASSWORD_FILE,
        message:
          `cannot hash at ln=${raised.ln}, one step above policy: ` +
          `${error instanceof Error ? error.message : String(error)}. Node ` +
          "defaults scrypt's maxmem to 32 MiB and refuses any parameter set " +
          "needing more, so recording the parameters is necessary and not " +
          "sufficient — maxmem has to be derived from them too. Being able " +
          "to raise the cost is the point of the format.",
      },
    ];
  }

  if (await mod.verifyPassword("pw", stronger)) return [];

  return [
    {
      rule: "P3",
      file: PASSWORD_FILE,
      message: `cannot verify a hash it produced at ln=${raised.ln}.`,
    },
  ];
}

/** P4 — a hostile parameter set is refused rather than allocated. */
async function probeCeiling(mod: PasswordModule): Promise<Finding[]> {
  // ln=24, r=32 asks for 64 GiB, from a string read on an unauthenticated POST.
  const bomb =
    "$scrypt$ln=24,r=32,p=1$c2FsdHNhbHRzYWx0c2FsdA$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5";

  try {
    if (!(await mod.verifyPassword("any", bomb))) return [];
  } catch (error) {
    return [
      {
        rule: "P4",
        file: PASSWORD_FILE,
        message:
          "threw on a hash demanding 64 GiB rather than refusing it: " +
          `${error instanceof Error ? error.message : String(error)}. The ` +
          "parameters in a stored hash are an allocation size; a throw on " +
          "that path is a 500 per sign-in attempt rather than a failed one.",
      },
    ];
  }

  return [
    {
      rule: "P4",
      file: PASSWORD_FILE,
      message: "verified a password against a hash asking for 64 GiB.",
    },
  ];
}

async function probes(root: string): Promise<Finding[]> {
  const url = pathToFileURL(path.join(root, PASSWORD_FILE)).href;
  const mod = (await import(url)) as PasswordModule;

  return [
    ...(await probe("P1", () => probeCurrent(mod))),
    ...(await probe("P2", () => probeLegacy(mod))),
    ...(await probe("P3", () => probeRaisable(mod))),
    ...(await probe("P4", () => probeCeiling(mod))),
  ];
}

/** Every `.ts`/`.tsx` under `src/` plus `prisma/seed.ts`, repo-relative. */
function sourceFiles(root: string): string[] {
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
  found.push("prisma/seed.ts");
  return found;
}

export async function check(root: string): Promise<Finding[]> {
  return [...staticRules(root), ...(await probes(root))];
}

export async function main(root: string): Promise<number> {
  const findings = await check(root);

  if (findings.length > 0) {
    console.error("Password hashing gate failed:\n");
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(`\n${findings.length} finding(s).`);
    return 1;
  }

  console.log(
    "Password hashing OK — the hash records its own parameters, sign-in " +
      "upgrades one below policy, the previous format still verifies, the " +
      "cost is raisable, and a hash demanding gigabytes is refused.",
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
