import { cn } from "@/lib/cn";

type NotificationVariant = "info" | "success" | "warning";

export type Notification = {
  id: string;
  title: string;
  body: string;
  variant: NotificationVariant;
  timestamp: string;
};

type NotificationsWidgetProps = {
  notifications: Notification[];
};

const variantStyles: Record<NotificationVariant, { dot: string }> = {
  info: { dot: "bg-blue-500" },
  success: { dot: "bg-green-500" },
  warning: { dot: "bg-yellow-500" },
};

export function NotificationsWidget({ notifications }: NotificationsWidgetProps) {
  return (
    <div
      className="rounded-xl border p-6"
      style={{ backgroundColor: "var(--background)" }}
    >
      <h2
        className="mb-4 text-sm font-medium uppercase tracking-wider"
        style={{ color: "var(--muted-foreground)" }}
      >
        Notifications
      </h2>

      {notifications.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          No new notifications.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {notifications.map((n) => (
            <li key={n.id} className="flex items-start gap-3">
              <span
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  variantStyles[n.variant].dot,
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-none">{n.title}</p>
                <p
                  className="mt-0.5 text-xs"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  {n.body}
                </p>
                <p
                  className="mt-1 text-xs tabular-nums"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  {n.timestamp}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
