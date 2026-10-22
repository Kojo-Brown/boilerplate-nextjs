import { getRequiredSession } from "@/lib/session";
import { RecentPosts } from "../_components/recent-posts";

export default async function ActivitySlot() {
  const session = await getRequiredSession();
  return <RecentPosts userId={session.user.id} />;
}
