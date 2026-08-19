import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { PHOTOS } from "@/lib/photos";
import { GET } from "./route";
import type { PhotoListPayload } from "./route";

function get(query = ""): Promise<Response> {
  return GET(
    new NextRequest(new Request(`https://example.test/api/photos${query}`)),
  );
}

async function payload(query = ""): Promise<PhotoListPayload> {
  return (await (await get(query)).json()) as PhotoListPayload;
}

describe("GET /api/photos", () => {
  it("lists the whole catalogue when no query is given", async () => {
    const body = await payload();
    expect(body.total).toBe(PHOTOS.length);
    expect(body.items).toHaveLength(PHOTOS.length);
  });

  it("resolves each photo's source into a usable URL and drops the internal id", async () => {
    const [first] = (await payload()).items;

    expect(first?.src).toMatch(/^https:\/\/images\.unsplash\.com\/photo-/);
    // `source` is an upstream asset ID that means nothing without the host; the
    // API resolves it rather than leaking it.
    expect(first).not.toHaveProperty("source");
  });

  it("filters on the text a reader can see", async () => {
    const body = await payload("?q=ocean");
    expect(body.items.map((photo) => photo.id)).toEqual(["ocean-at-sunset"]);
    expect(body.total).toBe(1);
  });

  it("matches case-insensitively and against the caption, not just the title", async () => {
    const body = await payload("?q=SNOW");
    expect(body.items.map((photo) => photo.id)).toEqual([
      "stars-over-the-range",
    ]);
  });

  it("answers 200 with an empty list rather than 404 when nothing matches", async () => {
    const response = await get("?q=definitely-not-in-the-catalogue");
    expect(response.status).toBe(200);

    const body = (await response.json()) as PhotoListPayload;
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("truncates to the limit while reporting the untruncated total", async () => {
    const body = await payload("?limit=1");
    expect(body.items).toHaveLength(1);
    // `total` is what a client needs to know it did not see everything.
    expect(body.total).toBe(PHOTOS.length);
  });

  it("rejects a limit outside the allowed range", async () => {
    const response = await get("?limit=999");
    expect(response.status).toBe(422);

    const body = (await response.json()) as {
      error: { fieldErrors: Record<string, string[]> };
    };
    expect(Object.keys(body.error.fieldErrors)).toEqual(["query.limit"]);
  });

  it("rejects a non-numeric limit", async () => {
    expect((await get("?limit=lots")).status).toBe(422);
  });

  it("rejects an over-long search term", async () => {
    expect((await get(`?q=${"x".repeat(101)}`)).status).toBe(422);
  });
});
