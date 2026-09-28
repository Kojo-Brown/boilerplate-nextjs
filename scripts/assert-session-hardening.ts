/**
 * Asserts the six properties session hardening depends on, each of which can be
 * lost without anything failing.
 *
 * Every defence in `src/lib/auth/` has the same shape of failure: the
 * application goes on working. A session that never rotates serves every page
 * correctly. A `Set-Cookie` that loses `Secure` is invisible until somebody is
 * on a hostile network. A proxy that drops the hardened callback logs nothing,
 * because the unhardened callback is Auth.js's default and it returns the token.
 * There is no test that fails, because the thing that stops happening is not a
 * behaviour anyone observes — it is a *property of the code*, which is what
 * makes it checkable here and nowhere else.
 *
 *   R1  No session claim may use a name `jose`'s `EncryptJWT` writes.
 *       `@auth/core`'s `encode` ends `.setIssuedAt().setExpirationTime(…)
 *       .setJti(crypto.randomUUID())`, so `iat`, `exp` and `jti` are
 *       overwritten *after* the `jwt` callback returns. A token id stored under
 *       `jti` never reaches the cookie: every request then presents an id the
 *       registry has never seen, reuse detection fires, and the first page load
 *       after signing in revokes the session and records a security incident
 *       against a user who did nothing. This is not hypothetical — it is what
 *       the first draft did, and no unit test could have caught it, because a
 *       test that mocks the encoder never encodes.
 *
 *   R2  Only `src/proxy.ts` may pass `mayRotate: true`. Anywhere else, the
 *       `Set-Cookie` Auth.js produces is discarded — `next-auth`'s RSC path
 *       reads the body and drops the headers — so a rotation would advance the
 *       registry to a token the browser never receives, and the browser's next
 *       request would be read as reuse. The same one-line mistake that R1
 *       describes, arrived at from the other direction.
 *
 *   R3  The proxy must build its own NextAuth instance with the hardened
 *       callback. `NextAuth(authConfig)` alone type checks, builds, serves
 *       every page and silently never rotates anything.
 *
 *   R4  The session cookie keeps all four flags and the `__Host-` prefix.
 *
 *   R5  `trustHost` is only allowed alongside a pinned origin. Trusting the
 *       host is safe exactly when the host cannot decide anything, and what
 *       makes that true is `AUTH_URL` being set from validated configuration.
 *       Separating the two turns a safe setting into an open redirect and a
 *       cookie whose `Secure` flag a caller chooses.
 *
 *   R6  Sign-out revokes the family. Under a JWT strategy, a sign-out that does
 *       not write to the registry only clears the user's own browser: every
 *       copy of the cookie keeps working until the absolute deadline. Losing
 *       the `events.signOut` handler leaves sign-out looking entirely normal.
 *
 *   R7  A password change revokes every one of that user's sessions, in the
 *       transaction that writes the new hash. Four ways to lose it, and a
 *       working application after each: drop the second statement and the
 *       change succeeds while every stolen cookie keeps working for up to a
 *       week; key it on the family id instead of `userId` and it signs out only
 *       the browser that asked, which is the one session that was not at risk;
 *       move either write onto the imported singleton and it runs on its own
 *       connection, so the revocation commits without the hash or the hash
 *       without the revocation; take the `changeUserPassword` call out of the
 *       action and the form reports success having done nothing. Every one of
 *       those is green on the unit suite, because what stops happening is a
 *       write nobody's assertion is looking at.
 *
 * Static analysis, so it needs no build output.
 *
 * Usage: tsx scripts/assert-session-hardening.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export interface Finding {
  rule: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";
  file: string;
  message: string;
}

/**
 * Claim names `jose` writes itself, via the setters `@auth/core`'s `encode`
 * calls or that a future version plausibly would. A claim stored under any of
 * them is silently replaced on the way into the cookie.
 *
 * `sub` is in the list even though `encode` does not currently set it: it is
 * the registered claim `setSubject` writes, `@auth/core` already puts the user
 * id there, and a session claim colliding with it would be overwritten by the
 * application rather than by the library — the same failure with a different
 * author.
 */
const RESERVED_CLAIMS = ["iss", "sub", "aud", "exp", "nbf", "iat", "jti"];

const CLAIMS_FILE = "src/lib/auth/claims.ts";
const PROXY_FILE = "src/proxy.ts";
const AUTH_CONFIG_FILE = "src/auth.config.ts";
const AUTH_FILE = "src/auth.ts";
const DEPLOYMENT_FILE = "src/lib/auth/deployment.ts";
const PASSWORD_CHANGE_FILE = "src/lib/auth/password-change.ts";
const ACCOUNT_ACTIONS_FILE = "src/actions/account.ts";

/** The files R2 scans: every source file that could call the callback. */
const SOURCE_GLOB_ROOTS = ["src"];

