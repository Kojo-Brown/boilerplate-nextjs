// The provider client secret, the credentials verifier and the Prisma adapter
// are all in this module. See docs/server-only.md.
import "server-only";

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { z } from "zod";
import type { DefaultSession } from "next-auth";
import { serverEnv } from "@/lib/env/server";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/auth.config";
import { verifyPassword } from "@/lib/password";
import { readSessionClaims } from "@/lib/auth/claims";
import { hardenSessionToken, reportSessionEvent } from "@/lib/auth/harden";
import { sessionRegistry } from "@/lib/auth/registry";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "USER" | "ADMIN";
    } & DefaultSession["user"];
  }
  interface User {
    role?: "USER" | "ADMIN";
  }
}

// `next-auth/jwt` is a bare `export * from "@auth/core/jwt"` re-export, so an
// interface declared there has nothing to merge into. The JWT interface itself
// lives in @auth/core, which is why the augmentation targets it directly.
declare module "@auth/core/jwt" {
  interface JWT {
    // Explicit `| undefined` because `exactOptionalPropertyTypes` is on and the
    // provider `user` these are copied from has an optional `id` of its own.
    id?: string | undefined;
    role?: "USER" | "ADMIN" | undefined;
    // The session-hardening claims. See `@/lib/auth/claims` for what each one
    // is for and why all four have to be present or none of them counts.
    sid?: string | undefined;
    tid?: string | undefined;
    sat?: number | undefined;
    rat?: number | undefined;
  }
}

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

/**
 * The dependencies `@/lib/auth/harden` is parameterised over, bound once.
 *
 * `crypto.randomUUID` for both ids: they are opaque handles compared for
 * equality and never derived from, so 122 bits of CSPRNG output is the whole
 * requirement, and it is the same generator Auth.js uses for its own database
 * session tokens.
 */
export const sessionHardening = {
  registry: sessionRegistry,
  now: () => new Date(),
  newId: () => crypto.randomUUID(),
  report: reportSessionEvent,
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  providers: [
    Google({
      // Read through the schema rather than from `process.env` directly, which
      // is what this did until the server-only gate found it. A raw read is the
      // one way a secret reaches a module without importing anything marked
      // server-only, so it is the hole the marker cannot see: in a browser Next
      // substitutes nothing for a name that is not `NEXT_PUBLIC_*`, and the
      // expression evaluates to `undefined` with no error anywhere.
      // `scripts/assert-server-only.ts` and the `no-secret-env-access` lint rule
      // now both refuse it. See docs/server-only.md.
      clientId: serverEnv.GOOGLE_CLIENT_ID ?? "",
      clientSecret: serverEnv.GOOGLE_CLIENT_SECRET ?? "",
      allowDangerousEmailAccountLinking: true,
    }),
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
        });
        if (!user?.password) return null;

        const valid = await verifyPassword(parsed.data.password, user.password);
        if (!valid) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,

    /**
     * Sign-in mints the session; every later call only verifies it.
     *
     * `mayRotate: false` is the load-bearing argument. This instance's callback
     * runs on the `/api/auth/*` route handlers and inside `auth()` in a Server
     * Component, and a Server Component cannot write a cookie —
     * `next-auth`'s RSC path reads the session response's body and drops its
     * `Set-Cookie` headers, because there is nowhere for them to go. Rotating
     * here would advance the registry to a `tid` the browser never receives;
     * the next request would present the one it still has, and reuse detection
     * would revoke the session of a user who did nothing wrong. Rotation
     * therefore happens only in `src/proxy.ts`, which is the one place a
     * `Set-Cookie` from this callback is demonstrably on the response.
     */
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role ?? "USER";
      }
      return hardenSessionToken(
        { token, user, mayRotate: false },
        sessionHardening,
      );
    },

    session({ session, token }) {
      session.user.id = token.id ?? "";
      session.user.role = token.role ?? "USER";
      return session;
    },
  },

  events: {
    /**
     * Signing out ends the family, not just the cookie.
     *
     * Without this, "sign out" means "clear my browser": the row stays live and
     * any copy of the cookie made before the sign-out keeps working until the
     * session's absolute deadline. Under a JWT strategy that is the whole of
     * what signing out has ever done, and it is the half of revocation that
     * `SessionFamily` exists to supply.
     *
     * The argument is a union — `{ token }` under the JWT strategy, `{ session }`
     * under the database one — so the `in` check is what narrows it rather than
     * an assertion about which strategy is configured.
     */
    async signOut(message) {
      if (!("token" in message) || !message.token) return;
      const claims = readSessionClaims(message.token);
      if (!claims) return;
      await sessionRegistry.revoke(claims.sid, "SIGNED_OUT", new Date());
    },
  },
});
