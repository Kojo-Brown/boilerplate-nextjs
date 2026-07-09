import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getPostsByUser } from "@/lib/dal/posts";

export async function GET(): Promise<NextResponse> {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const posts = await getPostsByUser(session.user.id);
  return NextResponse.json(posts);
}
