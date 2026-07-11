import { getRequiredSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { NotificationsWidget } from "./_components/notifications-widget";
import type { Notification } from "./_components/notifications-widget";

async function buildNotifications(userId: string): Promise<Notification[]> {
  const [draftCount, latestPost] = await Promise.all([
    prisma.post.count({ where: { authorId: userId, published: false } }),
    prisma.post.findFirst({
      where: { authorId: userId },
      orderBy: { updatedAt: "desc" },
      select: { title: true, updatedAt: true, published: true },
    }),
  ]);

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
