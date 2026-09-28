/**
 * Holds `docs/owasp-top-10.md` to this tree.
 *
 * ## Why a checklist needs a gate at all
 *
 * A security checklist is the document in a repository most likely to be wrong,
 * and the least likely to be noticed being wrong. It is written once, at the
 * moment somebody is thinking hardest about the subject, and from then on it is
 * prose: it cites a module that gets renamed, a test that gets deleted, a
 * mitigation that gets refactored into something that no longer does the thing.
 * Nothing fails. The document keeps making the same ten claims, and its being
 * checked in is the reason nobody re-derives them.
 *
 * So this gate does two jobs, and they are different jobs.
 *
 * ## C — the checklist is bound to the tree
 *
 *   C1  All ten 2021 categories are present, in order, under their canonical
 *       names. A checklist missing A08 is not a checklist with nine rows; it is
 *       a checklist whose ninth row nobody can tell was ever there.
 *   C2  Every category carries at least one mitigation, and every mitigation
 *       carries at least one test — which is the spec item's own wording ("a
 *       test per mitigation") made mechanical. A category with nothing to claim
 *       says so with a `**Gap**` bullet instead.
 *   C3  Every source path a mitigation cites exists. This is the rule that
 *       catches a rename, which is the most common way one of these documents
 *       goes stale.
 *   C4  Every test a mitigation cites exists: the file exists, Vitest collects
 *       it, and the quoted title appears in it. A citation of a test that was
 *       deleted is worse than no citation, because it reads as evidence.
 *   C5  Every `**Gap**` bullet names an open item in `SPEC.md`. An
 *       acknowledged gap with nothing tracking it is a gap that stays open, and
 *       tying it to the spec line means closing that item forces this document
 *       to be revisited — the gate fails the moment the item is ticked.
 *   C6  No test is cited by more than one mitigation. Two rows resting on one
 *       assertion is two rows' worth of confidence from one test's worth of
 *       evidence, and it is how a checklist looks complete while a whole
 *       category rides on somebody else's test.
 *
 * ## T — the claims no unit test can make
 *
 * Four rows of that document assert something about the *whole tree* rather than
 * about a module: that there is no raw SQL, that nothing fetches a URL a caller
 * chose, that the image optimiser's allowlist is an allowlist, that CI installs
 * cannot drift from the lockfile. A unit test cannot assert an absence across a
 * repository; it can only assert that the module in front of it behaves. These
 * are those absences.
 *
 *   T1  No raw SQL anywhere in `src/` or `prisma/`. Prisma's query builder
 *       parameterises everything, so A03's strongest claim here is that nothing
 *       opts out of it — and the way that claim stops being true is one
 *       `$queryRawUnsafe` in a file nobody re-reads.
 *   T2  Every outbound `fetch` in the server graph is at an enumerated call
 *       site. Not "no SSRF", which is not checkable, but the property that makes
 *       SSRF reviewable: the set of places this application can be made to
 *       issue a request is small, listed, and each entry says why its target
 *       cannot be chosen by a caller. A new call site fails this gate and has to
 *       be argued for in the list.
 *   T3  Every `images.remotePatterns` entry in `next.config.ts` is an https
 *       allowlist entry with a real hostname. `/_next/image?url=…` is a fetch
 *       this application performs on a caller's instruction, so the pattern list
 *       is the SSRF boundary; a `hostname: "**"` there turns the optimiser into
 *       an open proxy.
 *   T4  Every `pnpm install` in `.github/workflows/` is `--frozen-lockfile`,
 *       `packageManager` is pinned exactly, `.github/dependabot.yml` covers both
 *       ecosystems, and no workflow pins an action to a moving branch. A06 and
 *       A08 have no runtime code to test; this is what they have instead.
 *
 * Static analysis and a file read, so it needs no build output.
 *
 * Usage: tsx scripts/assert-owasp-checklist.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { collectSources } from "./assert-react-compiler";
import { withoutComments } from "./assert-csp";

export interface Finding {
  rule: string;
  file: string;
  message: string;
}

export const CHECKLIST_FILE = "docs/owasp-top-10.md";
export const SPEC_FILE = "SPEC.md";
export const DEPENDABOT_FILE = ".github/dependabot.yml";
export const NEXT_CONFIG_FILE = "next.config.ts";
export const PACKAGE_FILE = "package.json";
export const WORKFLOW_DIR = ".github/workflows";

/**
 * The ten categories, in the order OWASP publishes them.
 *
 * The 2021 list rather than a paraphrase, and the full name rather than the code
 * alone: "A04" tells a reader nothing, and a checklist whose headings have
 * drifted into somebody's own words is a checklist that cannot be compared with
 * the source it claims to cover.
 */
