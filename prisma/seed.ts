import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";

/**
 * Deterministic development / CI seed.
 *
 * `prisma.config.ts` has pointed its `migrations.seed` at this file since the
 * Prisma 7 migration, but the file itself never existed. It matters beyond
 * developer convenience: `app/blog/[slug]` enumerates published posts in
 * `generateStaticParams`, and under Cache Components that function may not
 * return an empty array. CI builds against a freshly `db push`ed, empty
 * database, so without rows to enumerate the build fails outright.
 *
 * Two properties are load-bearing and should be preserved by anyone editing
 * this file:
 *
 * 1. **Deterministic ids.** Post ids are literals rather than `cuid()`s so
 *    `/blog/<id>` URLs are stable across seeds. A test or a bookmark that
 *    depends on `seed-post-partial-prerendering` keeps working after a reseed.
 * 2. **Idempotent.** Everything is an upsert keyed on that stable id (or on
 *    the unique email), so running the seed twice against the same database is
 *    a no-op rather than a duplicate-key error.
 *
 * Every credential here is obviously fake and exists only so the Credentials
 * provider has something to authenticate against locally. Nothing in this file
 * is a real secret, and nothing in it should ever be reachable from a
 * production database.
 */

/** Not a secret. A literal shared by both seed users so local sign-in is easy. */
const DEMO_PASSWORD = "demo-password-not-for-real-use";

const USERS = [
  {
    id: "seed-user-ada",
    email: "ada@example.com",
    name: "Ada Example",
    role: "ADMIN",
  },
  {
    id: "seed-user-grace",
    email: "grace@example.com",
    name: "Grace Example",
    role: "USER",
  },
] as const;

const POSTS = [
  {
    id: "seed-post-partial-prerendering",
    title: "Partial Prerendering: a static shell with streamed holes",
    content:
      "Cache Components splits a route into a prerendered shell and dynamic " +
      "holes. The shell reaches the browser from the CDN immediately; anything " +
      "that reads cookies or headers streams in behind a Suspense boundary. " +
      "This post exists so the blog has stable, enumerable content at build time.",
    published: true,
    authorId: "seed-user-ada",
  },
  {
    id: "seed-post-cache-life",
    title: "cacheLife and cacheTag replace route-level revalidate",
    content:
      "Under Cache Components a route no longer declares a TTL. Caching moves " +
      'into the functions that fetch data, marked with "use cache" and given a ' +
      "profile via cacheLife. On-demand invalidation moves from revalidatePath " +
      "to revalidateTag, which addresses the cache entry rather than the URL.",
    published: true,
    authorId: "seed-user-ada",
  },
  {
    id: "seed-post-suspense-boundaries",
    title: "Suspense boundaries are load-bearing now",
    content:
      "A boundary placed too high turns the static shell into an empty page, " +
      "and nothing in code review will tell you. The build's route table is the " +
      "only place that shows it, which is why this repository asserts the table " +
      "in CI rather than trusting a reviewer to notice.",
    published: true,
    authorId: "seed-user-grace",
  },
  {
    id: "seed-post-unpublished-draft",
    title: "An unpublished draft",
    content:
      "This post is deliberately left unpublished so the dashboard has a draft " +
      "to show and so generateStaticParams has something it must exclude.",
    published: false,
    authorId: "seed-user-grace",
  },
] as const;

async function main(): Promise<void> {
  // Hashed once and shared: scrypt is intentionally slow, and hashing the same
  // literal per user would only make the seed slower, not safer.
  const password = await hashPassword(DEMO_PASSWORD);

  for (const user of USERS) {
    await prisma.user.upsert({
      where: { email: user.email },
      // `id` is deliberately absent from `update`: it is the primary key, and
      // an existing row keyed on this email already has the id we want.
      update: { name: user.name, role: user.role, password },
      create: { ...user, password },
    });
  }

  for (const post of POSTS) {
    await prisma.post.upsert({
      where: { id: post.id },
      update: {
        title: post.title,
        content: post.content,
        published: post.published,
      },
      create: { ...post },
    });
  }

  const published = POSTS.filter((post) => post.published).length;
  console.log(
    `Seeded ${USERS.length} users and ${POSTS.length} posts (${published} published).`,
  );
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    // A failed seed must fail the CI step it runs in. Without an explicit
    // non-zero exit the rejected promise would only warn on some Node versions.
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
