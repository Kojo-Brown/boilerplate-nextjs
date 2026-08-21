import { describe, it, expect } from "vitest";
import {
  checkExemptions,
  checkSources,
  collectSources,
} from "./assert-cache-invalidation";

/**
 * The gate is tested against synthetic sources rather than the repository, so
 * the failing cases can be written down as source text instead of being staged
 * on disk. The one case that reads the real tree is at the bottom: a gate that
 * passes on hand-written fixtures and fails on the actual repository would be
 * worse than no gate.
 */
function file(relativePath: string, text: string) {
  return { relativePath, text };
}

const INVALIDATION_MODULE = "src/lib/cache/invalidation.ts";

describe("R1 — a writing action must invalidate", () => {
  it("catches the bug this gate was written for", () => {
    // Verbatim shape of the pre-existing `togglePublishAction`: it wrote the
    // row and called `revalidatePath` on a route whose reads are uncached, so
    // the blog kept serving a list without the post that had just been
    // published. Every unit test passed.
    const findings = checkSources([
      file(
        "src/actions/posts.ts",
        `"use server";
         import { revalidatePath } from "next/cache";
         export async function togglePublishAction(postId: string) {
           const updated = await prisma.post.update({ where: { id: postId }, data: {} });
           revalidatePath("/posts");
           return updated;
         }`,
      ),
    ]);

    expect(findings.map((finding) => finding.rule).sort()).toEqual([
      "R1",
      "R2",
    ]);
    expect(
      findings.find((finding) => finding.rule === "R1")?.message,
    ).toContain("togglePublishAction");
  });

  it("passes an action that reports its mutation", () => {
    expect(
      checkSources([
        file(
          "src/actions/posts.ts",
          `"use server";
           import { invalidate } from "@/lib/cache/invalidation";
           export async function createPostAction(input: unknown) {
             const post = await prisma.post.create({ data: input });
             invalidate({ kind: "post.created", postId: post.id, published: post.published });
             return post;
           }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("ignores an action that only reads", () => {
    expect(
      checkSources([
        file(
          "src/actions/posts.ts",
          `"use server";
           export async function listPostsAction() {
             return prisma.post.findMany();
           }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("finds a write nested inside a branch or a transaction", () => {
    // The walk is over the whole body, not the top-level statements: a write
    // guarded by an `if` is still a write.
    const findings = checkSources([
      file(
        "src/actions/posts.ts",
        `"use server";
         export async function archiveAction(id: string, hard: boolean) {
           if (hard) {
             await prisma.$transaction(async () => {
               await prisma.post.deleteMany({ where: { id } });
             });
           }
         }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R1");
    expect(findings[0]?.message).toContain("archiveAction");
  });

  it("only applies to `use server` modules", () => {
    // A plain module under src/actions/ is not an action surface. The DAL
    // writes constantly and is invalidated by its callers.
    expect(
      checkSources([
        file(
          "src/actions/helpers.ts",
          `export async function bump(id: string) {
             return prisma.post.update({ where: { id }, data: {} });
           }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("refuses to silently skip an export it cannot read", () => {
    // `export const x = async () => {}` is a valid Server Action that this
    // walker has no body for. Passing it would mean the gate reports success
    // over code it never looked at.
    const findings = checkSources([
      file(
        "src/actions/posts.ts",
        `"use server";
         export const publishAction = async (id: string) => {
           await prisma.post.update({ where: { id }, data: { published: true } });
         };`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("publishAction");
  });

  it("does not mistake a type-only export for an unchecked action", () => {
    expect(
      checkSources([
        file(
          "src/actions/blog.ts",
          `"use server";
           export type RevalidateTarget = "/blog";
           export interface Input { id: string }
           export async function noop() {}`,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("R2 — invalidation APIs live in one module", () => {
  it("rejects a direct updateTag import outside the invalidation module", () => {
    const findings = checkSources([
      file(
        "src/actions/blog.ts",
        `"use server";
         import { updateTag } from "next/cache";
         export async function refreshAction() { updateTag("blog:posts"); }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R2");
    expect(findings[0]?.message).toContain("updateTag");
  });

  it("allows the invalidation module itself", () => {
    expect(
      checkSources([
        file(
          INVALIDATION_MODULE,
          `import { refresh, updateTag } from "next/cache";
           export function invalidate() { updateTag("x"); refresh(); }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("allows the read-side cache APIs anywhere", () => {
    // `cacheTag` and `cacheLife` declare a tag on a cached read; they do not
    // drop anything, and they have to live next to the `"use cache"` function.
    expect(
      checkSources([
        file(
          "src/lib/cache/blog.ts",
          `import { cacheLife, cacheTag } from "next/cache";
           export async function read() { cacheTag("blog:posts"); cacheLife("default"); }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("sees through an aliased import", () => {
    const findings = checkSources([
      file(
        "src/actions/blog.ts",
        `"use server";
         import { revalidateTag as drop } from "next/cache";
         export async function refreshAction() { drop("blog:posts", "max"); }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R2");
    expect(findings[0]?.message).toContain("revalidateTag");
  });
});

describe("exemptions", () => {
  it("accepts a writing action that is listed", () => {
    // registerAction is the one real entry; it writes a User row that no
    // cached read can depend on yet.
    expect(
      checkSources([
        file(
          "src/actions/auth.ts",
          `"use server";
           export async function registerAction() {
             await prisma.user.create({ data: {} });
           }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("fails when an exemption's target stops writing", () => {
    // A stale exemption reads as a reviewed decision about code that no longer
    // does what was reviewed.
    const findings = checkExemptions([
      file(
        "src/actions/auth.ts",
        `"use server";
         export async function registerAction() { return null; }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("no longer writes");
  });

  it("fails when an exemption's target disappears", () => {
    const findings = checkExemptions([
      file(
        "src/actions/auth.ts",
        `"use server";\nexport async function other() {}`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("no longer exports");
  });
});

describe("the repository itself", () => {
  it("has no findings", () => {
    const files = collectSources(process.cwd());

    expect(files.length).toBeGreaterThan(0);
    expect([...checkSources(files), ...checkExemptions(files)]).toEqual([]);
  });

  it("excludes test files from the scan", () => {
    // R2 would otherwise fire on every test that imports `updateTag` to assert
    // against its mock.
    const paths = collectSources(process.cwd()).map(
      (file) => file.relativePath,
    );

    expect(paths.some((relative) => relative.endsWith(".test.ts"))).toBe(false);
    expect(paths).toContain(INVALIDATION_MODULE);
  });
});
