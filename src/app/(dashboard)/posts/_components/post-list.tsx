import { getPostsByUser, getPublishedPosts } from "@/lib/dal/posts";
import { PostCard } from "./post-card";

type PostListProps = {
  userId: string;
};

/** Server Component — queries Prisma directly, no fetch() or API route. */
export async function PostList({ userId }: PostListProps) {
  const [myPosts, publishedPosts] = await Promise.all([
    getPostsByUser(userId),
    getPublishedPosts(),
  ]);

  const otherPosts = publishedPosts.filter((p) => p.author.id !== userId);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--muted-foreground)" }}>
          My Posts ({myPosts.length})
        </h2>
        {myPosts.length === 0 ? (
          <p className="rounded-xl border border-dashed p-8 text-center text-sm" style={{ color: "var(--muted-foreground)" }}>
            You haven&apos;t created any posts yet.
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {myPosts.map((post) => (
              <li key={post.id}>
                <PostCard post={post} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {otherPosts.length > 0 && (
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--muted-foreground)" }}>
            Published by Others ({otherPosts.length})
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {otherPosts.map((post) => (
              <li key={post.id}>
                <PostCard post={post} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