function read(root: string, relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/**
 * The claim names the `SessionClaims` interface declares.
 *
 * Read off the interface body rather than off `writeSessionClaims`, because the
 * interface is the declaration a person edits when they add or rename a claim
 * and is therefore where a reserved name would first appear.
 */
export function declaredClaimNames(claimsSource: string): string[] {
  const body = /export interface SessionClaims \{([\s\S]*?)\n\}/.exec(
    claimsSource,
  );
  if (!body) return [];

  const names: string[] = [];
  for (const line of body[1]!.split("\n")) {
    const match = /^\s{2}([A-Za-z_$][\w$]*)[?]?:/.exec(line);
    if (match) names.push(match[1]!);
  }
  return names;
}

/** Files, other than the proxy, that pass `mayRotate: true`. */
export function rotationCallSites(
  files: { relativePath: string; text: string }[],
): string[] {
  return files
    .filter(
      (file) =>
        file.relativePath !== PROXY_FILE &&
        /\bmayRotate\s*:\s*true\b/.test(stripComments(file.text)),
    )
    .map((file) => file.relativePath);
}

/**
 * Comments are stripped before the `mayRotate` search because every one of
 * these files explains, in prose, why `mayRotate: true` belongs only in the
 * proxy — and a gate that matched its own documentation would fail on the code
 * it is describing.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function listSourceFiles(root: string): {
  relativePath: string;
  text: string;
}[] {
  const out: { relativePath: string; text: string }[] = [];

  const walk = (directory: string) => {
    for (const entry of readdirSync(path.join(root, directory), {
      withFileTypes: true,
    })) {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(relativePath);
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name)
      ) {
        out.push({
          relativePath,
          text: readFileSync(path.join(root, relativePath), "utf8"),
        });
      }
    }
  };

  for (const base of SOURCE_GLOB_ROOTS) walk(base);
  return out;
}

export function check(root: string): Finding[] {
  const findings: Finding[] = [];

  // R1 — no claim name the encoder overwrites.
  const claimsSource = read(root, CLAIMS_FILE);
  const declared = declaredClaimNames(claimsSource);
  if (declared.length === 0) {
    findings.push({
      rule: "R1",
      file: CLAIMS_FILE,
      message:
        "could not read the SessionClaims interface — this gate cannot check " +
        "claim names it cannot find.",
    });
  }
  for (const name of declared) {
    if (RESERVED_CLAIMS.includes(name)) {
      findings.push({
        rule: "R1",
        file: CLAIMS_FILE,
        message:
          `SessionClaims declares "${name}", which jose's EncryptJWT writes ` +
          `itself — @auth/core's encode() calls .setIssuedAt(), ` +
          `.setExpirationTime() and .setJti(crypto.randomUUID()) after the ` +
          `jwt callback returns. The value would never reach the cookie.`,
      });
    }
  }

  // R2 — rotation only where a cookie can be written.
  const sources = listSourceFiles(root);
  for (const file of rotationCallSites(sources)) {
    findings.push({
      rule: "R2",
      file,
      message:
        `passes mayRotate: true, but only ${PROXY_FILE} can put the rotated ` +
        `token on a response. Rotating elsewhere advances the registry to a ` +
        `token the browser never receives, and its next request is then read ` +
        `as reuse.`,
    });
  }

  // R3 — the proxy still composes the hardened callback.
  const proxySource = stripComments(read(root, PROXY_FILE));
  if (!/hardenSessionToken\s*\(/.test(proxySource)) {
    findings.push({
      rule: "R3",
      file: PROXY_FILE,
      message:
        "does not call hardenSessionToken. Without it the proxy runs Auth.js's " +
        "default jwt callback: every page still works and no session ever " +
        "rotates.",
    });
  }
  if (!/\bmayRotate\s*:\s*true\b/.test(proxySource)) {
    findings.push({
      rule: "R3",
      file: PROXY_FILE,
      message:
        "never passes mayRotate: true, so rotation is wired up but switched " +
        "off — indistinguishable from working, from the outside.",
    });
  }

  // R4 — the cookie keeps its flags.
  const configSource = read(root, AUTH_CONFIG_FILE);
  for (const [label, pattern] of [
    ["httpOnly: true", /httpOnly:\s*true/],
    ["secure", /secure:\s*USE_SECURE_COOKIES/],
    ["sameSite", /sameSite:\s*"lax"/],
    ['path: "/"', /path:\s*"\/"/],
  ] as const) {
    if (!pattern.test(configSource)) {
      findings.push({
        rule: "R4",
        file: AUTH_CONFIG_FILE,
        message: `the session cookie no longer declares ${label}.`,
      });
    }
  }
  if (/\bdomain:/.test(stripComments(configSource))) {
    findings.push({
      rule: "R4",
      file: AUTH_CONFIG_FILE,
      message:
        "sets a cookie `domain`, which the __Host- prefix forbids — a browser " +
        "rejects such a cookie outright, so nobody could sign in.",
    });
  }

  const deploymentSource = read(root, DEPLOYMENT_FILE);
  if (!/__Host-/.test(deploymentSource)) {
    findings.push({
      rule: "R4",
      file: DEPLOYMENT_FILE,
      message:
        "no longer uses the __Host- prefix. __Secure- does not stop a sibling " +
        "subdomain from setting a Domain-scoped session cookie this " +
        "application would read.",
    });
  }

  // R5 — trustHost only alongside a pinned origin.
  if (/trustHost:\s*true/.test(stripComments(configSource))) {
    if (!/process\.env\["AUTH_URL"\]\s*\?\?=/.test(deploymentSource)) {
      findings.push({
        rule: "R5",
        file: AUTH_CONFIG_FILE,
        message:
          "sets trustHost: true while " +
          `${DEPLOYMENT_FILE} no longer pins AUTH_URL. Auth.js would then ` +
          "derive its own origin from x-forwarded-host and x-forwarded-proto, " +
          "which a caller sends — deciding redirect targets and whether the " +
          "session cookie is marked Secure.",
      });
    }
  }

  // R6 — sign-out revokes.
  const authSource = stripComments(read(root, AUTH_FILE));
  if (!/signOut\s*\(/.test(authSource) || !/revoke\s*\(/.test(authSource)) {
    findings.push({
      rule: "R6",
      file: AUTH_FILE,
      message:
        "has no signOut handler that revokes the session family. Under a JWT " +
        "strategy that makes signing out a browser-side gesture: every copy " +
        "of the cookie keeps working until the absolute deadline.",
    });
  }

  // R7 — a password change ends every session, atomically with the new hash.
  findings.push(...checkPasswordChange(root));

  return findings;
}

/**
 * R7, as four independent checks on two files.
 *
 * Syntactic, like the rest of this gate, and for the reason `assert-
 * transactional-writes.ts` gives about its own subject: `unscopedPrisma` and the
 * transaction client are both Prisma clients with the same delegates, so using
 * the wrong one is well-typed by construction. There is nothing for a type or a
 * mocked-out unit test to notice.
 */
export function checkPasswordChange(root: string): Finding[] {
  const findings: Finding[] = [];
  const source = stripComments(read(root, PASSWORD_CHANGE_FILE));

  if (!/\$transaction\s*\(/.test(source)) {
    findings.push({
      rule: "R7",
      file: PASSWORD_CHANGE_FILE,
      message:
        "opens no transaction. The new hash and the revocation have to commit " +
        "together: separately, a failure between them leaves an account with a " +
        "password its owner did not choose and sessions they believe they " +
        "closed — and no way to retry, because the current password they would " +
        "have to type is no longer current.",
    });
  }

  for (const [what, pattern] of [
    ["the new hash", /\btx\.user\.updateMany\s*\(/],
    ["the revocation", /\btx\.sessionFamily\.updateMany\s*\(/],
  ] as const) {
    if (pattern.test(source)) continue;

    findings.push({
      rule: "R7",
      file: PASSWORD_CHANGE_FILE,
      message:
        `does not write ${what} through the transaction client \`tx\`. On the ` +
        "imported singleton the statement runs on its own connection: it " +
        "commits independently and survives a rollback of the other half.",
    });
  }

  // Keyed on the user, not on one family. The narrow version is the one that
  // looks like it works — the person changing their password is signed out, so
  // the feature appears to do something, and the sessions it exists to end are
  // exactly the ones left running.
  const revocation =
    /\btx\.sessionFamily\.updateMany\s*\(\s*\{\s*where:\s*\{([^}]*)\}/.exec(
      source,
    );
  // `userId` has to be a *key* of the predicate, not merely a word in it. The
  // first draft of this rule tested `/\buserId\b/`, which the regression it
  // exists for satisfies: `where: { id: userId }` names the variable and filters
  // on the family id. Checked against that edit, not against a passing tree.
  if (revocation && !/(^|,)\s*userId\s*(,|:|$)/.test(revocation[1] as string)) {
    findings.push({
      rule: "R7",
      file: PASSWORD_CHANGE_FILE,
      message:
        "revokes on a predicate that does not mention `userId`, so a password " +
        "change ends some smaller set of sessions than all of them. The " +
        "browser that asked is the one session a password change is not " +
        "protecting against.",
    });
  }

  const action = stripComments(read(root, ACCOUNT_ACTIONS_FILE));
  if (!/\bchangeUserPassword\s*\(/.test(action)) {
    findings.push({
      rule: "R7",
      file: ACCOUNT_ACTIONS_FILE,
      message:
        "does not call changeUserPassword, so whatever the form posts to, it " +
        "is not the path that revokes the sessions.",
    });
  }

  return findings;
}

export function main(root: string): number {
  const findings = check(root);

  if (findings.length > 0) {
    console.error("Session hardening gate failed:\n");
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(`\n${findings.length} finding(s).`);
    return 1;
  }

  console.log(
    "Session hardening OK — claim names clear of jose's reserved set, " +
      "rotation confined to the proxy, cookie flags and __Host- prefix intact, " +
      "trustHost paired with a pinned origin, sign-out revokes the family, " +
      "a password change revokes every session in the same transaction.",
  );
  return 0;
}

/* c8 ignore start -- CLI entry; the logic above is what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
