import { describe, it, expect } from "vitest";
import { checkSources, collectSources } from "./assert-no-n-plus-one";

/**
 * Written against synthetic sources, with one case at the bottom that reads the
 * real tree — a gate that passes on fixtures and fails on the repository would
 * be worse than no gate.
 */
function file(relativePath: string, text: string) {
  return { relativePath, text };
}

const PRISMA_IMPORT = `import { prisma } from "@/lib/prisma";`;
const MEMO_IMPORT = `import { requestMemo } from "@/lib/request-memo";`;

describe("N1 — Prisma in the render path", () => {
  it("catches the read this gate was written for", () => {
    // Exactly what `@stats` did. Correct, indexed, fast, and invisible to
    // `@notifications`, which counted the same author's posts in the same
    // render because it had no way to know this had happened.
    const findings = checkSources([
      file(
        "src/app/(dashboard)/dashboard/_components/dashboard-stats.tsx",
        `${PRISMA_IMPORT}
         export async function DashboardStats({ userId }: { userId: string }) {
           const count = await prisma.post.count({ where: { authorId: userId } });
           return <p>{count}</p>;
         }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("N1");
    expect(findings[0]?.message).toContain("five statements");
  });

  it("catches a write as well as a read", () => {
    // The rule is about where data access lives, not about which direction it
    // goes. A gate that let `prisma.post.update()` through would be silent on
    // the worse version of the same mistake.
    const findings = checkSources([
      file(
        "src/app/(dashboard)/posts/_components/thing.tsx",
        `${PRISMA_IMPORT}
         export async function Thing() {
           await prisma.post.update({ where: { id: "x" }, data: {} });
         }`,
      ),
    ]);

    expect(findings.map((f) => f.rule)).toEqual(["N1"]);
  });

  it("passes a component that reads through the data layer", () => {
    expect(
      checkSources([
        file(
          "src/app/(dashboard)/dashboard/_components/dashboard-stats.tsx",
          `import { getPostCountsByAuthor } from "@/lib/dal/posts";
           export async function DashboardStats({ userId }: { userId: string }) {
             const counts = await getPostCountsByAuthor(userId);
             return <p>{counts.total}</p>;
           }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("ignores a local identifier named prisma in a file that never imported it", () => {
    expect(
      checkSources([
        file(
          "src/components/thing.tsx",
          `export function Thing({ prisma }: { prisma: { post: { count(): number } } }) {
             return <p>{prisma.post.count()}</p>;
           }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("says nothing about Prisma outside the render path", () => {
    // Server Actions and infrastructure legitimately talk to the database.
    // This rule is about reads a component cannot share, not about all of them.
    expect(
      checkSources([
        file(
          "src/actions/auth.ts",
          `${PRISMA_IMPORT}
           export async function register(email: string) {
             return prisma.user.findUnique({ where: { email } });
           }`,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("N2 — unmemoised data-layer reads", () => {
  it("catches an exported read that is not memoised", () => {
    const findings = checkSources([
      file(
        "src/lib/dal/posts.ts",
        `${PRISMA_IMPORT}
         export async function getPostsByUser(userId: string) {
           return prisma.post.findMany({ where: { authorId: userId } });
         }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("N2");
    expect(findings[0]?.message).toContain("two statements");
  });

  it("passes the memoised form", () => {
    expect(
      checkSources([
        file(
          "src/lib/dal/posts.ts",
          `${PRISMA_IMPORT}
           ${MEMO_IMPORT}
           export const getPostsByUser = requestMemo(async (userId: string) =>
             prisma.post.findMany({ where: { authorId: userId } }),
           );`,
        ),
      ]),
    ).toEqual([]);
  });

  it("honours the exempt list", () => {
    expect(
      checkSources([
        file(
          "src/lib/dal/posts.ts",
          `${PRISMA_IMPORT}
           export async function getPaginatedPostsByUser(userId: string, params: unknown) {
             return prisma.post.findMany({ where: { authorId: userId } });
           }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("says nothing about a helper that issues no query", () => {
    expect(
      checkSources([
        file(
          "src/lib/dal/posts.ts",
          `export function postPath(id: string) { return "/posts/" + id; }`,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("N3 — a query per row", () => {
  it("catches a list that maps rows onto a data-layer read", () => {
    // The classic one. It renders correctly and issues one statement per row.
    const findings = checkSources([
      file(
        "src/app/blog/page.tsx",
        `import { getUserById } from "@/lib/dal/users";
         export async function Authors({ posts }: { posts: { authorId: string }[] }) {
           const authors = await Promise.all(
             posts.map(async (post) => getUserById(post.authorId)),
           );
           return <p>{authors.length}</p>;
         }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("N3");
    expect(findings[0]?.message).toContain("one statement per row");
  });

  it("passes the batched form", () => {
    expect(
      checkSources([
        file(
          "src/app/blog/page.tsx",
          `import { loadUsers } from "@/lib/dal/loaders";
           export async function Authors({ posts }: { posts: { authorId: string }[] }) {
             const authors = await loadUsers(posts.map((post) => post.authorId));
             return <p>{authors.length}</p>;
           }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("says nothing about a synchronous map", () => {
    expect(
      checkSources([
        file(
          "src/app/blog/page.tsx",
          `import { getUserById } from "@/lib/dal/users";
           export function Titles({ posts }: { posts: { title: string }[] }) {
             return <ul>{posts.map((post) => <li>{post.title}</li>)}</ul>;
           }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("says nothing about an async map over something that is not a read", () => {
    expect(
      checkSources([
        file(
          "src/app/blog/page.tsx",
          `export async function Slugs({ posts }: { posts: { title: string }[] }) {
             return Promise.all(posts.map(async (post) => post.title.toLowerCase()));
           }`,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("N4 — memo keys that can never match", () => {
  it("catches an object parameter on a memoised read", () => {
    // The failure mode that looks exactly like the fix: wrapped in
    // `requestMemo`, and memoising nothing, because every call site builds a
    // new object and React compares arguments by identity.
    const findings = checkSources([
      file(
        "src/lib/dal/posts.ts",
        `${PRISMA_IMPORT}
         ${MEMO_IMPORT}
         export const findPosts = requestMemo(async (filter: { userId: string }) =>
           prisma.post.findMany({ where: { authorId: filter.userId } }),
         );`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("N4");
    expect(findings[0]?.message).toContain("SameValueZero");
  });

  it("catches a parameter with no type annotation, which it cannot vouch for", () => {
    const findings = checkSources([
      file(
        "src/lib/dal/posts.ts",
        `${PRISMA_IMPORT}
         ${MEMO_IMPORT}
         export const findPosts = requestMemo(async (userId) =>
           prisma.post.findMany({ where: { authorId: userId } }),
         );`,
      ),
    ]);

    expect(findings.map((f) => f.rule)).toEqual(["N4"]);
  });

  it("accepts primitives and unions of literals", () => {
    expect(
      checkSources([
        file(
          "src/lib/dal/posts.ts",
          `${PRISMA_IMPORT}
           ${MEMO_IMPORT}
           export const findPosts = requestMemo(
             async (userId: string, limit: number, role: "USER" | "ADMIN") =>
               prisma.post.findMany({ where: { authorId: userId }, take: limit }),
           );`,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("N5 — opting out of memoisation", () => {
  it("catches an uncommented `.uncached` call", () => {
    const findings = checkSources([
      file(
        "src/actions/posts.ts",
        `import { getEditablePost } from "@/lib/dal/posts";
         export async function save(id: string, userId: string) {
           const current = await getEditablePost.uncached(id, userId);
           return current;
         }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("N5");
  });

  it("passes when the reason is written down", () => {
    expect(
      checkSources([
        file(
          "src/actions/posts.ts",
          `import { getEditablePost } from "@/lib/dal/posts";
           export async function save(id: string, userId: string) {
             // Follows a write in this same request, so a memoised read would
             // replay the row as it was before the update.
             const current = await getEditablePost.uncached(id, userId);
             return current;
           }`,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("N6 / N7 — where loaders may be built", () => {
  it("catches a loader built outside the loaders module", () => {
    const findings = checkSources([
      file(
        "src/app/blog/page.tsx",
        `import { createBatchLoader } from "@/lib/dal/batch";
         export function build() {
           return createBatchLoader({ name: "x", keyOf: (r) => r.id, fetch: async () => [] });
         }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("N6");
    expect(findings[0]?.message).toContain("data leak");
  });

  it("catches a loader built at module scope, which outlives the request", () => {
    // The whole defect in one line: an instance shared by every request the
    // process serves, returning the first one's rows to all of them.
    const findings = checkSources([
      file(
        "src/lib/dal/loaders.ts",
        `import { createBatchLoader } from "@/lib/dal/batch";
         const userLoader = createBatchLoader({ name: "x", keyOf: (r) => r.id, fetch: async () => [] });
         export function loadUser(id: string) { return userLoader.load(id); }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("N7");
    expect(findings[0]?.message).toContain("across users");
  });

  it("passes a factory reached through cache()", () => {
    expect(
      checkSources([
        file(
          "src/lib/dal/loaders.ts",
          `import { cache } from "react";
           import { createBatchLoader } from "@/lib/dal/batch";
           export function createUserLoader() {
             return createBatchLoader({ name: "x", keyOf: (r) => r.id, fetch: async () => [] });
           }
           const getUserLoader = cache(createUserLoader);
           export function loadUser(id: string) { return getUserLoader().load(id); }`,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("the repository itself", () => {
  it("has no violations", () => {
    expect(checkSources(collectSources(process.cwd()))).toEqual([]);
  });
});
