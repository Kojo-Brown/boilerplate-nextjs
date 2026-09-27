import { SESSION_COOKIE_NAME, USE_SECURE_COOKIES } from "@/lib/auth/deployment";
import { SESSION_IDLE_MAX_AGE_S } from "@/lib/auth/policy";
import { safeRedirectPath } from "@/lib/security/safe-redirect";
import type { NextAuthConfig } from "next-auth";

/**
 * Routes the proxy refuses to serve to an anonymous request.
 *
 * `/posts`, `/images` and `/upload` were absent for as long as they were
 * "protected" by an `await getRequiredSession()` at the top of their page
 * components. That works, but it is authorisation by rendering: the request
 * reaches the application, the page starts, the session read redirects, and —
 * under Cache Components — the read also pulls the page's entire body out of
 * the static shell, because a route cannot both gate on a cookie and prerender
 * anything below that gate.
 *
 * Listing them here moves the gate ahead of the response instead, which is both
 * cheaper and earlier. It does not replace the checks next to the data:
 * `<PostsSection>` still calls `getRequiredSession()` and scopes its query to
 * that user, and `getPresignedUploadUrlAction` still calls `auth()` before it
 * signs anything. What it does replace is a session read whose only job was to
 * decide whether the route may be rendered at all.
 */
export const PROTECTED_PREFIXES = [
  "/dashboard",
  "/settings",
  "/profile",
  "/posts",
  "/images",
  "/upload",
];
export const ADMIN_PREFIXES = ["/admin"];
export const AUTH_PAGES = ["/login", "/register"];

/** Where a signed-in visitor lands when no usable `callbackUrl` says otherwise. */
export const POST_LOGIN_PATH = "/dashboard";

/**
 * The URL an anonymous request to a gated route is sent to.
 *
 * Both refusals below build the same thing, and building it twice is how the two
 * copies drift — one of them gaining a `safeRedirectPath` the other does not.
 *
 * `callbackUrl` is passed through the same predicate that reads it back, which
 * is belt-and-braces rather than a fix: a `nextUrl.pathname` beginning `//` is
 * possible (a request to `https://app.example//evil.example/x` has exactly
 * that), but such a path matches no prefix in either list, so it never reaches
 * here. Writing the check on both sides means that argument does not have to be
 * re-derived by whoever adds the next prefix.
 */
function loginRedirect(nextUrl: URL): Response {
  const loginUrl = new URL("/login", nextUrl);
  loginUrl.searchParams.set(
    "callbackUrl",
    safeRedirectPath(nextUrl.pathname + nextUrl.search, POST_LOGIN_PATH),
  );
  return Response.redirect(loginUrl);
}

export const authConfig = {
  pages: {
    signIn: "/login",
    error: "/login",
  },

  /**
   * Safe here, and only because `@/lib/auth/deployment` pins `AUTH_URL`.
   *
   * Auth.js's own default for this reads `AUTH_URL`, which this repository has
   * never used — it uses the v4 name `NEXTAUTH_URL` everywhere — so a
   * production build that was not on Vercel got `trustHost: false` and answered
   * 500 to every request into `@auth/core`, including `/api/auth/csrf`. Nobody
   * could sign in. See the header of `@/lib/auth/deployment` for the
   * measurement and for why pinning the origin is what makes trusting the host
   * a non-question rather than a risk.
   */
  trustHost: true,

  /**
   * Pinned, rather than re-derived from `x-forwarded-proto` on every request.
   *
   * This flag decides both the `Secure` attribute and the cookie's name prefix,
   * and the name is the salt the JWT is encrypted under. Letting a request
   * header choose it means letting a caller choose which cookie the server
   * looks in.
   */
  useSecureCookies: USE_SECURE_COOKIES,

  cookies: {
    sessionToken: {
      // `__Host-` in a secure deployment — see `@/lib/auth/deployment` for what
      // it buys over Auth.js's `__Secure-` default and what it costs.
      name: SESSION_COOKIE_NAME,
      options: {
        httpOnly: true,
        // `lax` and not `strict`: `strict` withholds the cookie on the
        // cross-site GET that ends an OAuth sign-in, so the callback would
        // land without a session and bounce back to /login. `lax` still
        // withholds it from cross-site POSTs, which is the CSRF-relevant half.
        sameSite: "lax" as const,
        // Required by `__Host-`, and the only value that lets the proxy see the
        // cookie on every path it gates.
        path: "/",
        secure: USE_SECURE_COOKIES,
        // Deliberately no `domain`: `__Host-` forbids it, and a cookie scoped
        // to the registrable domain is one any sibling subdomain can overwrite.
      },
    },
  },

  session: {
    strategy: "jwt" as const,
    // The sliding idle window, refreshed on every request, and also the JWT's
    // own `exp`. Auth.js defaults it to 30 days; see `@/lib/auth/policy`.
    maxAge: SESSION_IDLE_MAX_AGE_S,
  },

  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isAdmin = auth?.user?.role === "ADMIN";
      const { pathname } = nextUrl;

      const isAdminRoute = ADMIN_PREFIXES.some((prefix) =>
        pathname.startsWith(prefix),
      );
      const isProtected = PROTECTED_PREFIXES.some((prefix) =>
        pathname.startsWith(prefix),
      );
      const isAuthPage = AUTH_PAGES.includes(pathname);

      // Admin routes: must be authenticated AND have ADMIN role.
      if (isAdminRoute) {
        if (!isLoggedIn) return loginRedirect(nextUrl);
        if (!isAdmin) {
          return Response.redirect(new URL("/forbidden", nextUrl));
        }
      }

      // Regular protected routes: must be authenticated.
      if (isProtected && !isLoggedIn) return loginRedirect(nextUrl);

      // Authenticated users are redirected away from auth pages, to wherever
      // the gate above said they were going.
      //
      // `safeRedirectPath` and not `callbackUrl.startsWith("/")`, which is what
      // this was and which was an open redirect: `//evil.example` starts with a
      // slash and `new URL("//evil.example", nextUrl)` is
      // `https://evil.example/`, so `/login?callbackUrl=//evil.example` bounced
      // any signed-in visitor straight off the origin — from a link that begins
      // with this application's own hostname, which is the entire value of the
      // technique to whoever sends it. `//` on its own was worse in a smaller
      // way: `new URL("//", nextUrl)` throws, so the proxy answered 500.
      //
      // The parameter is one this file writes, a few lines up. That is not a
      // reason to trust it — it arrives back over the network like anything else
      // in a URL, and nothing stops a caller from putting their own value there.
      if (isLoggedIn && isAuthPage) {
        const destination = safeRedirectPath(
          nextUrl.searchParams.get("callbackUrl"),
          POST_LOGIN_PATH,
        );
        return Response.redirect(new URL(destination, nextUrl));
      }

      return true;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
