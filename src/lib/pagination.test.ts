import { describe, it, expect, vi } from "vitest";
import {
  parseCursorParams,
  buildCursorPage,
  paginateQuery,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "./pagination";

type Item = { id: string; name: string };

const makeItems = (count: number): Item[] =>
  Array.from({ length: count }, (_, i) => ({ id: `item-${i + 1}`, name: `Item ${i + 1}` }));

describe("parseCursorParams", () => {
  it("returns DEFAULT_PAGE_LIMIT when limit is absent", () => {
    const params = parseCursorParams(new URLSearchParams());
    expect(params.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(params.cursor).toBeUndefined();
  });

  it("parses limit from query string", () => {
    const params = parseCursorParams(new URLSearchParams("limit=25"));
    expect(params.limit).toBe(25);
  });

  it("parses cursor from query string", () => {
    const params = parseCursorParams(new URLSearchParams("cursor=abc123&limit=5"));
    expect(params.cursor).toBe("abc123");
    expect(params.limit).toBe(5);
  });

  it("clamps limit to 1 at minimum", () => {
    const params = parseCursorParams(new URLSearchParams("limit=0"));
    expect(params.limit).toBe(1);
  });

  it("clamps limit to MAX_PAGE_LIMIT at maximum", () => {
    const params = parseCursorParams(new URLSearchParams(`limit=${MAX_PAGE_LIMIT + 50}`));
    expect(params.limit).toBe(MAX_PAGE_LIMIT);
  });

  it("falls back to DEFAULT_PAGE_LIMIT for non-numeric limit", () => {
    const params = parseCursorParams(new URLSearchParams("limit=bad"));
    expect(params.limit).toBe(DEFAULT_PAGE_LIMIT);
  });

  it("returns undefined cursor when cursor param is absent", () => {
    const params = parseCursorParams(new URLSearchParams("limit=10"));
    expect(params.cursor).toBeUndefined();
  });
});

describe("buildCursorPage", () => {
  it("returns all items when count <= limit and hasMore false", () => {
    const items = makeItems(5);
    const page = buildCursorPage(items, 10);
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("returns limit items and sets nextCursor when rawItems > limit", () => {
    const items = makeItems(11);
    const page = buildCursorPage(items, 10);
    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("item-10");
  });

  it("returns empty page for empty input", () => {
    const page = buildCursorPage([], 10);
    expect(page.items).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("handles exactly limit items with hasMore false", () => {
    const items = makeItems(10);
    const page = buildCursorPage(items, 10);
    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

describe("paginateQuery", () => {
  it("calls queryFn with take = limit + 1 and no cursor on first page", async () => {
    const queryFn = vi.fn().mockResolvedValue(makeItems(5));
    await paginateQuery(queryFn, { limit: 10 });
    expect(queryFn).toHaveBeenCalledWith({ take: 11 });
  });

  it("passes cursor and skip=1 on subsequent pages", async () => {
    const queryFn = vi.fn().mockResolvedValue(makeItems(3));
    await paginateQuery(queryFn, { cursor: "item-10", limit: 10 });
    expect(queryFn).toHaveBeenCalledWith({ take: 11, cursor: { id: "item-10" }, skip: 1 });
  });

  it("returns a CursorPage with hasMore=true when more items exist", async () => {
    const queryFn = vi.fn().mockResolvedValue(makeItems(11));
    const page = await paginateQuery(queryFn, { limit: 10 });
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("item-10");
    expect(page.items).toHaveLength(10);
  });

  it("returns a CursorPage with hasMore=false on last page", async () => {
    const queryFn = vi.fn().mockResolvedValue(makeItems(3));
    const page = await paginateQuery(queryFn, { limit: 10 });
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(3);
  });
});
