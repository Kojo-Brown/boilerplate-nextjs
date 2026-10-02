import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { draftMode } from "next/headers";
import { signPreviewToken } from "@/lib/preview/token";
import { PREVIEW_SCOPE_COOKIE, verifyPreviewScope } from "@/lib/preview/scope";
import { isApiErrorBody } from "@/lib/api/errors";
import { GET, DELETE } from "./route";

/**
 * The redemption endpoint.
 *
 * Tokens are minted and verified with the real signer — a mocked one would let
 * every case below pass against a route that never checked anything, which is
 * the single failure this file exists to rule out.
 *
 * `draftMode()` is mocked, so `enable()` is observable as a call rather than as
 * a cookie. What that leaves untested here is whether Next actually attaches
 * the resulting `Set-Cookie` to a `NextResponse.redirect` — a framework
 * behaviour a unit test cannot honestly assert. `e2e/preview.spec.ts` drives it
 * through a real browser against a production build for exactly that reason.
 */
const mockDraftMode = vi.mocked(draftMode);
const enable = vi.fn();
const disable = vi.fn();

const TENANT = "tenant-mock-a";

/** `signPreviewToken` for a path, in the one workspace these tests mint in. */
function sign(
  path: string,
  options: Parameters<typeof signPreviewToken>[1] = {},
): Promise<string> {
  return signPreviewToken({ path, tenantId: TENANT }, options);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDraftMode.mockResolvedValue({
    isEnabled: false,
    enable,
    disable,
  } as unknown as Awaited<ReturnType<typeof draftMode>>);
});

function request(query = ""): NextRequest {
  return new NextRequest(
    new Request(`https://example.test/api/preview${query}`),
  );
}

async function errorCode(response: Response): Promise<string> {
  const body: unknown = await response.json();
  return isApiErrorBody(body) ? body.error.code : "not-an-error-envelope";
}

