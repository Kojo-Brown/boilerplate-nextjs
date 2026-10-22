import { getRequiredSession } from "@/lib/session";
import { DashboardStats } from "../_components/dashboard-stats";

export default async function StatsSlot() {
  const session = await getRequiredSession();
  return <DashboardStats userId={session.user.id} />;
}
