import { describe, it, expect } from "vitest";
import {
  API_ERROR_STATUS,
  ApiError,
  isApiErrorBody,
  isFrameworkSignal,
  toApiError,
} from "./errors";

describe("ApiError", () => {
  it("maps its code to a status", () => {
    expect(new ApiError("not_found", "gone").status).toBe(404);
    expect(new ApiError("internal_error", "boom").status).toBe(500);
  });

  it("omits fieldErrors from the body when there are none", () => {
    const body = new ApiError("forbidden", "nope").toBody();
    expect(body).toEqual({ error: { code: "forbidden", message: "nope" } });
    // Not merely undefined — the key must be absent, or it serialises into the
    // JSON as `"fieldErrors": null`-shaped noise clients have to handle.
    expect("fieldErrors" in body.error).toBe(false);
  });

  it("answers 422 with the field errors for a schema failure", async () => {
    const error = ApiError.fromFieldErrors("Invalid query", {
      "query.limit": ["too big"],
    });
    const response = error.toResponse();

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unprocessable_entity",
        message: "Invalid query",
        fieldErrors: { "query.limit": ["too big"] },
      },
    });
  });

  it("is an Error, so an unhandled one still has a stack", () => {
    const error = new ApiError("conflict", "clash");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
    expect(error.stack).toBeTruthy();
  });
});

describe("toApiError", () => {
  it("passes an ApiError through unchanged", () => {
    const original = new ApiError("not_found", "no such post");
    expect(toApiError(original)).toBe(original);
  });

  it("redacts anything else behind an opaque 500", () => {
    const leaky = new Error(
      'connect ECONNREFUSED postgresql://admin@10.0.0.4:5432/prod — table "users"',
    );
    const converted = toApiError(leaky);

    expect(converted.status).toBe(500);
    expect(converted.code).toBe("internal_error");
    expect(converted.message).toBe("Internal server error");
    expect(converted.message).not.toContain("postgresql");
  });

  it("survives a non-Error throw", () => {
    expect(toApiError("just a string").status).toBe(500);
    expect(toApiError(undefined).status).toBe(500);
  });
});

describe("isFrameworkSignal", () => {
  // The exact digests Next stamps on the throws that mean "control flow", each
  // one taken from the framework source rather than invented. `redirect()` and
  // `notFound()` carry arguments after a `;`; the prerender signals do not.
  it.each([
    ["NEXT_REDIRECT;replace;/login;307;", "redirect()"],
    ["NEXT_HTTP_ERROR_FALLBACK;404", "notFound()"],
    ["NEXT_PRERENDER_INTERRUPTED", "prerender interrupt"],
    ["DYNAMIC_SERVER_USAGE", "dynamic access during prerender"],
    ["HANGING_PROMISE_REJECTION", "headers() after the prerender completed"],
  ])("recognises %s (%s)", (digest) => {
    expect(
      isFrameworkSignal(Object.assign(new Error("signal"), { digest })),
    ).toBe(true);
  });

  it("recognises React's postpone object, which is not an Error", () => {
    expect(isFrameworkSignal({ $$typeof: Symbol.for("react.postpone") })).toBe(
      true,
    );
  });

  it("does not claim a plain application error", () => {
    expect(isFrameworkSignal(new Error("the database is on fire"))).toBe(false);
    expect(isFrameworkSignal(new ApiError("not_found", "gone"))).toBe(false);
  });

  it("does not claim React's numeric digest on a handled error", () => {
    // React stamps errors it has already reported with a hash. Swallowing those
    // would be correct; *rethrowing* them would escape the wrapper as an
    // unhandled 500 with no envelope, so the leading-letter rule matters.
    expect(
      isFrameworkSignal(
        Object.assign(new Error("boom"), { digest: "1611269335" }),
      ),
    ).toBe(false);
  });

  it("does not claim a lowercase digest", () => {
    expect(
      isFrameworkSignal(
        Object.assign(new Error("x"), { digest: "next_redirect" }),
      ),
    ).toBe(false);
  });

  it("survives null and primitives", () => {
    expect(isFrameworkSignal(null)).toBe(false);
    expect(isFrameworkSignal(undefined)).toBe(false);
    expect(isFrameworkSignal("NEXT_REDIRECT")).toBe(false);
  });
});

describe("isApiErrorBody", () => {
  it("accepts the envelope this module produces", () => {
    expect(isApiErrorBody(new ApiError("unauthorized", "nope").toBody())).toBe(
      true,
    );
  });

  it("rejects a success payload, including one with its own error field", () => {
    expect(isApiErrorBody({ items: [] })).toBe(false);
    expect(isApiErrorBody({ error: "Unauthorized" })).toBe(false);
    expect(isApiErrorBody({ error: { message: "no code" } })).toBe(false);
    expect(
      isApiErrorBody({ error: { code: "not_a_real_code", message: "x" } }),
    ).toBe(false);
    expect(isApiErrorBody(null)).toBe(false);
  });
});

describe("API_ERROR_STATUS", () => {
  it("maps every code to a 4xx or 5xx", () => {
    for (const status of Object.values(API_ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});
