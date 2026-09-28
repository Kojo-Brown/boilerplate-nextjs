/**
 * Asserts the seven properties upload validation depends on, every one of which
 * can be lost while the feature goes on working.
 *
 * That is the test for whether something belongs in this file rather than in a
 * unit test, and uploads are a clean example of it. Take the sniff out of
 * `verifyUploadedObject` and every upload still succeeds — faster, even. Put
 * `image/svg+xml` back on the allowlist and SVG uploads start working again,
 * which looks like a feature. Drop the user-id comparison in
 * `finalizeUploadAction` and nothing changes for any caller who is not attacking
 * it. Hand `publicUrl` back from the presign again and the client is simpler.
 * None of those is a behaviour a test observes as broken, because what stops
 * happening is a *check*, and a check that stops happening looks exactly like a
 * check that passed.
 *
 *   R1  Every type in `ALLOWED_MIME_TYPES` is one the sniffer recognises. An
 *       allowed type with no signature has two possible fates and both are bad:
 *       it rejects every upload of that type — a feature that looks implemented
 *       — or somebody "fixes" that by treating an unrecognised type as
 *       acceptable, which is a hole with a test suite over it. This is also the
 *       rule that stops `image/svg+xml` coming back: there is no byte pattern
 *       that separates a drawing from a document, so no signature can be added
 *       for it, so it cannot pass this rule.
 *
 *   R2  The presign signs `content-length`. Without it the URL authorises a PUT
 *       of any length and the 5 MB cap is three layers agreeing about a number
 *       that binds nothing — which is exactly the state this item found the code
 *       in. Nothing fails when it goes: uploads work, and the limit is a comment.
 *
 *   R3  The presign's result carries no URL the object can be read from. Handing
 *       one back is what made the old flow wrong in principle rather than in
 *       detail: it published a URL for an object nothing had looked at, before
 *       the upload had even happened.
 *
 *   R4  `finalizeUploadAction` compares the key's user segment with the session's
 *       own id. Without it a signed-in caller passes somebody else's quarantine
 *       key and this server reads it, promotes it to a public URL and hands the
 *       URL over — using its own credentials to publish another user's
 *       unverified object. Every honest client keeps working.
 *
 *   R5  The presign writes to the quarantine prefix. A one-word change to the
 *       public one leaves every check in place and makes all of them pointless,
 *       because the object is already readable by the time they run.
 *
 *   R6  The verification path still calls the sniffer and the scan policy. Not
 *       "there is a sniffer module" — that the decision runs. A
 *       `verifyUploadedObject` that reads the object back, measures it and
 *       promotes it accepts every file there is and passes every test that only
 *       checks the accepting path.
 *
 *   R7  The scan policy is `scanAllowsUpload`'s to make, and the two failure
 *       directions stay separate. A `verdict.status === "clean"` written inline
 *       anywhere on the upload path is the fail-open bug: a scanner that times
 *       out stops being distinguishable from one that found nothing.
 *
 * Static analysis, so it needs no build output.
 *
 * Usage: tsx scripts/assert-upload-validation.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export interface Finding {
  rule: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";
  file: string;
  message: string;
}

export const POLICY_FILE = "src/lib/uploads/policy.ts";
export const SNIFF_FILE = "src/lib/uploads/sniff.ts";
export const SCAN_FILE = "src/lib/uploads/scan.ts";
export const VERIFY_FILE = "src/lib/uploads/verify.ts";
export const S3_FILE = "src/lib/s3.ts";
export const ACTION_FILE = "src/actions/upload.ts";

function read(root: string, relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/**
 * Comments are stripped before every search below, and it is not an optimisation.
 * Each of these modules explains at length why SVG is refused, why the length is
 * signed and why the presign returns no readable URL — so a gate that matched its
 * own documentation would pass on a file whose prose is intact and whose code is
 * gone, which is the precise failure it exists to catch.
 */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The string literals of an `as const` array assigned to `name`.
 *
 * Read off the source rather than imported, for the reason every gate here reads
 * source: importing `@/lib/uploads/policy` would make this script agree with
 * whatever the module currently says, including after a rename that left one of
 * the two lists behind.
 */
export function arrayLiterals(source: string, name: string): string[] {
  const match = new RegExp(
    `(?:export\\s+)?const\\s+${name}\\s*(?::[^=]*)?=\\s*\\[([\\s\\S]*?)\\]`,
  ).exec(withoutComments(source));
  if (!match) return [];

  return Array.from(match[1]!.matchAll(/"([^"]+)"/g), (m) => m[1]!);
}

