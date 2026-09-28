import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  arrayLiterals,
  check,
  interfaceFields,
  signatureTypes,
  withoutComments,
} from "./assert-upload-validation";

const REPO = process.cwd();

/**
 * A copy of the real sources, which the caller then breaks in one specific way.
 *
 * Copying the tree rather than writing fixtures by hand is what makes each case
 * below a statement about *this* repository: the gate has to pass as it stands
 * and fail with one line changed. A hand-written fixture would only prove the
 * regex works.
 */
function withBrokenTree(
  edits: { file: string; edit: (source: string) => string }[],
): string {
  const root = mkdtempSync(path.join(tmpdir(), "upload-gate-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });

  for (const { file, edit } of edits) {
    const target = path.join(root, file);
    const before = readFileSync(target, "utf8");
    const after = edit(before);
    // A sabotage that changed nothing would make the case below pass or fail for
    // reasons having nothing to do with the gate.
    if (after === before) {
      throw new Error(`the edit to ${file} changed nothing`);
    }
    writeFileSync(target, after, "utf8");
  }
  return root;
}

function rules(findings: { rule: string }[]): string[] {
  return findings.map((finding) => finding.rule);
}

describe("the gate passes on this repository", () => {
  it("finds nothing", () => {
    expect(check(REPO)).toEqual([]);
  });
});

describe("R1 — every accepted type must be sniffable", () => {
  it("fails when image/svg+xml is put back on the allowlist", () => {
    // The change this rule exists to refuse, and it is a change that looks like
    // restoring a feature. There is no signature that could be added to make it
    // pass: SVG is XML, and a well-formed SVG carrying <script> is a well-formed
    // SVG.
    const root = withBrokenTree([
      {
        file: "src/lib/uploads/policy.ts",
        edit: (source) =>
          source.replace(
            '  "image/gif",\n] as const;',
            '  "image/gif",\n  "image/svg+xml",\n] as const;',
          ),
      },
    ]);

    const findings = check(root);
    expect(rules(findings)).toContain("R1");
    expect(findings[0]!.message).toContain("image/svg+xml");
  });

  it("fails when any accepted type loses its signature", () => {
    const root = withBrokenTree([
      {
        file: "src/lib/uploads/sniff.ts",
        edit: (source) =>
          source.replace(
            '  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },\n',
            "",
          ),
      },
    ]);

    expect(rules(check(root))).toContain("R1");
  });

  it("is not fooled by SNIFFABLE_TYPES claiming a type the table lacks", () => {
    // The second way the rule could be defeated: the constant is derived from the
    // table, so the gate reads the table.
    const root = withBrokenTree([
      {
        file: "src/lib/uploads/policy.ts",
        edit: (source) =>
          source.replace(
            '  "image/gif",\n] as const;',
            '  "image/gif",\n  "image/svg+xml",\n] as const;',
          ),
      },
      {
        file: "src/lib/uploads/sniff.ts",
        edit: (source) =>
          source.replace(
            "export const SNIFFABLE_TYPES: readonly AllowedMimeType[] = Array.from(\n  new Set(SIGNATURES.map((signature) => signature.type)),\n);",
            'export const SNIFFABLE_TYPES: readonly AllowedMimeType[] = [\n  "image/jpeg",\n  "image/png",\n  "image/webp",\n  "image/gif",\n  "image/svg+xml" as AllowedMimeType,\n];',
          ),
      },
    ]);

    expect(rules(check(root))).toContain("R1");
  });

  it("reports the allowlist being unreadable rather than passing vacuously", () => {
    const root = withBrokenTree([
      {
        file: "src/lib/uploads/policy.ts",
        edit: (source) =>
          source.replace("export const ALLOWED_MIME_TYPES", "const TYPES_LIST"),
      },
    ]);

    const findings = check(root);
    expect(rules(findings)).toContain("R1");
    expect(findings.some((f) => /could not read/.test(f.message))).toBe(true);
  });
});

describe("R2 — the size cap is bound into the signature", () => {
  it("fails when content-length stops being signed", () => {
    // The defect this item found: with `content-type;host` signed over an
    // UNSIGNED-PAYLOAD, the URL authorised a PUT of any length. Nothing breaks
    // when it goes — uploads work, and the limit is a comment.
    const root = withBrokenTree([
      {
        file: "src/lib/s3.ts",
        edit: (source) =>
          source.replace(
            '      "content-length": String(options.contentLength),\n',
            "",
          ),
      },
    ]);

    expect(rules(check(root))).toContain("R2");
  });

  it("fails when the action stops passing the validated size to the signer", () => {
    const root = withBrokenTree([
      {
        file: "src/actions/upload.ts",
        edit: (source) =>
          source.replace(
            "contentLength: input.sizeBytes,",
            "contentLength: 5 * 1024 * 1024,",
          ),
      },
    ]);

    expect(rules(check(root))).toContain("R2");
  });
});

describe("R3 — the presign returns nothing readable", () => {
  it("fails when publicUrl comes back to the presign's result", () => {
    const root = withBrokenTree([
      {
        file: "src/lib/s3.ts",
        edit: (source) =>
          source.replace(
            "export interface PresignedUploadResult {\n  uploadUrl: string;",
            "export interface PresignedUploadResult {\n  uploadUrl: string;\n  publicUrl: string;",
          ),
      },
    ]);

    const findings = check(root);
    expect(rules(findings)).toContain("R3");
    expect(findings[0]!.message).toContain("publicUrl");
  });

  it("catches the same field under another name", () => {
    // Renaming it does not make it a different thing.
    for (const name of ["objectUrl", "readUrl", "downloadUrl"]) {
      const root = withBrokenTree([
        {
          file: "src/lib/s3.ts",
          edit: (source) =>
            source.replace(
              "export interface PresignedUploadResult {\n  uploadUrl: string;",
              `export interface PresignedUploadResult {\n  uploadUrl: string;\n  ${name}: string;`,
            ),
        },
      ]);

      expect(rules(check(root)), name).toContain("R3");
    }
  });
});

describe("R4 — finalize binds the key to the session", () => {
  it("fails when the user segment is no longer compared with the session id", () => {
    // Every honest client keeps working. What stops working is the only thing
    // stopping a caller from having this server publish another user's object.
    const root = withBrokenTree([
      {
        file: "src/actions/upload.ts",
        edit: (source) =>
          source.replace("      parsed.userId !== user.id\n", ""),
      },
    ]);

    expect(rules(check(root))).toContain("R4");
  });

  it("fails when the key is not parsed at all", () => {
    const root = withBrokenTree([
      {
        file: "src/actions/upload.ts",
        edit: (source) =>
          source.replace(/parseObjectKey\(/g, "((key: string) => null)("),
      },
    ]);

    expect(rules(check(root))).toContain("R4");
  });
});

describe("R5 — uploads land in quarantine", () => {
  it("fails when the presign writes straight to the public prefix", () => {
    // A one-word change that leaves every check in place and makes all of them
    // pointless: the object is readable by the time they run.
    const root = withBrokenTree([
      {
        file: "src/actions/upload.ts",
        edit: (source) =>
          source.replace(
            "      key: buildQuarantineKey({\n        userId: user.id,\n        contentType: input.contentType,\n      }),",
            "      key: `${PUBLIC_PREFIX}/${user.id}/${Date.now()}.png`,",
          ),
      },
    ]);

    const findings = check(root);
    expect(rules(findings)).toContain("R5");
  });
});

describe("R6 — the checks actually run", () => {
  it("fails when the sniff is dropped from the verification path", () => {
    // The sharpest case in this file. Remove the sniff and every upload is
    // accepted — which is what the code did before this item, and no test of the
    // accepting path notices.
    const root = withBrokenTree([
      {
        file: "src/lib/uploads/verify.ts",
        edit: (source) =>
          source.replace(
            "const sniff = checkDeclaredType(head.bytes, head.storedContentType);",
            "const sniff = { agrees: true, type: head.storedContentType } as const;",
          ),
      },
    ]);

    expect(rules(check(root))).toContain("R6");
  });

  it("fails when the scan verdict is no longer consulted", () => {
    const root = withBrokenTree([
      {
        file: "src/lib/uploads/verify.ts",
        edit: (source) =>
          source.replace(
            "!scanAllowsUpload(verdict, scanner.requirement)",
            "false",
          ),
      },
    ]);

    expect(rules(check(root))).toContain("R6");
  });

  it("fails when nothing is read back", () => {
    const root = withBrokenTree([
      {
        file: "src/lib/uploads/verify.ts",
        edit: (source) =>
          source.replace(
            "head = await readObjectHead(quarantineTarget, fetchImpl);",
            'head = { bytes: new Uint8Array(), totalBytes: declaredSizeBytes, storedContentType: "image/png" };',
          ),
      },
    ]);

    expect(rules(check(root))).toContain("R6");
  });

  it("fails when the measured length is no longer compared with the cap", () => {
    const root = withBrokenTree([
      {
        file: "src/lib/uploads/verify.ts",
        edit: (source) =>
          source.replace(/MAX_FILE_SIZE_BYTES/g, "Number.MAX_SAFE_INTEGER"),
      },
    ]);

    expect(rules(check(root))).toContain("R6");
  });
});

describe("R7 — the scan policy stays in one place", () => {
  it("fails when scanAllowsUpload stops distinguishing a configured scanner", () => {
    const root = withBrokenTree([
      {
        file: "src/lib/uploads/scan.ts",
        edit: (source) =>
          source.replace('return requirement === "absent";', "return true;"),
      },
    ]);

    expect(rules(check(root))).toContain("R7");
  });

  it("fails when the verification path manufactures a clean verdict", () => {
    // The fail-open bug in one line: a scanner that timed out stops being
    // distinguishable from one that found nothing.
    const root = withBrokenTree([
      {
        file: "src/lib/uploads/verify.ts",
        edit: (source) =>
          source.replace(
            "const verdict: ScanVerdict = await scanner.scan({",
            'const verdict: ScanVerdict = { status: "clean" };\n  await Promise.resolve({',
          ),
      },
    ]);

    expect(rules(check(root))).toContain("R7");
  });

  it("fails when the verification path picks a scanner of its own", () => {
    const root = withBrokenTree([
      {
        file: "src/lib/uploads/verify.ts",
        edit: (source) =>
          source.replace(
            "const { scanner, fetchImpl } = dependencies;",
            "const { fetchImpl } = dependencies;\n  const scanner = unconfiguredScanner;",
          ),
      },
    ]);

    expect(rules(check(root))).toContain("R7");
  });
});

describe("the gate reads code, not prose", () => {
  it("still fails when the comments explaining a property are intact", () => {
    // Every module here explains at length why SVG is refused and why the length
    // is signed. A gate that matched its own documentation would pass on a file
    // whose prose is intact and whose code is gone — the precise failure it
    // exists to catch.
    const root = withBrokenTree([
      {
        file: "src/lib/s3.ts",
        edit: (source) =>
          source.replace(
            '      "content-length": String(options.contentLength),',
            '      // "content-length": String(options.contentLength),',
          ),
      },
    ]);

    expect(rules(check(root))).toContain("R2");
  });
});

describe("withoutComments", () => {
  it("removes block and line comments and keeps the code", () => {
    expect(
      withoutComments('const a = 1; /* b */\n// c\nconst d = "e";'),
    ).not.toContain("b");
    expect(withoutComments("const a = 1;\n// c\n")).toContain("const a = 1;");
  });

  it("keeps a URL in a string, whose // is not a comment", () => {
    // The `[^:]` guard: stripping `//` after a colon would eat half of every URL
    // in the file and could make a pattern match across what is left.
    expect(withoutComments('const u = "https://example.com/x";')).toContain(
      "https://example.com/x",
    );
  });
});

describe("arrayLiterals", () => {
  it("reads the string members of an as-const array", () => {
    expect(
      arrayLiterals('export const X = [\n  "a",\n  "b",\n] as const;', "X"),
    ).toEqual(["a", "b"]);
  });

  it("returns nothing for a name that is not there", () => {
    expect(arrayLiterals("const Y = [];", "X")).toEqual([]);
  });
});

describe("signatureTypes", () => {
  it("reads every type in the SIGNATURES table of the real sniffer", () => {
    const source = readFileSync(
      path.join(REPO, "src/lib/uploads/sniff.ts"),
      "utf8",
    );

    expect(new Set(signatureTypes(source))).toEqual(
      new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    );
  });
});

describe("interfaceFields", () => {
  it("reads the declared property names", () => {
    expect(
      interfaceFields(
        "export interface P {\n  a: string;\n  b?: number;\n}",
        "P",
      ),
    ).toEqual(["a", "b"]);
  });
});
