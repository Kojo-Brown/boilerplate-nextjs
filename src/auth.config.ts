import type { NextAuthConfig } from "next-auth";

export const PROTECTED_PREFIXES = ["/dashboard", "/settings", "/profile"];
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
