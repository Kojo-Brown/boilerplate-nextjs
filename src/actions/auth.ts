"use server";

import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn, signOut } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { ActionError } from "@/lib/actions/result";
import {
  defineFormAction,
  defineNavigationAction,
} from "@/lib/actions/define-action";

/**
 * The credential and OAuth entry points.
 *
 * These are the actions that cannot require a session — establishing one is
 * what they are for — so they are built by the unauthenticated factories. They
 * still get the other two legs, and the origin check matters more here than
 * almost anywhere else in the app: `signOutAction` is a state-changing POST
 * with no body, which is the textbook CSRF target, and a forged sign-*in* is
 * how an attacker gets a victim operating inside an account the attacker
 * controls.
 *
 * `signIn`/`signOut` from NextAuth throw `redirect()` on success. That is why
 * the two OAuth actions are `defineNavigationAction`s — there is no result to
 * return, and the factory passes framework signals through untouched.
 */

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

/** A form that carries nothing but its submit button. */
const noInput = z.object({});

export const loginAction = defineFormAction({
  name: "login",
  input: loginSchema,
  handler: async ({ input }): Promise<void> => {
    try {
      await signIn("credentials", {
        email: input.email,
        password: input.password,
        redirectTo: "/dashboard",
      });
    } catch (error) {
      // `signIn` redirects by throwing on success, so only an `AuthError` here
      // is a real failure; anything else — the redirect included — is rethrown
      // and handled by the factory.
      if (error instanceof AuthError) {
        throw new ActionError("Invalid email or password.");
      }
      throw error;
    }
  },
});

export const registerAction = defineFormAction({
  name: "register",
  input: registerSchema,
  handler: async ({ input }): Promise<void> => {
    const { name, email, password } = input;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ActionError("An account with this email already exists.", {
        email: ["This email is already registered."],
      });
    }

    const hashedPassword = await hashPassword(password);
    await prisma.user.create({
      data: { name, email, password: hashedPassword },
    });

    try {
      await signIn("credentials", {
        email,
        password,
        redirectTo: "/dashboard",
      });
    } catch (error) {
      if (error instanceof AuthError) {
        throw new ActionError("Account created. Please sign in.");
      }
      throw error;
    }
  },
});

export const signInWithGoogleAction = defineNavigationAction({
  name: "signInWithGoogle",
  input: noInput,
  handler: async (): Promise<void> => {
    await signIn("google", { redirectTo: "/dashboard" });
  },
});

export const signOutAction = defineNavigationAction({
  name: "signOut",
  input: noInput,
  handler: async (): Promise<void> => {
    await signOut({ redirectTo: "/login" });
  },
});
