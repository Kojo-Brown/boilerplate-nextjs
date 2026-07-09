import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getPaginatedPostsByUser } from "@/lib/dal/posts";
import { parseCursorParams } from "@/lib/pagination";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = parseCursorParams(request.nextUrl.searchParams);
  const page = await getPaginatedPostsByUser(session.user.id, params);

  return NextResponse.json(page);
}
