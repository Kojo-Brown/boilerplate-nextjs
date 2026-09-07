import { describe, it, expect } from "vitest";
import { checkSources, collectSources } from "./assert-transactional-writes";

/**
 * Written against synthetic sources, with one case at the bottom that reads the
 * real tree — a gate that passes on fixtures and fails on the repository would
 * be worse than no gate.
 */
function file(relativePath: string, text: string) {
  return { relativePath, text };
}

const IMPORT = `import { prisma } from "@/lib/prisma";
import { writeWithOutbox } from "@/lib/outbox/write";`;

describe("T1 — the singleton inside a transaction callback", () => {
  it("catches the bug this gate was written for", () => {
    // Compiles, type checks, and passes every unit test that mocks
    // `@/lib/prisma`, because there the transaction client and the singleton
    // are the same object. In production it runs the insert on a second
    // connection: it commits on its own and survives the rollback meant to undo
    // it, so the post row and its outbox row get exactly the independent
    // lifetimes the transaction was introduced to remove.
    const findings = checkSources([
      file(
        "src/actions/posts.ts",
        `${IMPORT}
         export const createPostAction = writeWithOutbox(async ({ tx, emit }) => {
           const post = await prisma.post.create({ data: {} });
           emit({ type: "post.created", payload: { postId: post.id, published: false } });
           return post;
         });`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("T1");
    expect(findings[0]?.message).toContain("different connection");
  });

  it("passes a callback that writes through its own client", () => {
    expect(
      checkSources([
        file(
          "src/actions/posts.ts",
          `${IMPORT}
           export const createPostAction = writeWithOutbox(async ({ tx, emit }) => {
             const post = await tx.post.create({ data: {} });
             emit({ type: "post.created", payload: { postId: post.id, published: false } });
             return post;
           });`,
        ),
      ]),
    ).toEqual([]);
  });

  it("allows the singleton outside the callback", () => {
    // The conflict re-read in `updatePostAction` is exactly this: it runs after
    // the transaction, on the pooled client, and belongs there.
    expect(
      checkSources([
        file(
          "src/actions/posts.ts",
          `${IMPORT}
           export async function save() {
             const outcome = await writeWithOutbox(async ({ tx, emit }) => {
               await tx.post.update({ where: { id: "1" }, data: {} });
               emit({ type: "post.updated", payload: {} });
             });
             return prisma.post.findUnique({ where: { id: "1" } });
           }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("catches a singleton read, not just a write", () => {
    // A read on another connection inside a transaction is not a rollback
    // hazard, but it does not see the transaction's own uncommitted writes —
    // which makes it a different and subtler wrong answer.
    const findings = checkSources([
      file(
        "src/actions/posts.ts",
        `${IMPORT}
         export const action = writeWithOutbox(async ({ tx, emit }) => {
           const existing = await prisma.post.findUnique({ where: { id: "1" } });
           await tx.post.delete({ where: { id: "1" } });
           emit({ type: "post.deleted", payload: {} });
         });`,
      ),
    ]);

    expect(findings.map((finding) => finding.rule)).toEqual(["T1"]);
  });

  it("ignores a `prisma` that is somebody else's property", () => {
    expect(
      checkSources([
        file(
          "src/actions/posts.ts",
          `${IMPORT}
           export const action = writeWithOutbox(async ({ tx, emit }) => {
             await tx.post.create({ data: { author: context.prisma } });
             emit({ type: "post.created", payload: {} });
           });`,
        ),
      ]),
    ).toEqual([]);
  });

  it("says nothing about a file that never imported the singleton", () => {
    expect(
      checkSources([
        file(
          "src/lib/thing.ts",
          `import { writeWithOutbox } from "@/lib/outbox/write";
           const prisma = makeSomethingElse();
           export const action = writeWithOutbox(async ({ tx, emit }) => {
             await prisma.doThing();
             emit({ type: "post.created", payload: {} });
           });`,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("T2 — the client has to be bound, and bound as `tx`", () => {
  it("fails a callback that renames the client", () => {
    // A rename would put a transaction client behind a name T1 does not
    // recognise and `assert-cache-invalidation.ts` does not count as a write:
    // two gates switched off by an edit that reads as a style preference.
    const findings = checkSources([
      file(
        "src/actions/posts.ts",
        `${IMPORT}
         export const action = writeWithOutbox(async ({ tx: db, emit }) => {
           await db.post.create({ data: {} });
           emit({ type: "post.created", payload: {} });
         });`,
      ),
    ]);

    expect(findings.map((finding) => finding.rule)).toEqual(["T2"]);
  });

  it("fails a callback that takes the whole context", () => {
    const findings = checkSources([
      file(
        "src/actions/posts.ts",
        `${IMPORT}
         export const action = writeWithOutbox(async (context) => {
           await context.tx.post.create({ data: {} });
           context.emit({ type: "post.created", payload: {} });
         });`,
      ),
    ]);

    expect(findings.map((finding) => finding.rule)).toEqual(["T2"]);
  });

  it("fails a callback declared elsewhere, rather than skipping it", () => {
    // "The rule does not apply because the code moved" is the silent pass every
    // gate here is shaped to refuse.
    const findings = checkSources([
      file(
        "src/actions/posts.ts",
        `${IMPORT}
         export const action = writeWithOutbox(handlerDefinedSomewhereElse);`,
      ),
    ]);

    expect(findings.map((finding) => finding.rule)).toEqual(["T2"]);
  });

  it("accepts a callback that binds `tx` and emits", () => {
    expect(
      checkSources([
        file(
          "src/actions/posts.ts",
          `${IMPORT}
           export const action = writeWithOutbox(async ({ tx, emit }) => {
             await tx.post.create({ data: {} });
             emit({ type: "post.created", payload: {} });
           });`,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("T3 — only the outbox module writes outbox rows", () => {
  it("fails an event written outside the mechanism", () => {
    // A row written on its own is a promise of an effect with nothing
    // guaranteeing the write it describes — the failure the outbox exists to
    // remove, arriving through the outbox.
    const findings = checkSources([
      file(
        "src/actions/posts.ts",
        `import { prisma } from "@/lib/prisma";
         export async function action() {
           await prisma.outboxEvent.create({ data: { type: "post.created", payload: {} } });
         }`,
      ),
    ]);

    expect(findings.map((finding) => finding.rule)).toEqual(["T3"]);
  });

  it("allows the outbox module itself", () => {
    expect(
      checkSources([
        file(
          "src/lib/outbox/write.ts",
          `import { prisma } from "@/lib/prisma";
           export async function mark() {
             await prisma.outboxEvent.updateMany({ where: {}, data: {} });
           }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("does not object to reading the table", () => {
    expect(
      checkSources([
        file(
          "src/app/admin/page.tsx",
          `import { prisma } from "@/lib/prisma";
           export default async function Page() {
             const failed = await prisma.outboxEvent.findMany({ where: { status: "FAILED" } });
             return failed.length;
           }`,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("the repository itself", () => {
  it("passes", () => {
    expect(checkSources(collectSources(process.cwd()))).toEqual([]);
  });

  it("is actually reading files", () => {
    const sources = collectSources(process.cwd());

    expect(
      sources.some(
        (source) => source.relativePath === "src/lib/outbox/write.ts",
      ),
    ).toBe(true);
    // Tests are excluded on purpose: they mock `@/lib/prisma`, so a `prisma`
    // reference inside a callback there is a reference to the mock.
    expect(
      sources.some((source) => source.relativePath.endsWith(".test.ts")),
    ).toBe(false);
  });
});