export const CATEGORIES: readonly string[] = [
  "A01:2021 — Broken Access Control",
  "A02:2021 — Cryptographic Failures",
  "A03:2021 — Injection",
  "A04:2021 — Insecure Design",
  "A05:2021 — Security Misconfiguration",
  "A06:2021 — Vulnerable and Outdated Components",
  "A07:2021 — Identification and Authentication Failures",
  "A08:2021 — Software and Data Integrity Failures",
  "A09:2021 — Security Logging and Monitoring Failures",
  "A10:2021 — Server-Side Request Forgery",
];

/**
 * Where this application is allowed to call `fetch`, and why each one is safe.
 *
 * The `why` is not decoration: it is the thing a reviewer reads when the list
 * grows. An entry whose reason is "it fetches a URL from the request" is a
 * finding that this gate cannot make for you, so the list is deliberately short
 * enough that a person can read all of it.
 */
export const FETCH_CALL_SITES: readonly { file: string; why: string }[] = [
  {
    file: "src/lib/vitals/sink.ts",
    why:
      "the only outbound request this application makes from a server. Its " +
      "target is `serverEnv.VITALS_COLLECTOR_URL`, validated as a URL by the " +
      "env schema at boot and reachable from no request",
  },
  {
    file: "src/lib/vitals/queue.ts",
    why:
      "a browser beacon to `VITALS_ENDPOINT`, a literal same-origin path; the " +
      "`fetch` here is the `sendBeacon` fallback",
  },
  {
    file: "src/hooks/use-posts.ts",
    why: "a literal same-origin path, in a browser, from a client component",
  },
  {
    file: "src/hooks/use-paginated-posts.ts",
    why:
      "a literal same-origin path with the pagination cursor in the query " +
      "string; the path itself is not interpolated",
  },
  {
    file: "src/lib/dal/batch.ts",
    why:
      "not the platform API: `options.fetch` is the caller-supplied batch " +
      "loader a DataLoader takes, and it issues no request of its own",
  },
  {
    file: "src/lib/uploads/storage.ts",
    why:
      "reads back, promotes and deletes an uploaded object. Every request goes " +
      "to a URL this module presigns itself, whose host comes from " +
      "`S3_BUCKET_NAME` and `AWS_REGION` — there is no place in it for a " +
      "caller-supplied hostname. The key is checked by `parseObjectKey` and " +
      "its user segment compared with the session's own id before any of these " +
      "run, so a caller cannot aim the readback at another user's object " +
      "either. The readback is bounded to a 512-byte range",
  },
  {
    file: "src/lib/uploads/scan.ts",
    why:
      "posts an uploaded object's bucket and key to the malware scanner. Its " +
      "target is `serverEnv.UPLOAD_SCANNER_URL`, validated as a URL by the env " +
      "schema at boot and reachable from no request; the body carries no URL " +
      "at all, so the scanner cannot be aimed either",
  },
  {
    file: "src/lib/uploads/verify.ts",
    why:
      "issues no request of its own: `fetchImpl` is threaded through to " +
      "`@/lib/uploads/storage` and to the scanner so a test can substitute " +
      "one, which is the same `typeof fetch` alias shape the vitals sink uses",
  },
  {
    file: "src/actions/upload.ts",
    why:
      "issues no request of its own: it passes the platform `fetch` to " +
      "`verifyUploadedObject` as the dependency that module declares, rather " +
      "than letting it default to one — a defaulted dependency is one a test " +
      "can forget to stub and reach the network with",
  },
];

