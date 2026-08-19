import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import { defineRoute } from "./define-route";
import { ApiError } from "./errors";

function request(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new Request(url, init));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("defineRoute", () => {
  it("serialises the handler's return value as the success payload", async () => {
    const GET = defineRoute<{ hello: string }>({
      handler: () => ({ hello: "world" }),
    });

    const response = await GET(request("https://example.test/api/thing"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ hello: "world" });
  });

  it("awaits an async handler", async () => {
    const GET = defineRoute<number[]>({
      handler: async () => Promise.resolve([1, 2]),
    });
    await expect(
      (await GET(request("https://example.test/api/thing"))).json(),
    ).resolves.toEqual([1, 2]);
  });

  it("honours a declared success status", async () => {
    const POST = defineRoute<{ id: string }>({
      status: 201,
      handler: () => ({ id: "new" }),
    });
    expect((await POST(request("https://example.test/api/thing"))).status).toBe(
      201,
    );
  });
});

describe("defineRoute query parsing", () => {
  const GET = defineRoute<{ limit: number }, { limit: number }>({
    query: z.object({ limit: z.coerce.number().int().min(1).max(10) }),
    handler: ({ query }) => ({ limit: query.limit }),
  });

  it("coerces and hands the parsed query to the handler", async () => {
    const response = await GET(
      request("https://example.test/api/thing?limit=7"),
    );
    await expect(response.json()).resolves.toEqual({ limit: 7 });
  });

  it("answers 422 with the offending field prefixed by its source", async () => {
    const response = await GET(
      request("https://example.test/api/thing?limit=99"),
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: {
        code: string;
        message: string;
        fieldErrors: Record<string, string[]>;
      };
    };
    expect(body.error.code).toBe("unprocessable_entity");
    expect(body.error.message).toBe("Invalid query");
    // Prefixed, so a request that is wrong in the query *and* the body does not
    // return two identically-keyed maps the client cannot tell apart.
    expect(Object.keys(body.error.fieldErrors)).toEqual(["query.limit"]);
  });

  it("reports a whole-schema failure under the input name rather than an empty map", async () => {
    const Strict = defineRoute<string, { a: string; b: string }>({
      query: z
        .object({ a: z.string(), b: z.string() })
        .refine((value) => value.a !== value.b, {
          message: "a and b must differ",
        }),
      handler: () => "ok",
    });

    const response = await Strict(
      request("https://example.test/api/thing?a=x&b=x"),
    );
    const body = (await response.json()) as {
      error: { fieldErrors: Record<string, string[]> };
    };

    expect(response.status).toBe(422);
    expect(body.error.fieldErrors).toEqual({ query: ["a and b must differ"] });
  });

  it("does not touch searchParams when no query schema is declared", async () => {
    // The regression this pins: reading `nextUrl.searchParams` unconditionally
    // is a dynamic access, and it made even a route that reads nothing bail out
    // of prerendering — which showed up as four routes "failing" with a 500
    // during `pnpm build`.
    const req = request("https://example.test/api/health?ignored=1");
    const searchParams = vi.spyOn(req.nextUrl, "searchParams", "get");

    const GETHealth = defineRoute<{ status: string }>({
      handler: () => ({ status: "ok" }),
    });
    await GETHealth(req);

    expect(searchParams).not.toHaveBeenCalled();
  });
});

describe("defineRoute params parsing", () => {
  const GET = defineRoute<string, undefined, { id: string }>({
    params: z.object({ id: z.string().min(1) }),
    handler: ({ params }) => params.id,
  });

  it("parses the awaited route params", async () => {
    const response = await GET(request("https://example.test/api/thing/abc"), {
      params: Promise.resolve({ id: "abc" }),
    });
    await expect(response.json()).resolves.toBe("abc");
  });

  it("answers 422 when a dynamic segment is missing or renamed", async () => {
    const response = await GET(request("https://example.test/api/thing/abc"), {
      params: Promise.resolve({ slug: "abc" }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { fieldErrors: Record<string, string[]> };
    };
    expect(Object.keys(body.error.fieldErrors)).toEqual(["params.id"]);
  });
});

describe("defineRoute body parsing", () => {
  const POST = defineRoute<
    { title: string },
    undefined,
    undefined,
    { title: string }
  >({
    body: z.object({ title: z.string().min(3) }),
    handler: ({ body }) => ({ title: body.title }),
  });

  const post = (body: string): NextRequest =>
    request("https://example.test/api/thing", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });

  it("parses a valid JSON body", async () => {
    const response = await POST(post(JSON.stringify({ title: "hello" })));
    await expect(response.json()).resolves.toEqual({ title: "hello" });
  });

  it("answers 422 when the body fails the schema", async () => {
    const response = await POST(post(JSON.stringify({ title: "no" })));
    expect(response.status).toBe(422);
  });

  it("answers 400 — not 422 — when the body is not JSON at all", async () => {
    // Nothing to validate and no field to blame, so this is a different failure
    // from a schema rejection and gets a different status.
    const response = await POST(post("<xml/>"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("does not read the body when no body schema is declared", async () => {
    const GET = defineRoute<string>({ handler: () => "ok" });
    const req = post("not json at all");
    const json = vi.spyOn(req, "json");

    expect((await GET(req)).status).toBe(200);
    expect(json).not.toHaveBeenCalled();
  });
});

describe("defineRoute error handling", () => {
  it("answers a thrown ApiError with its own status and message", async () => {
    const GET = defineRoute<never>({
      handler: () => {
        throw new ApiError("not_found", "No such post");
      },
    });

    const response = await GET(request("https://example.test/api/thing"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "No such post" },
    });
  });

  it("does not log a considered ApiError", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const GET = defineRoute<never>({
      handler: () => {
        throw new ApiError("forbidden", "nope");
      },
    });

    await GET(request("https://example.test/api/thing"));
    expect(error).not.toHaveBeenCalled();
  });

  it("answers an unexpected throw with an opaque 500 and logs the original", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const leak = new Error('relation "users" does not exist');
    const GET = defineRoute<never>({
      handler: () => {
        throw leak;
      },
    });

    const response = await GET(request("https://example.test/api/thing"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    // Redacted on the wire, but not lost: this log is the only remaining record.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("/api/thing"),
      leak,
    );
  });

  it("rethrows a framework control-flow signal instead of answering it", async () => {
    const signal = Object.assign(new Error("bail out"), {
      digest: "NEXT_PRERENDER_INTERRUPTED",
    });
    const GET = defineRoute<never>({
      handler: () => {
        throw signal;
      },
    });

    // Catching this is what denied Next the signal it uses to decide a route is
    // dynamic. It has to leave the wrapper untouched.
    await expect(GET(request("https://example.test/api/thing"))).rejects.toBe(
      signal,
    );
  });

  it("rethrows redirect() rather than turning it into a 500", async () => {
    const redirect = Object.assign(new Error("redirect"), {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    const GET = defineRoute<never>({
      handler: () => {
        throw redirect;
      },
    });

    await expect(GET(request("https://example.test/api/thing"))).rejects.toBe(
      redirect,
    );
  });
});