/**
 * The types the sniffer has a signature for, read off the `SIGNATURES` table.
 *
 * Deliberately taken from the table rather than from `SNIFFABLE_TYPES`, which is
 * derived from it: a constant could be edited to claim a type the table does not
 * cover, and that is one of the two ways R1 can be defeated.
 */
export function signatureTypes(sniffSource: string): string[] {
  const match = /const SIGNATURES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(
    withoutComments(sniffSource),
  );
  if (!match) return [];

  return Array.from(
    match[1]!.matchAll(/type:\s*"([^"]+)"/g),
    (entry) => entry[1]!,
  );
}

/** The property names of an interface declaration. */
export function interfaceFields(source: string, name: string): string[] {
  const match = new RegExp(
    `export interface ${name} \\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  if (!match) return [];

  return Array.from(
    match[1]!.matchAll(/^\s{2}([A-Za-z_$][\w$]*)[?]?:/gm),
    (field) => field[1]!,
  );
}

export function check(root: string): Finding[] {
  const findings: Finding[] = [];

  const policy = read(root, POLICY_FILE);
  const sniff = read(root, SNIFF_FILE);
  const scan = read(root, SCAN_FILE);
  const verify = read(root, VERIFY_FILE);
  const s3 = read(root, S3_FILE);
  const action = read(root, ACTION_FILE);

  // R1 — nothing is accepted that cannot be recognised.
  const allowed = arrayLiterals(policy, "ALLOWED_MIME_TYPES");
  const sniffable = signatureTypes(sniff);

  if (allowed.length === 0) {
    findings.push({
      rule: "R1",
      file: POLICY_FILE,
      message:
        "could not read ALLOWED_MIME_TYPES — this gate cannot check an " +
        "allowlist it cannot find.",
    });
  }
  if (sniffable.length === 0) {
    findings.push({
      rule: "R1",
      file: SNIFF_FILE,
      message:
        "could not read the SIGNATURES table — this gate cannot check which " +
        "types are recognisable if it cannot find the signatures.",
    });
  }
  for (const type of allowed) {
    if (!sniffable.includes(type)) {
      findings.push({
        rule: "R1",
        file: POLICY_FILE,
        message:
          `ALLOWED_MIME_TYPES accepts "${type}", which the SIGNATURES table in ` +
          `${SNIFF_FILE} has no entry for. Either every upload of that type is ` +
          `refused by the sniffer, or the sniffer has to start treating an ` +
          `unrecognised format as acceptable. If this is "image/svg+xml": SVG ` +
          `has no magic number and a well-formed SVG carrying <script> is a ` +
          `well-formed SVG, so no signature can be written for it. See ` +
          `docs/uploads.md.`,
      });
    }
  }

  // R2 — the size cap is bound into the signature.
  const s3Code = withoutComments(s3);
  if (!/"content-length":\s*String\(/.test(s3Code)) {
    findings.push({
      rule: "R2",
      file: S3_FILE,
      message:
        "createPresignedUploadUrl no longer signs content-length. Without it " +
        "the presigned URL authorises a PUT of any length whatsoever, and the " +
        "5 MB cap becomes a number three layers agree on and nothing enforces " +
        "— which is the state this item found the code in.",
    });
  }
  if (!/contentLength:\s*input\.sizeBytes/.test(withoutComments(action))) {
    findings.push({
      rule: "R2",
      file: ACTION_FILE,
      message:
        "does not pass the validated sizeBytes to the signer as contentLength, " +
        "so the size the schema checked is not the size S3 is told to require.",
    });
  }

  // R3 — the presign hands back nothing readable.
  const presignResultFields = interfaceFields(s3, "PresignedUploadResult");
  if (presignResultFields.length === 0) {
    findings.push({
      rule: "R3",
      file: S3_FILE,
      message:
        "could not read the PresignedUploadResult interface, so this gate " +
        "cannot tell what the presign hands back.",
    });
  }
  for (const field of presignResultFields) {
    if (/^(publicUrl|objectUrl|readUrl|downloadUrl)$/.test(field)) {
      findings.push({
        rule: "R3",
        file: S3_FILE,
        message:
          `PresignedUploadResult carries "${field}". The presign must return no ` +
          `URL the object can be read from: handing one back publishes an ` +
          `address for an object nothing has looked at, at the moment the URL ` +
          `is minted — before the upload has even happened. ` +
          `finalizeUploadAction returns a URL, after the readback, the sniff ` +
          `and the scan agree.`,
      });
    }
  }

  // R4 — finalize establishes that the key is the caller's.
  const actionCode = withoutComments(action);
  if (!/parsed\.userId\s*!==\s*user\.id/.test(actionCode)) {
    findings.push({
      rule: "R4",
      file: ACTION_FILE,
      message:
        "finalizeUploadAction does not compare the key's user segment with the " +
        "session's own id. Without it a signed-in caller can pass another " +
        "user's quarantine key and have this server read it, promote it to a " +
        "public URL under that user's prefix and hand the URL back — using " +
        "this application's credentials to publish someone else's unverified " +
        "object. Every honest client keeps working.",
    });
  }
  if (!/parseObjectKey\s*\(/.test(actionCode)) {
    findings.push({
      rule: "R4",
      file: ACTION_FILE,
      message:
        "does not parse the submitted key at all, so the prefix and the user " +
        "segment are whatever the caller sent.",
    });
  }

  // R5 — uploads land in quarantine.
  if (!/buildQuarantineKey\s*\(/.test(actionCode)) {
    findings.push({
      rule: "R5",
      file: ACTION_FILE,
      message:
        "the presign does not build a quarantine key. An object written " +
        "straight to the public prefix is readable before anything has checked " +
        "it, which leaves every check in this directory in place and makes all " +
        "of them pointless.",
    });
  }
  if (/PUBLIC_PREFIX\s*\}?\s*\/\$\{/.test(actionCode)) {
    findings.push({
      rule: "R5",
      file: ACTION_FILE,
      message:
        "interpolates the public prefix into a key directly rather than going " +
        "through promotedKeyFor, which is the one place a key becomes public.",
    });
  }

  // R6 — the checks actually run.
  const verifyCode = withoutComments(verify);
  for (const [call, consequence] of [
    [
      "checkDeclaredType",
      "the sniff does not run, so the bytes are never compared with the type " +
        "S3 will serve them as — every file is accepted, which is what the " +
        "code did before this item",
    ],
    [
      "scanAllowsUpload",
      "the scan verdict is not consulted, so an infected object is promoted",
    ],
    [
      "readObjectHead",
      "nothing is read back, so neither the length nor the type is ever measured",
    ],
  ] as const) {
    if (!new RegExp(`\\b${call}\\s*\\(`).test(verifyCode)) {
      findings.push({
        rule: "R6",
        file: VERIFY_FILE,
        message: `never calls ${call}: ${consequence}.`,
      });
    }
  }
  if (!/MAX_FILE_SIZE_BYTES/.test(verifyCode)) {
    findings.push({
      rule: "R6",
      file: VERIFY_FILE,
      message:
        "never compares the measured length against MAX_FILE_SIZE_BYTES, so " +
        "the only cap left is the one S3 was asked to enforce — a claim about " +
        "a request this process did not see.",
    });
  }

  // R7 — the fail-open/fail-closed policy stays in one place.
  const scanCode = withoutComments(scan);
  if (!/requirement\s*===\s*"absent"/.test(scanCode)) {
    findings.push({
      rule: "R7",
      file: SCAN_FILE,
      message:
        "scanAllowsUpload no longer distinguishes a configured scanner from an " +
        "absent one. That distinction is the whole policy: a non-answer must " +
        "refuse the upload when a scanner is configured (or an outage silently " +
        "becomes an absence of scanning) and must not when none is (or a fresh " +
        "clone rejects every upload, and the first person to hit that deletes " +
        "the check).",
    });
  }
  // An object literal, not a comparison: `verdict.status === "clean"` is how the
  // path *reads* a verdict, which is correct. `status: "clean"` is how it would
  // manufacture one.
  if (/status:\s*"clean"/.test(verifyCode)) {
    findings.push({
      rule: "R7",
      file: VERIFY_FILE,
      message:
        "constructs a clean verdict of its own. Only a scanner may report " +
        "clean; the upload path deciding it is the fail-open bug in one line.",
    });
  }
  if (/\bunconfiguredScanner\b/.test(verifyCode)) {
    findings.push({
      rule: "R7",
      file: VERIFY_FILE,
      message:
        "reaches for unconfiguredScanner directly. Which scanner is in use is " +
        "resolveUploadScanner's decision, made from the environment; a default " +
        "chosen on the verification path is a scanner a deployment cannot turn " +
        "on.",
    });
  }

  return findings;
}

export function main(root: string): number {
  const findings = check(root);

  if (findings.length > 0) {
    console.error("Upload validation gate failed:\n");
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(`\n${findings.length} finding(s).`);
    return 1;
  }

  console.log(
    "Upload validation OK — every accepted type is sniffable, content-length " +
      "is signed, the presign returns no readable URL, finalize binds the key " +
      "to the session, uploads land in quarantine, and the sniff, the size " +
      "check and the scan policy all still run.",
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