/**
 * Prisma's escape hatches.
 *
 * One pattern rather than four names, because `$queryRawUnsafe` contains
 * `$queryRaw`: a list of substrings reports the same call twice and makes the
 * finding count a lie.
 */
const RAW_SQL = /\$(?:query|execute)Raw(?:Unsafe)?\b/g;

/**
 * Prisma's builder has no `SET`, which is the whole reason this list exists.
 *
 * T1's original claim was absolute: no raw SQL anywhere. That was true, and it
 * stopped being true for a reason the rule's own message anticipated — a raw
 * query that is "genuinely needed" and "behind a reviewed module". Row-level
 * security is scoped by `set_config('app.tenant_id', …, TRUE)`, and there is
 * no Prisma API that emits it: the builder models rows, not session state. So
 * the rule becomes an allowlist, shaped exactly like `FETCH_CALL_SITES`,
 * rather than a claim nobody can keep.
 *
 * What the `why` has to establish is the property A03 actually cares about,
 * which is not "no raw SQL" but "no SQL assembled from a value". Every entry
 * below uses a tagged template, so every interpolation is a bind parameter —
 * and `$queryRawUnsafe`/`$executeRawUnsafe`, which are the string-concatenation
 * forms, are matched by the same pattern and are in no entry's reason. A file
 * added here that uses one is a finding this gate cannot make for you.
 */
export const RAW_SQL_CALL_SITES: readonly { file: string; why: string }[] = [
  {
    file: "src/lib/tenancy/client.ts",
    why:
      "`SELECT set_config(<name>, <value>, TRUE)`, the statement that opens a " +
      "tenant scope. The setting names are module constants and the values " +
      "are bind parameters in a tagged template; Prisma's builder has no way " +
      "to express a session setting at all",
  },
  {
    file: "src/lib/tenancy/enforcement.ts",
    why:
      "`SELECT reason FROM app.rls_bypass_reasons()`, a constant query with " +
      "no parameters. It asks the database whether its own policies bind this " +
      "connection, which is a question about the catalogue rather than about " +
      "rows, so there is nothing for the builder to model",
  },
];

interface TestCitation {
  file: string;
  title: string;
}

interface Mitigation {
  /** The bullet's own text, for error messages. */
  summary: string;
  /** Backticked paths in the bullet. */
  sources: string[];
  tests: TestCitation[];
}

interface Category {
  name: string;
  mitigations: Mitigation[];
  /** `SPEC.md` items named by `**Gap**` bullets in this category. */
  gaps: string[];
  /** A `**Gap**` bullet that named no spec item at all. */
  malformedGaps: string[];
}

