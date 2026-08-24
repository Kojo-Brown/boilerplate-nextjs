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

export const authConfig = {
  pages: {
    signIn: "/login",
    error: "/login",
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
        if (!isLoggedIn) {
          const loginUrl = new URL("/login", nextUrl);
          loginUrl.searchParams.set(
            "callbackUrl",
            nextUrl.pathname + nextUrl.search,
          );
          return Response.redirect(loginUrl);
        }
        if (!isAdmin) {
          return Response.redirect(new URL("/forbidden", nextUrl));
        }
      }

      // Regular protected routes: must be authenticated.
      if (isProtected && !isLoggedIn) {
        const loginUrl = new URL("/login", nextUrl);
        loginUrl.searchParams.set(
          "callbackUrl",
          nextUrl.pathname + nextUrl.search,
        );
        return Response.redirect(loginUrl);
      }

      // Authenticated users are redirected away from auth pages.
      if (isLoggedIn && isAuthPage) {
        const callbackUrl = nextUrl.searchParams.get("callbackUrl");
        const destination =
          callbackUrl && callbackUrl.startsWith("/")
            ? callbackUrl
            : "/dashboard";
        return Response.redirect(new URL(destination, nextUrl));
      }

      return true;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
