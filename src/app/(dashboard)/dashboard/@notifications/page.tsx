import { getRequiredSession } from "@/lib/session";
import {
  getLastEditedPostByAuthor,
  getPostCountsByAuthor,
} from "@/lib/dal/posts";
import { NotificationsWidget } from "./_components/notifications-widget";
import type { Notification } from "./_components/notifications-widget";

/**
 * The draft count comes from the same memoised `GROUP BY` that `@stats` reads,
 * so this slot no longer issues a `COUNT(*)` of its own — whichever of the two
 * renders first pays for it. The two slots cannot see each other and do not
 * need to; sharing the read is what the data layer is for. See
 * `docs/n-plus-one.md`.
 */
async function buildNotifications(userId: string): Promise<Notification[]> {
  const [counts, latestPost] = await Promise.all([
    getPostCountsByAuthor(userId),
    getLastEditedPostByAuthor(userId),
  ]);
  const draftCount = counts.drafts;

  const items: Notification[] = [
    {
      id: "welcome",
      title: "Welcome to your dashboard",
      body: "Everything is set up and ready to go.",
      variant: "success",
      timestamp: "System",
    },
  ];

  if (latestPost) {
    const label = latestPost.published ? "published" : "draft";
    const date = latestPost.updatedAt.toLocaleDateString();
    items.push({
      id: "latest-post",
      title: `Last ${label}: ${latestPost.title}`,
      body: `Updated on ${date}`,
      variant: "info",
      timestamp: date,
    });
  }

  if (draftCount > 0) {
    items.push({
      id: "drafts",
      title: `${draftCount} unpublished draft${draftCount === 1 ? "" : "s"}`,
      body: "Consider publishing your pending posts.",
      variant: "warning",
      timestamp: "Today",
    });
  }

  return items;
}

export default async function NotificationsSlot() {
  const session = await getRequiredSession();
  const notifications = await buildNotifications(session.user.id);
  return <NotificationsWidget notifications={notifications} />;
}
