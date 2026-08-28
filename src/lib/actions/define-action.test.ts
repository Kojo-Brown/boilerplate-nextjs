import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { redirect } from "next/navigation";
import {
  INVALID_INPUT_MESSAGE,
  UNEXPECTED_ERROR_MESSAGE,
  defineAction,
  defineFormAction,
  defineNavigationAction,
  formDataToObject,
} from "@/lib/actions/define-action";
import { ActionError } from "@/lib/actions/result";
import { ORIGIN_REJECTED_MESSAGE } from "@/lib/actions/origin";
import { setRequestHeaders } from "@/test/request-headers";

const CROSS_ORIGIN = {
  origin: "https://evil.example",
  host: "localhost:3000",
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("defineAction", () => {
  const echo = defineAction({
    name: "echo",
    input: z.object({ title: z.string().min(1, "Title is required") }),
    handler: ({ input }) => ({ echoed: input.title }),
  });

  it("returns the handler's value on success", async () => {
    await expect(echo({ title: "hello" })).resolves.toEqual({
      success: true,
      data: { echoed: "hello" },
    });
  });

  it("rejects a cross-origin request before the handler runs", async () => {
    const handler = vi.fn();
    const action = defineAction({
      name: "guarded",
      input: z.object({}),
      handler,
    });
    setRequestHeaders(CROSS_ORIGIN);

    await expect(action({})).resolves.toEqual({
      success: false,
      error: ORIGIN_REJECTED_MESSAGE,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("parses the input, whatever the call site's type said", async () => {
    // The declared parameter type is a compile-time convenience. What actually
    // arrives came over the network, so the cast below is what a hostile caller
    // does for free.
    const result = await echo({ title: 42 } as unknown as { title: string });

    expect(result.success).toBe(false);
    // The message is Zod's own type error rather than the `.min(1)` one — a
    // number never reaches the length check. What is being pinned down is that
    // the value was rejected at all, which is the part the signature could not
    // do on its own.
    expect(result.success === false && result.fieldErrors).toEqual({
      title: [expect.stringMatching(/expected string/i)],
    });
  });

  it("reports a lone issue as itself, so a toast can show it", async () => {
    const result = await echo({ title: "" });

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toBe("Title is required");
  });

  it("falls back to the generic sentence when several fields failed", async () => {
    const action = defineAction({
      name: "two",
      input: z.object({ a: z.string(), b: z.string() }),
      handler: () => null,
    });

    const result = await action({} as unknown as { a: string; b: string });

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toBe(
      INVALID_INPUT_MESSAGE,
    );
    expect(
      result.success === false && Object.keys(result.fieldErrors ?? {}),
    ).toEqual(["a", "b"]);
  });

  it("keys a whole-schema failure under `_` rather than dropping it", async () => {
    const action = defineAction({
      name: "scalar",
      input: z.string().min(3, "Too short"),
      handler: (context) => context.input,
    });

    await expect(action("ab")).resolves.toEqual({
      success: false,
      error: "Too short",
      fieldErrors: { _: ["Too short"] },
    });
  });

  it("turns an ActionError into the failure half, verbatim", async () => {
    const action = defineAction({
      name: "decides",
      input: z.object({}),
      handler: () => {
        throw new ActionError("Post not found.");
      },
    });

    await expect(action({})).resolves.toEqual({
      success: false,
      error: "Post not found.",
    });
  });

  it("replaces an unexpected throw and logs the original", async () => {
    const action = defineAction({
      name: "explodes",
      input: z.object({}),
      handler: () => {
        throw new Error(
          'relation "User" does not exist at postgres://user:hunter2@db',
        );
      },
    });

    const result = await action({});

    // The caller must not learn the connection string.
    expect(result).toEqual({ success: false, error: UNEXPECTED_ERROR_MESSAGE });
    expect(console.error).toHaveBeenCalledWith(
      "[action] explodes failed:",
      expect.any(Error),
    );
  });

  it("lets a framework signal through untouched", async () => {
    // `redirect()` communicates by throwing. Swallowing it here would turn a
    // navigation into a silent no-op.
    const signal = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    const action = defineAction({
      name: "navigates",
      input: z.object({}),
      handler: () => {
        throw signal;
      },
    });

    await expect(action({})).rejects.toBe(signal);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("formDataToObject", () => {
  it("reads scalar fields", () => {
    const form = new FormData();
    form.set("email", "user@example.test");

    expect(formDataToObject(form)).toEqual({ email: "user@example.test" });
  });

  it("keeps every value of a repeated key", () => {
    // `Object.fromEntries` keeps the last one, which silently validates
    // something other than what was submitted.
    const form = new FormData();
    form.append("tag", "a");
    form.append("tag", "b");
    form.append("tag", "c");

    expect(formDataToObject(form)).toEqual({ tag: ["a", "b", "c"] });
  });

  it("is empty for an empty submission", () => {
    expect(formDataToObject(new FormData())).toEqual({});
  });
});

describe("defineFormAction", () => {
  const login = defineFormAction({
    name: "login",
    input: z.object({
      email: z.string().email("Invalid email address"),
      password: z.string().min(1, "Password is required"),
    }),
    handler: ({ input }) => input.email,
  });

  function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  it("parses the submission and runs the handler", async () => {
    await expect(
      login(null, form({ email: "a@example.test", password: "hunter2" })),
    ).resolves.toEqual({ success: true, data: "a@example.test" });
  });

  it("reports field errors the form can render", async () => {
    const result = await login(null, form({ email: "nope", password: "" }));

    expect(result).toEqual({
      success: false,
      error: INVALID_INPUT_MESSAGE,
      fieldErrors: {
        email: ["Invalid email address"],
        password: ["Password is required"],
      },
    });
  });

  it("checks the origin", async () => {
    setRequestHeaders(CROSS_ORIGIN);

    await expect(
      login(null, form({ email: "a@example.test", password: "hunter2" })),
    ).resolves.toEqual({ success: false, error: ORIGIN_REJECTED_MESSAGE });
  });

  it("ignores the previous result, which the client supplied", async () => {
    // Typed rather than `vi.fn(() => "ok")` so `mock.calls[0][0]` is a value
    // with a shape, which is what the last assertion is about.
    const handler = vi.fn(
      (_context: { input: Record<string, never>; formData: FormData }) => "ok",
    );
    const action = defineFormAction({
      name: "ignores",
      input: z.object({}),
      handler,
    });

    await action({ success: false, error: "anything at all" }, new FormData());

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ input: {} }),
    );
    // The previous result is whatever React sent back, so an action that could
    // branch on it would be branching on client-supplied state.
    expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("previous");
  });

  it("hands the raw FormData to the handler as an escape hatch", async () => {
    const action = defineFormAction({
      name: "raw",
      input: z.object({}),
      handler: ({ formData }) => formData.getAll("tag"),
    });

    const data = new FormData();
    data.append("tag", "a");
    data.append("tag", "b");

    await expect(action(null, data)).resolves.toEqual({
      success: true,
      data: ["a", "b"],
    });
  });
});

describe("defineNavigationAction", () => {
  const mockRedirect = vi.mocked(redirect);

  it("runs a handler that redirects", async () => {
    const action = defineNavigationAction({
      name: "leave",
      input: z.object({}),
      handler: () => {
        redirect("/login");
      },
    });

    await action(new FormData());

    expect(mockRedirect).toHaveBeenCalledWith("/login");
  });

  it("accepts being called with no FormData at all", async () => {
    const handler = vi.fn();
    const action = defineNavigationAction({
      name: "bare",
      input: z.object({}),
      handler,
    });

    await action();

    expect(handler).toHaveBeenCalledWith({ input: {} });
  });

  it("throws on a cross-origin post", async () => {
    const handler = vi.fn();
    const action = defineNavigationAction({
      name: "guarded",
      input: z.object({}),
      handler,
    });
    setRequestHeaders(CROSS_ORIGIN);

    // No result channel, so the refusal is a throw that reaches `error.tsx`.
    await expect(action(new FormData())).rejects.toThrow(
      ORIGIN_REJECTED_MESSAGE,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("throws rather than proceeding on unvalidated input", async () => {
    const handler = vi.fn();
    const action = defineNavigationAction({
      name: "strict",
      input: z.object({ to: z.string().min(1, "Required") }),
      handler,
    });

    await expect(action(new FormData())).rejects.toThrow(ActionError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("lets a schema state its own fallback with .catch()", async () => {
    const handler = vi.fn();
    const action = defineNavigationAction({
      name: "tolerant",
      input: z.object({ to: z.string().min(1).catch("/blog") }),
      handler,
    });

    await action(new FormData());

    expect(handler).toHaveBeenCalledWith({ input: { to: "/blog" } });
  });
});
