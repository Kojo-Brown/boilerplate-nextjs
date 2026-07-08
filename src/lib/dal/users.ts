import { prisma } from "@/lib/prisma";
import type { User } from "@prisma/client";

export type UserProfile = Pick<User, "id" | "name" | "email" | "image" | "role" | "createdAt">;

export async function getUserById(id: string): Promise<UserProfile | null> {
  return prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      createdAt: true,
    },
  });
}

export async function getUserByEmail(email: string): Promise<UserProfile | null> {
  return prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      createdAt: true,
    },
  });
}

export async function getAllUsers(): Promise<UserProfile[]> {
  return prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}
