import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getRecentPostsByAuthor } from "@/lib/dal/posts";
import { getRequiredTenant } from "@/lib/tenancy/active";

type RecentPostsProps = {
  userId: string;
};

/** How many rows the activity list shows. */
const RECENT_POST_LIMIT = 5;

/**
 * `getTranslations` and not `useTranslations`, because this component is async.
 *
 * It is also the one place in this tree where the asynchronous reader is
 * allowed: this component is rendered inside the dashboard's `<Suspense>`
 * boundary, so an uncached read here is a streamed hole rather than the
 * prerender-ending error `cacheComponents` raises for one in the root layout.
 * `scripts/assert-streaming-boundaries.ts` is what holds that boundary in
 * place.
 */
export async function RecentPosts({ userId }: RecentPostsProps) {
  const tenant = await getRequiredTenant();
  const [t, posts] = await Promise.all([
    getTranslations("posts"),
    getRecentPostsByAuthor(tenant.tenantId, userId, RECENT_POST_LIMIT),
  ]);

  const drafts = posts.filter((post) => !post.published).length;

  return (
    <div
      className="rounded-xl border p-6"
      style={{ backgroundColor: "var(--background)" }}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="min-w-0">
          <h2
            className="text-sm font-medium uppercase tracking-wider"
            style={{ color: "var(--muted-foreground)" }}
          >
            {t("recentTitle")}
          </h2>
          {/*
            The two plural messages in the catalogues, rendered. They were
            formatted only by `scripts/assert-i18n-catalogues.ts` until now,
            which is a gate checking a message nothing displayed.

            This is also the one place in the application where the six Arabic
            CLDR categories are visible: `0` takes the `=0` branch and prints
            the empty-state wording, `1` the `one` branch, `2` the `two`
            branch, `3`-`10` the `few` branch and `11`-`99` the `many` branch —
            against English's two forms. An `ar` catalogue carrying English's
            `{one, other}` formats without error and is wrong for 2, 3 and 11,
            which is the failure that gate exists for and this line is the
            consequence of.
          */}
          <p
            className="mt-0.5 text-xs"
            style={{ color: "var(--muted-foreground)" }}
          >
            {t("count", { count: posts.length })}
            {drafts > 0 ? ` · ${t("draftCount", { count: drafts })}` : null}
          </p>
        </div>
        <Link
          href="/posts"
          className="text-xs font-medium hover:underline"
          style={{ color: "var(--primary)" }}
        >
          View all
        </Link>
      </div>

      {posts.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          {t("empty")}{" "}
          <Link
            href="/posts"
            className="font-medium hover:underline"
            style={{ color: "var(--primary)" }}
          >
            Create your first post
          </Link>
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {posts.map((post) => (
            <li
              key={post.id}
              className="flex items-center justify-between rounded-lg border px-3 py-2.5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium"
                  style={
                    post.published
                      ? {
                          backgroundColor: "var(--primary)",
                          color: "var(--primary-foreground)",
                        }
                      : {
                          backgroundColor: "var(--muted)",
                          color: "var(--muted-foreground)",
                        }
                  }
                >
                  {post.published ? t("status.live") : t("status.draft")}
                </span>
                <span className="truncate text-sm font-medium">
                  {post.title}
                </span>
              </div>
              <time
                dateTime={post.createdAt.toISOString()}
                className="ms-4 shrink-0 text-xs"
                style={{ color: "var(--muted-foreground)" }}
              >
                {post.createdAt.toLocaleDateString()}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
