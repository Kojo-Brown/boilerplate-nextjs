/**
 * The grammar of a tenant's public handle.
 *
 * A slug is what a subdomain, a path segment and a support ticket all name the
 * tenant by, so it has to be something all three can carry. The narrowest of
 * those is the hostname label, and that is what the rules below are: lowercase
 * letters, digits and hyphens, no leading or trailing hyphen, 63 characters at
 * most. A slug that is legal here is legal everywhere the tenant is named.
 *
 * No Prisma import and no `server-only`: this is a pure predicate over a
 * string, and the registration form wants to check it before submitting.
 */

/** The longest a DNS label may be, which is the binding constraint. */
export const MAX_SLUG_LENGTH = 63;

/** Short enough to be a mistake rather than a name. */
export const MIN_SLUG_LENGTH = 2;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Names a tenant may not take, because the application or the infrastructure
 * already answers to them.
 *
 * Reserved rather than merely discouraged: with subdomain routing, a tenant
 * called `www` or `api` takes over a hostname the deployment needs, and a
 * tenant called `admin` is a phishing surface that this application's own
 * links would lend credibility to.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "blog",
  "cdn",
  "dashboard",
  "docs",
  "help",
  "internal",
  "login",
  "mail",
  "new",
  "public",
  "register",
  "root",
  "settings",
  "static",
  "status",
  "support",
  "system",
  "www",
]);

export type SlugProblem =
  "too-short" | "too-long" | "malformed" | "reserved" | null;

/** Why this string cannot be a slug, or `null` if it can. */
export function slugProblem(slug: string): SlugProblem {
  if (slug.length < MIN_SLUG_LENGTH) return "too-short";
  if (slug.length > MAX_SLUG_LENGTH) return "too-long";
  if (!SLUG_PATTERN.test(slug)) return "malformed";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  return null;
}

export function isValidSlug(slug: string): boolean {
  return slugProblem(slug) === null;
}

/** A sentence for a person, from the reason above. */
export function describeSlugProblem(problem: NonNullable<SlugProblem>): string {
  switch (problem) {
    case "too-short":
      return `A workspace address needs at least ${MIN_SLUG_LENGTH} characters.`;
    case "too-long":
      return `A workspace address can be at most ${MAX_SLUG_LENGTH} characters.`;
    case "malformed":
      return "A workspace address can use lowercase letters, digits and hyphens, and cannot start or end with a hyphen.";
    case "reserved":
      return "That workspace address is reserved.";
  }
}

/**
 * Turns a name into a candidate slug.
 *
 * A suggestion, not a guarantee: the result still goes through `slugProblem`,
 * because a name of "!!!" reduces to the empty string and a name of "admin"
 * reduces to a reserved word. Returning something invalid rather than throwing
 * is deliberate — the caller is a form offering a default, and the check it
 * would have to do on the result is the check it does on user input anyway.
 *
 * The normalisation is decompose-and-strip rather than a transliteration
 * table: `"Zoë's Café"` becomes `zoes-cafe`, which is the behaviour a person
 * expects from a name they typed. It leaves scripts with no Latin
 * decomposition as nothing, which is why the result is checked and not
 * trusted.
 */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      // Apostrophes are removed, not turned into a separator like every other
      // non-alphanumeric. They sit inside a word rather than between two, so the
      // general rule gives `ada-s-workspace` — and `provisionPersonalTenant`
      // names every personal workspace "<Name>'s workspace", so that would be
      // the default slug for every new account. Both spellings, because a name
      // typed on a phone carries the typographic one.
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SLUG_LENGTH)
      // The slice can leave a trailing hyphen that was legal before it.
      .replace(/-+$/g, "")
  );
}