function read(root: string, relativePath: string): string | undefined {
  const absolute = path.join(root, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}

/** Every `` `…` `` span in a line. */
function backticked(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
}

/**
 * Parses the checklist into categories.
 *
 * Exported because the parser is the part of this gate most worth testing
 * directly: every rule below is an assertion about its output, so a parser that
 * silently found nothing would make every rule pass.
 */
export function parseChecklist(markdown: string): Category[] {
  const categories: Category[] = [];
  let current: Category | undefined;
  let currentMitigation: Mitigation | undefined;

  for (const raw of markdown.split("\n")) {
    const heading = /^###\s+(A\d{2}:2021\s+—\s+.+?)\s*$/.exec(raw);
    if (heading) {
      current = {
        name: heading[1] as string,
        mitigations: [],
        gaps: [],
        malformedGaps: [],
      };
      currentMitigation = undefined;
      categories.push(current);
      continue;
    }

    // Any other heading closes the category. Without this a `## Deferred`
    // section's bullets would be read as the last category's.
    if (/^#{1,3}\s/.test(raw)) {
      current = undefined;
      currentMitigation = undefined;
      continue;
    }

    if (current === undefined) continue;

    if (/^-\s+\*\*Mitigation\*\*/.test(raw)) {
      currentMitigation = {
        summary: raw.trim(),
        sources: backticked(raw),
        tests: [],
      };
      current.mitigations.push(currentMitigation);
      continue;
    }

    if (/^-\s+\*\*Gap\*\*/.test(raw)) {
      currentMitigation = undefined;
      // `SPEC:` then the item verbatim to the end of the line. Not wrapped in
      // backticks, because a spec item may contain them — `i18n with
      // \`next-intl\`: …` is one — and a nested-backtick grammar would read that
      // item as three characters.
      const spec = /SPEC:\s*(\S.*?)\s*$/.exec(raw);
      if (spec) current.gaps.push(spec[1] as string);
      else current.malformedGaps.push(raw.trim());
      continue;
    }

    const test = /^\s{2,}-\s+\*\*Test\*\*\s+`([^`]+)`\s+›\s+"(.+?)"\s*$/.exec(
      raw,
    );
    if (test && currentMitigation) {
      currentMitigation.tests.push({
        file: test[1] as string,
        title: test[2] as string,
      });
    }
  }

  return categories;
}

/** Whether Vitest's `node`/`dom` projects collect this path. */
export function isCollectedByVitest(relativePath: string): boolean {
  if (!/\.test\.tsx?$/.test(relativePath)) return false;
  return (
    relativePath.startsWith("src/") ||
    relativePath.startsWith("scripts/") ||
    relativePath.startsWith("eslint-rules/")
  );
}

/**
 * Whether `title` is declared as a test in `source`.
 *
 * Looks for the title as a string literal preceded by a test-declaring call,
 * which is what makes the check answer "is there a test called this" rather than
 * "does this sentence appear in the file". A title only mentioned in a comment
 * does not count — that is exactly the drift this rule is for. `it.each` titles
 * carry printf placeholders, so a citation may name the template.
 */
export function declaresTest(source: string, title: string): boolean {
  const code = withoutComments(source);
  // The quote and the title, with the title's regex-significant characters
  // escaped; `\s*` after the opener covers a Prettier-wrapped call.
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b(?:it|test|describe)(?:\\.\\w+)*\\s*\\(\\s*(?:\\[[\\s\\S]*?\\]\\s*\\)\\s*\\(\\s*)?["'\`]${escaped}["'\`]`,
  );
  return pattern.test(code);
}

/* -------------------------------------------------------------------------- */
/* C — the checklist is bound to the tree                                      */
/* -------------------------------------------------------------------------- */

