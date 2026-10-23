import { getRequiredSession } from "@/lib/session";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The session panel on `/dashboard`, split so that the only thing which waits
 * for the cookie read is the four values themselves.
 *
 * The card, its heading and the four `<dt>` labels are page markup — they are
 * identical for every visitor — so they belong in the prerendered shell. Only
 * the `<dd>` contents come from the session. Keeping the boundary here rather
 * than around the whole card means the panel arrives fully laid out and then
 * fills in, instead of appearing from nothing.
 *
 * `SESSION_FIELDS` is shared by the resolved component and its fallback on
 * purpose: a fallback that lists its own copy of the labels is a fallback that
 * will eventually disagree with the thing it stands in for.
 */
const SESSION_FIELDS = [
  { key: "name", label: "Name", mono: false },
  { key: "email", label: "Email", mono: false },
  { key: "role", label: "Role", mono: false },
  { key: "id", label: "User ID", mono: true },
] as const;

type SessionFieldKey = (typeof SESSION_FIELDS)[number]["key"];

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <dt className="text-xs" style={{ color: "var(--muted-foreground)" }}>
      {children}
    </dt>
  );
}

/**
 * The streamed half: one cookie read, four values.
 *
 * Deliberately not four sibling boundaries. They would all resolve from the
 * same `auth()` call at the same instant, so splitting them buys four sets of
 * streaming markers and no earlier paint.
 */
export async function SessionFields() {
  const session = await getRequiredSession();

  const values: Record<SessionFieldKey, string | null | undefined> = {
    name: session.user.name,
    email: session.user.email,
    role: session.user.role,
    id: session.user.id,
  };

  return (
    <>
      {SESSION_FIELDS.map(({ key, label, mono }) => (
        <div key={key}>
          <FieldLabel>{label}</FieldLabel>
          <dd
            className={
              mono ? "mt-0.5 font-mono text-xs" : "mt-0.5 text-sm font-medium"
            }
          >
            {values[key] ?? "—"}
          </dd>
        </div>
      ))}
    </>
  );
}

/**
 * The prerendered half. Same grid cells, same labels, same line heights — the
 * value line is a 20px skeleton because `text-sm font-medium` renders at 20px,
 * so the hole filling in does not move anything below it.
 */
export function SessionFieldsFallback() {
  return (
    <>
      {SESSION_FIELDS.map(({ key, label }) => (
        <div key={key}>
          <FieldLabel>{label}</FieldLabel>
          <dd className="mt-0.5">
            <Skeleton className="h-5 w-28" />
          </dd>
        </div>
      ))}
    </>
  );
}

/** Greeting line under the page heading. The only session read it needs is the name. */
export async function SessionGreeting() {
  const session = await getRequiredSession();

  return (
    <p className="mt-1 text-sm" style={{ color: "var(--muted-foreground)" }}>
      Welcome back, {session.user.name ?? "there"}!
    </p>
  );
}

export function SessionGreetingFallback() {
  return <Skeleton className="mt-1 h-5 w-48" />;
}
