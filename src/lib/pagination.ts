export const DEFAULT_PAGE_LIMIT = 10;
export const MAX_PAGE_LIMIT = 100;

export interface CursorPageParams {
  cursor?: string;
  limit: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function parseCursorParams(searchParams: URLSearchParams): CursorPageParams {
  const rawCursor = searchParams.get("cursor");
  const rawLimit = searchParams.get("limit");
  const parsed = rawLimit ? parseInt(rawLimit, 10) : NaN;
  const limit = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 1), MAX_PAGE_LIMIT)
    : DEFAULT_PAGE_LIMIT;
  return rawCursor ? { cursor: rawCursor, limit } : { limit };
}

export function buildCursorPage<T extends { id: string }>(
  rawItems: T[],
  limit: number,
): CursorPage<T> {
  const hasMore = rawItems.length > limit;
  const items = hasMore ? rawItems.slice(0, limit) : rawItems;
  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? lastItem.id : null;
  return { items, nextCursor, hasMore };
}

export async function paginateQuery<T extends { id: string }>(
  queryFn: (args: { take: number; skip?: number; cursor?: { id: string } }) => Promise<T[]>,
  params: CursorPageParams,
): Promise<CursorPage<T>> {
  const { cursor, limit } = params;
  const rawItems = await queryFn({
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  return buildCursorPage(rawItems, limit);
}