function checkChecklist(root: string, findings: Finding[]): void {
  const markdown = read(root, CHECKLIST_FILE);
  if (markdown === undefined) {
    findings.push({
      rule: "C1",
      file: CHECKLIST_FILE,
      message:
        "does not exist. Every rule in this gate is an assertion about it, so " +
        "its absence is the one failure that cannot be reported as nine others.",
    });
    return;
  }

  const categories = parseChecklist(markdown);
  const names = categories.map((category) => category.name);

  // C1 — all ten, in order.
  for (const [index, expected] of CATEGORIES.entries()) {
    if (names[index] === expected) continue;

    findings.push({
      rule: "C1",
      file: CHECKLIST_FILE,
      message:
        `expects \`### ${expected}\` as category ${index + 1}, and has ` +
        `${names[index] === undefined ? "nothing" : `\`${names[index]}\``}. ` +
        "The headings are the 2021 list verbatim so the document can be " +
        "compared with the source it claims to cover.",
    });
  }

  const specText = read(root, SPEC_FILE) ?? "";
  const seenTests = new Map<string, string>();

  for (const category of categories) {
    // C2 — something claimed, and every claim evidenced.
    if (category.mitigations.length === 0 && category.gaps.length === 0) {
      findings.push({
        rule: "C2",
        file: CHECKLIST_FILE,
        message:
          `${category.name} carries neither a \`**Mitigation**\` nor a ` +
          "`**Gap**` bullet. A category with nothing to claim has to say so.",
      });
    }

    for (const mitigation of category.mitigations) {
      if (mitigation.tests.length === 0) {
        findings.push({
          rule: "C2",
          file: CHECKLIST_FILE,
          message:
            `${category.name}: ${mitigation.summary.slice(0, 90)} cites no ` +
            "test. A mitigation nothing asserts is a claim, not a mitigation.",
        });
      }

      // C3 — cited sources exist.
      for (const source of mitigation.sources) {
        if (!looksLikePath(source)) continue;
        if (existsSync(path.join(root, source))) continue;

        findings.push({
          rule: "C3",
          file: CHECKLIST_FILE,
          message:
            `${category.name} cites \`${source}\`, which does not exist. ` +
            "A rename is the usual way one of these documents stops being true.",
        });
      }

      // C4 — cited tests exist, are collected, and declare the title.
      for (const test of mitigation.tests) {
        const source = read(root, test.file);

        if (source === undefined) {
          findings.push({
            rule: "C4",
            file: CHECKLIST_FILE,
            message:
              `${category.name} cites a test in \`${test.file}\`, which does ` +
              "not exist.",
          });
          continue;
        }

        if (!isCollectedByVitest(test.file)) {
          findings.push({
            rule: "C4",
            file: CHECKLIST_FILE,
            message:
              `${category.name} cites \`${test.file}\`, which Vitest does not ` +
              "collect, so the citation is to something that never runs.",
          });
        }

        if (!declaresTest(source, test.title)) {
          findings.push({
            rule: "C4",
            file: CHECKLIST_FILE,
            message:
              `${category.name} cites "${test.title}" in \`${test.file}\`, ` +
              "which declares no test by that name. A citation to a deleted " +
              "test reads as evidence and is not any.",
          });
        }

        // C6 — one test, one row.
        const key = `${test.file} › ${test.title}`;
        const already = seenTests.get(key);
        if (already !== undefined && already !== category.name) {
          findings.push({
            rule: "C6",
            file: CHECKLIST_FILE,
            message:
              `${category.name} and ${already} both rest on ${key}. Two rows ` +
              "on one assertion is one test's evidence counted twice.",
          });
        }
        seenTests.set(key, category.name);
      }
    }

    // C5 — gaps track an open spec item.
    for (const malformed of category.malformedGaps) {
      findings.push({
        rule: "C5",
        file: CHECKLIST_FILE,
        message:
          `${category.name} has a \`**Gap**\` bullet with no ` +
          "``SPEC: `…` `` reference: " +
          `${malformed.slice(0, 90)}. An untracked gap is one that stays open.`,
      });
    }

    for (const item of category.gaps) {
      if (specText.includes(`- [ ] ${item}`)) continue;

      findings.push({
        rule: "C5",
        file: CHECKLIST_FILE,
        message:
          `${category.name} defers to SPEC item \`${item}\`, which is not an ` +
          `open \`- [ ]\` line in ${SPEC_FILE}. Either it is done — in which ` +
          "case this row is out of date, which is the point of the rule — or " +
          "the wording has drifted.",
      });
    }
  }
}

/**
 * Whether a backticked span is a repository path rather than an identifier.
 *
 * A mitigation's prose is full of backticks — `process.env`, `auth.session`,
 * `serverEnv.VITALS_COLLECTOR_URL` — and C3 has to leave those alone or it
 * reports every one of them as a missing file. So the test is a recognised
 * source extension, or a trailing slash for a directory: the two shapes a
 * citation of something in this tree actually takes.
 */
