import type { NextAuthConfig } from "next-auth";

export const PROTECTED_PREFIXES = ["/dashboard", "/settings", "/profile"];
export const AUTH_PAGES = ["/login", "/register"];

export const authConfig = {
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const { pathname } = nextUrl;

      const isProtected = PROTECTED_PREFIXES.some((prefix) =>
        pathname.startsWith(prefix),
      );
      const isAuthPage = AUTH_PAGES.includes(pathname);

      if (isProtected && !isLoggedIn) {
        const loginUrl = new URL("/login", nextUrl);
        loginUrl.searchParams.set(
          "callbackUrl",
          nextUrl.pathname + nextUrl.search,
        );
        return Response.redirect(loginUrl);
      }

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
