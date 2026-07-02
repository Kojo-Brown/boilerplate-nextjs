"use server";

import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn, signOut } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { ok, err } from "@/lib/actions";
import type { ActionResult } from "@/lib/actions";

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function loginAction(
  _: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return err("Please check your inputs.", parsed.error.flatten().fieldErrors);
  }

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: "/dashboard",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return err("Invalid email or password.");
    }
    throw error;
  }

  return ok(undefined);
}

export async function registerAction(
  _: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return err("Please check your inputs.", parsed.error.flatten().fieldErrors);
  }

  const { name, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return err("An account with this email already exists.", {
      email: ["This email is already registered."],
    });
  }

  const hashedPassword = await hashPassword(password);
  await prisma.user.create({ data: { name, email, password: hashedPassword } });

  try {
    await signIn("credentials", { email, password, redirectTo: "/dashboard" });
  } catch (error) {
    if (error instanceof AuthError) {
      return err("Account created. Please sign in.");
    }
    throw error;
  }

  return ok(undefined);
}

export async function signInWithGoogleAction(): Promise<void> {
  await signIn("google", { redirectTo: "/dashboard" });
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
