import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// Next 16 renamed the `middleware` file convention to `proxy`; keeping the old
// name builds, but emits a deprecation warning, and CI fails on warnings. The
// contract is unchanged — same default-exported handler, same `config.matcher`.
//
// Next 16 statically verifies that this file exports a function. A destructured
// re-export (`export const { auth: proxy } = NextAuth(...)`) is not recognised
// as one, so the handler is bound to a plain const and exported.
const { auth } = NextAuth(authConfig);

export default auth;

export const config = {
  // Run on all routes except Next.js internals and static assets.
  // auth/[...nextauth] is excluded so OAuth callbacks aren't gated.
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