export function looksLikePath(span: string): boolean {
  if (span.includes(" ")) return false;
  if (span.endsWith("/")) return /^[\w.@-]+(?:\/[\w.@-]+)*\/$/.test(span);
  return /\.(?:tsx?|mjs|md|json|ya?ml|css)$/.test(span);
}

/* -------------------------------------------------------------------------- */
/* T — the claims no unit test can make                                        */
/* -------------------------------------------------------------------------- */

/** T1 — nothing opts out of Prisma's parameterisation. */
export function rawSqlUses(root: string): Finding[] {
  const findings: Finding[] = [];
  const files = [...collectSources(root), ...prismaSources(root)];
  const allowed = new Set(RAW_SQL_CALL_SITES.map((entry) => entry.file));
  const found = new Set<string>();

  for (const file of files) {
    const code = withoutComments(file.text);
    const methods = [...new Set(code.match(RAW_SQL) ?? [])];
    if (methods.length === 0) continue;

    found.add(file.relativePath);
    if (allowed.has(file.relativePath)) continue;

    findings.push({
      rule: "T1",
      file: file.relativePath,
      message:
        `calls \`${methods.join("`, `")}\`. Every query in this application goes through ` +
        "Prisma's builder, which parameterises; that is A03's whole claim " +
        "here, and one raw call is the way it stops being true. If a raw " +
        "query is genuinely needed, it belongs behind a reviewed module, in " +
        `\`RAW_SQL_CALL_SITES\` with the reason it is safe, and in ${CHECKLIST_FILE}'s ` +
        "A03 row — not in a route handler.",
    });
  }

  for (const entry of RAW_SQL_CALL_SITES) {
    if (found.has(entry.file)) continue;

    findings.push({
      rule: "T1",
      file: entry.file,
      message:
        "is listed in `RAW_SQL_CALL_SITES` and no longer issues a raw query. " +
        "A stale allowlist entry is a hole waiting for a file of that name.",
    });
  }

  return findings;
}

function prismaSources(root: string): { relativePath: string; text: string }[] {
  const seed = path.join(root, "prisma", "seed.ts");
  if (!existsSync(seed)) return [];
  return [{ relativePath: "prisma/seed.ts", text: readFileSync(seed, "utf8") }];
}

/**
 * Whether a module deals with the platform `fetch` at all.
 *
 * Two shapes, because aliasing it is as much of a call site as calling it:
 * `src/lib/vitals/sink.ts` takes `fetchImpl: typeof fetch = fetch` and calls the
 * alias, so a rule that only looked for `fetch(` would miss the one outbound
 * request this application actually makes from a server. The negative lookbehind
 * is what keeps `prefetch`, `refetch` and `fetchPriority` out.
 */
