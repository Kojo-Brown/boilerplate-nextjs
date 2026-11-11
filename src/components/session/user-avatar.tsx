import Image from "next/image";
import { getSession } from "@/lib/session";

interface UserAvatarProps {
  size?: "sm" | "md" | "lg";
}

const sizeMap = {
  sm: { px: 28, cls: "text-xs" },
  md: { px: 36, cls: "text-sm" },
  lg: { px: 48, cls: "text-base" },
} as const;

function getInitials(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  if (name) {
    return name
      .split(" ")
      .map((n) => n[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }
  if (email) return email[0]!.toUpperCase();
  return "?";
}

/**
 * Session-aware server component that renders the current user's avatar.
 * Falls back to coloured initials when no image is set.
 */
export async function UserAvatar({ size = "md" }: UserAvatarProps) {
  const session = await getSession();
  if (!session) return null;

  const { user } = session;
  const { px, cls } = sizeMap[size];
  const label = user.name ?? user.email ?? "User";

  if (user.image) {
    return (
      <Image
        src={user.image}
        alt={label}
        width={px}
        height={px}
        className="rounded-full object-cover ring-1 ring-border"
      />
    );
  }

  return (
    <div
      className={`inline-flex items-center justify-center rounded-full font-medium ${cls}`}
      style={{
        width: px,
        height: px,
        backgroundColor: "var(--primary)",
        color: "var(--primary-foreground)",
      }}
      // `role="img"` is what makes the rest of this legal. `aria-label` on a
      // bare `<div>` is a prohibited attribute — the mapping has no role to
      // hang a name on, so the label is dropped and the element is announced
      // by its text content, which is two letters. With the role, the initials
      // become the image and the label is the name. Found by
      // `e2e/a11y-journey.spec.ts`, which audits the dashboard with a session
      // on it; the prerendered documents the static gate reads have no avatar,
      // because there is no user in them.
      role="img"
      aria-label={label}
      title={label}
    >
      {getInitials(user.name, user.email)}
    </div>
  );
}
