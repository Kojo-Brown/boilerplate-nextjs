import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // Run on all routes except Next.js internals and static assets.
  // auth/[...nextauth] is excluded so OAuth callbacks aren't gated.
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