export function referencesFetch(code: string): boolean {
  const source = withoutStringBodies(code);
  // `(?!\s*:)` drops a property *key* named `fetch` — `@/lib/dal/loaders.ts`
  // supplies one to the batch loader — while keeping `typeof fetch` and a
  // `fetchImpl = fetch` default, which are the alias shapes that matter.
  return (
    /(?<![.\w$])fetch\b(?!\s*:)/.test(source) || /\.fetch\s*\(/.test(source)
  );
}

/**
 * Blanks the *inside* of every string and template literal.
 *
 * `withoutComments` keeps string bodies, and one of this repository's route
 * descriptions is a paragraph of prose containing the word "fetch"
 * (`src/lib/api/runtimes.ts`). A rule that reads that as a call site is a rule
 * that fires on documentation.
 */
export function withoutStringBodies(code: string): string {
  return code
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/** T2 — the outbound call sites are exactly the enumerated ones. */
export function fetchCallSites(root: string): Finding[] {
  const findings: Finding[] = [];
  const allowed = new Set(FETCH_CALL_SITES.map((entry) => entry.file));
  const found = new Set<string>();

  for (const file of collectSources(root)) {
    const code = withoutComments(file.text);
    if (!referencesFetch(code)) continue;
    found.add(file.relativePath);

    if (allowed.has(file.relativePath)) continue;

    findings.push({
      rule: "T2",
      file: file.relativePath,
      message:
        "calls `fetch` and is not in `FETCH_CALL_SITES`. The list is what " +
        "makes A10 reviewable: it is short enough to read, and every entry " +
        "records why its target cannot be chosen by a caller. Add this one " +
        "with that reason — and if the reason is that the URL comes from the " +
        "request, this is the finding the gate exists for.",
    });
  }

  for (const entry of FETCH_CALL_SITES) {
    if (found.has(entry.file)) continue;

    findings.push({
      rule: "T2",
      file: entry.file,
      message:
        "is listed in `FETCH_CALL_SITES` and no longer calls `fetch`. A stale " +
        "allowlist entry is a hole waiting for a file of that name.",
    });
  }

  return findings;
}

/** T3 — the image optimiser's pattern list is an allowlist. */
export function remotePatterns(root: string): Finding[] {
  const source = read(root, NEXT_CONFIG_FILE);
  if (source === undefined) {
    return [
      {
        rule: "T3",
        file: NEXT_CONFIG_FILE,
        message: "does not exist, so the image allowlist cannot be read.",
      },
    ];
  }

  const code = withoutComments(source);
  const block = /remotePatterns\s*:\s*\[([\s\S]*?)\n\s*\]/.exec(code);
  if (block === null) {
    // No remote patterns at all is the safe state: `next/image` then refuses
    // every off-origin source. Nothing to check.
    return /remotePatterns/.test(code)
      ? [
          {
            rule: "T3",
            file: NEXT_CONFIG_FILE,
            message:
              "declares `remotePatterns` in a shape this gate cannot read. It " +
              "has to stay an inline array literal, because that is what makes " +
              "the SSRF boundary of `/_next/image` readable without running a " +
              "build.",
          },
        ]
      : [];
  }

  const findings: Finding[] = [];
  const entries = (block[1] as string)
    .split(/\}\s*,?/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("hostname"));

  if (entries.length === 0) {
    findings.push({
      rule: "T3",
      file: NEXT_CONFIG_FILE,
      message:
        "has a `remotePatterns` array whose entries declare no `hostname`. An " +
        "entry with no host matches every host, which turns " +
        "`/_next/image?url=…` into an open proxy.",
    });
  }

  for (const entry of entries) {
    const hostname = /hostname\s*:\s*["'`]([^"'`]*)["'`]/.exec(entry)?.[1];
    const protocol = /protocol\s*:\s*["'`]([^"'`]*)["'`]/.exec(entry)?.[1];

    if (protocol !== "https") {
      findings.push({
        rule: "T3",
        file: NEXT_CONFIG_FILE,
        message:
          `has a remote pattern for \`${hostname ?? "(no hostname)"}\` whose ` +
          `protocol is \`${protocol ?? "unset"}\`. Unset matches http too, and ` +
          "the optimiser's fetch is one this server makes on a caller's " +
          "instruction.",
      });
    }

    if (hostname === undefined || hostname === "" || /^\*+$/.test(hostname)) {
      findings.push({
        rule: "T3",
        file: NEXT_CONFIG_FILE,
        message:
          `has a remote pattern whose hostname is \`${hostname ?? "unset"}\`, ` +
          "which is every host. A wildcard is only an allowlist entry when it " +
          "is anchored to a domain (`**.example.com`).",
      });
    }
  }

  return findings;
}

/** T4 — the supply chain: frozen installs, pinned tooling, tracked updates. */
export function supplyChain(root: string): Finding[] {
  const findings: Finding[] = [];

  const packageJson = read(root, PACKAGE_FILE);
  if (packageJson !== undefined) {
    const manager = /"packageManager"\s*:\s*"([^"]+)"/.exec(packageJson)?.[1];
    if (manager === undefined || !/^pnpm@\d+\.\d+\.\d+/.test(manager)) {
      findings.push({
        rule: "T4",
        file: PACKAGE_FILE,
        message:
          `declares \`packageManager\` as \`${manager ?? "nothing"}\`. An ` +
          "exact `pnpm@x.y.z` is what stops the tool that resolves every " +
          "dependency from being resolved itself at install time.",
      });
    }
  }

  const dependabot = read(root, DEPENDABOT_FILE);
  if (dependabot === undefined) {
    findings.push({
      rule: "T4",
      file: DEPENDABOT_FILE,
      message:
        "does not exist. A06 has no runtime code to test: the mitigation is " +
        "that somebody is told when a pinned version becomes a known " +
        "vulnerability, and this file is who tells them.",
    });
  } else {
    for (const ecosystem of ["npm", "github-actions"]) {
      if (
        new RegExp(`package-ecosystem:\\s*["']?${ecosystem}`).test(dependabot)
      )
        continue;

      findings.push({
        rule: "T4",
        file: DEPENDABOT_FILE,
        message:
          `does not cover the \`${ecosystem}\` ecosystem. ` +
          (ecosystem === "npm"
            ? "That is the application's own dependency tree."
            : "Workflow actions run with this repository's secrets, and a " +
              "moving tag is a dependency that changes with no commit here."),
      });
    }
  }

  for (const workflow of workflowFiles(root)) {
    for (const [index, line] of workflow.text.split("\n").entries()) {
      const where = `${workflow.relativePath}:${index + 1}`;

      // A comment mentioning `pnpm install` is not an install step, and this
      // workflow has one explaining why `--throw-deprecation` is absent from
      // the real one.
      if (/^\s*#/.test(line)) continue;

      if (/pnpm\s+install/.test(line) && !/--frozen-lockfile/.test(line)) {
        findings.push({
          rule: "T4",
          file: where,
          message:
            "installs without `--frozen-lockfile`, which lets CI resolve a " +
            "dependency tree no commit in this repository describes. The " +
            "lockfile is the only record of what was reviewed.",
        });
      }

      const uses = /^\s*-?\s*uses:\s*([^\s#]+)/.exec(line);
      if (uses) {
        const reference = (uses[1] as string).split("@")[1];
        if (
          reference === undefined ||
          ["main", "master", "latest", "develop"].includes(reference)
        ) {
          findings.push({
            rule: "T4",
            file: where,
            message:
              `pins \`${uses[1]}\` to \`${reference ?? "nothing"}\`, which is ` +
              "a moving branch. An action is code that runs with this " +
              "repository's token; a branch means its contents can change " +
              "without a commit here.",
          });
        }
      }
    }
  }

  return findings;
}

function workflowFiles(root: string): { relativePath: string; text: string }[] {
  const directory = path.join(root, WORKFLOW_DIR);
  if (!existsSync(directory)) return [];

  // Flat by GitHub's own rules, so there is nothing to recurse.
  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({
      relativePath: `${WORKFLOW_DIR}/${name}`,
      text: readFileSync(path.join(directory, name), "utf8"),
    }));
}

export function check(root: string): Finding[] {
  const findings: Finding[] = [];
  checkChecklist(root, findings);
  findings.push(...rawSqlUses(root));
  findings.push(...fetchCallSites(root));
  findings.push(...remotePatterns(root));
  findings.push(...supplyChain(root));
  return findings;
}

export function main(root: string): number {
  const findings = check(root);

  if (findings.length > 0) {
    console.error("OWASP checklist gate failed:\n");
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(`\n${findings.length} finding(s).`);
    return 1;
  }

  console.log(
    `OWASP checklist OK — ${CATEGORIES.length} categories present and in ` +
      "order, every mitigation cited by a test that exists and runs, every " +
      "gap tracking an open spec item, no raw SQL, no unlisted outbound " +
      "fetch, an https image allowlist, and a frozen supply chain.",
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
