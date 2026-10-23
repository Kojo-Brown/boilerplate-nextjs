import { getRequiredAdminSession } from "@/lib/session";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The four values in the admin session card.
 *
 * Same split as `/dashboard`: the card, its heading and the `<dt>` labels are
 * the same for every administrator and prerender; only the `<dd>` contents wait
 * on `getRequiredAdminSession()`.
 *
 * The role check stays inside this boundary rather than moving up into the
 * page, because `/admin` is already gated by `ADMIN_PREFIXES` in
 * `auth.config.ts` — the proxy redirects a non-admin before any of this markup
 * is produced. This call is the second, authoritative check, sitting next to
 * the data it protects.
 */
const FIELDS = ["Name", "Email", "Role", "User ID"] as const;

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <dt className="text-xs" style={{ color: "var(--muted-foreground)" }}>
      {children}
    </dt>
  );
}

export async function AdminSessionFields() {
  const session = await getRequiredAdminSession();

  return (
    <>
      <div>
        <FieldLabel>Name</FieldLabel>
        <dd className="mt-0.5 text-sm font-medium">
          {session.user.name ?? "—"}
        </dd>
      </div>
      <div>
        <FieldLabel>Email</FieldLabel>
        <dd className="mt-0.5 text-sm font-medium">
          {session.user.email ?? "—"}
        </dd>
      </div>
      <div>
        <FieldLabel>Role</FieldLabel>
        <dd className="mt-0.5 text-sm font-medium">
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
            style={{
              backgroundColor: "var(--primary)",
              color: "var(--primary-foreground)",
            }}
          >
            {session.user.role}
          </span>
        </dd>
      </div>
      <div>
        <FieldLabel>User ID</FieldLabel>
        <dd className="mt-0.5 font-mono text-xs">{session.user.id}</dd>
      </div>
    </>
  );
}

/** Same grid cells and labels, 20px value lines — nothing moves when it fills. */
export function AdminSessionFieldsFallback() {
  return (
    <>
      {FIELDS.map((label) => (
        <div key={label}>
          <FieldLabel>{label}</FieldLabel>
          <dd className="mt-0.5">
            <Skeleton className="h-5 w-28" />
          </dd>
        </div>
      ))}
    </>
  );
}