describe("GET /api/preview", () => {
  it("enables draft mode and redirects to the signed path", async () => {
    const token = await sign("/blog/post-1");

    const response = await GET(request(`?token=${token}`));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://example.test/blog/post-1",
    );
    expect(enable).toHaveBeenCalledOnce();
  });

  it("writes a signed scope cookie naming the token's workspace", async () => {
    // The other half of redemption, and the one the token alone cannot do: draft
    // mode is a boolean the framework owns, so the workspace has to be written
    // down somewhere the blog's reads can find it.
    const token = await sign("/blog/post-1");

    const response = await GET(request(`?token=${token}`));

    const cookie = response.cookies.get(PREVIEW_SCOPE_COOKIE);
    expect(cookie?.value).toBeDefined();
    expect(await verifyPreviewScope(cookie?.value as string)).toEqual({
      tenantId: TENANT,
    });
  });

  it("writes the scope cookie httpOnly, lax and at the site root", async () => {
    // It has to arrive and expire alongside `__prerender_bypass`; `path` is the
    // one that bites quietly, because a cookie set at `/api/preview` is invisible
    // to `/blog` and the session would be permanently unscoped.
    const token = await sign("/blog/post-1");

    const response = await GET(request(`?token=${token}`));

    expect(response.cookies.get(PREVIEW_SCOPE_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("re-points an existing draft session at the newly redeemed workspace", async () => {
    // Redeeming a second link overwrites the scope rather than adding to it: a
    // preview is of one workspace, and two cookies cannot both be the answer.
    const token = await signPreviewToken({
      path: "/blog/post-1",
      tenantId: "tenant-mock-b",
    });

    const response = await GET(request(`?token=${token}`));

    expect(
      await verifyPreviewScope(
        response.cookies.get(PREVIEW_SCOPE_COOKIE)?.value as string,
      ),
    ).toEqual({ tenantId: "tenant-mock-b" });
  });

  it("ignores a redirect target supplied in the query string", async () => {
    // The hole in the canonical draft-mode recipe: there, the destination is
    // read from the URL, so any preview link is a redirect oracle. Here it can
    // only come out of the verified payload.
    const token = await sign("/blog/post-1");

    const response = await GET(
      request(`?token=${token}&redirect=https://evil.example`),
    );

    expect(response.headers.get("location")).toBe(
      "https://example.test/blog/post-1",
    );
  });

  it("answers 400 when no token is supplied", async () => {
    const response = await GET(request());

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
    expect(enable).not.toHaveBeenCalled();
  });

  it("answers 401 for a corrupted signature, and does not enable draft mode", async () => {
    const token = await sign("/blog/post-1");
    const [payload, signature] = token.split(".") as [string, string];

    // The *first* character, not the last. A 32-byte HMAC is 43 base64url
    // characters — 258 bits — so the final character carries four significant
    // bits and two of padding, and canonical encoding always leaves those two
    // at zero. Flipping it between "A" (000000) and "B" (000001) changes only a
    // padding bit, so the "forgery" decodes to the identical 32 bytes and
    // verifies. This test used to do exactly that, and failed with 307 instead
    // of 401 whenever a signature happened to end in "A" — 18 times in 300
    // when measured. Every bit of the first character is signature.
    const corrupted = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;

    const response = await GET(request(`?token=${payload}.${corrupted}`));

    expect(response.status).toBe(401);
    expect(enable).not.toHaveBeenCalled();
  });

  it("answers 401 for a real signature over a different payload", async () => {
    // The property a corrupted-byte test cannot state: the signature is bound
    // to *this* payload. Here both halves are authentic and only the pairing is
    // not, which is the shape a forgery actually takes — an attacker holding
    // one valid preview link and wanting it to authorise a different path.
    const [payload] = (await sign("/blog/post-1")).split(".") as [
      string,
      string,
    ];
    const [, signature] = (await sign("/blog/post-2")).split(".") as [
      string,
      string,
    ];

    const response = await GET(request(`?token=${payload}.${signature}`));

    expect(response.status).toBe(401);
    expect(enable).not.toHaveBeenCalled();
  });

  it("answers 401 for a malformed token", async () => {
    const response = await GET(request("?token=nonsense"));

    expect(response.status).toBe(401);
    expect(enable).not.toHaveBeenCalled();
  });

  it("writes no scope cookie on any rejection", async () => {
    // A refused request must leave the browser exactly as it was. The scope
    // cookie is minted before `enable()` for this reason: a failure there would
    // otherwise leave a draft session with nothing to read.
    const responses = await Promise.all([
      GET(request()),
      GET(request("?token=nonsense")),
      GET(request("?token=abc.def")),
    ]);

    for (const response of responses) {
      expect(response.cookies.get(PREVIEW_SCOPE_COOKIE)).toBeUndefined();
    }
  });

  it("answers 401 for a token whose workspace was re-pointed", async () => {
    // The tenant is inside the signature, so this is a forgery rather than a
    // re-aim: without it, one leaked link would be a reader for every workspace.
    const token = await sign("/blog/post-1");
    const [payload, signature] = token.split(".") as [string, string];
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
    const repointed = btoa(
      JSON.stringify({
        ...(decoded as Record<string, unknown>),
        tenantId: "tenant-mock-b",
      }),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");

    const response = await GET(request(`?token=${repointed}.${signature}`));

    expect(response.status).toBe(401);
    expect(enable).not.toHaveBeenCalled();
    expect(response.cookies.get(PREVIEW_SCOPE_COOKIE)).toBeUndefined();
  });

  it("tells a forged token and a malformed one apart to nobody", async () => {
    // Same status, same message. The two failures differ only in what someone
    // probing the endpoint would learn from being told them apart.
    const malformed = await GET(request("?token=nonsense"));
    const truncated = await GET(request("?token=abc.def"));

    expect(await malformed.json()).toEqual(await truncated.json());
  });

  it("says so when a token has expired, because the holder is usually an author", async () => {
    const expired = await sign("/blog/post-1", {
      now: new Date(Date.now() - 3_600_000),
      ttlSeconds: 60,
    });

    const response = await GET(request(`?token=${expired}`));

    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    expect(isApiErrorBody(body) && body.error.message).toMatch(/expired/i);
    expect(enable).not.toHaveBeenCalled();
  });

  it("answers the API's error envelope on every rejection", async () => {
    const responses = await Promise.all([
      GET(request()),
      GET(request("?token=nonsense")),
      GET(request("?token=")),
    ]);

    for (const response of responses) {
      expect(isApiErrorBody(await response.json())).toBe(true);
    }
  });
});

describe("DELETE /api/preview", () => {
  it("disables draft mode and reports it", async () => {
    const response = await DELETE();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ previewing: false });
    expect(disable).toHaveBeenCalledOnce();
  });

  it("clears the scope cookie as well as the session", async () => {
    // Both, because a scope left behind outlives the session it scopes. Cleared
    // with the `path` it was set with: a browser matches a deletion on name and
    // path, so a bare name leaves the cookie in place everywhere but here.
    const response = await DELETE();

    const cleared = response.cookies.get(PREVIEW_SCOPE_COOKIE);
    expect(cleared?.value).toBe("");
    expect(cleared?.maxAge).toBe(0);
    expect(cleared?.path).toBe("/");
  });

  it("needs no token — it only clears the caller's own cookie", async () => {
    // Requiring one would leave an author whose link had expired unable to get
    // out of draft mode.
    await expect(DELETE()).resolves.toBeDefined();
  });
});
