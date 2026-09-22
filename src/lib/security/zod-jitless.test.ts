import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { disableZodJitInBrowser } from "@/lib/security/zod-jitless";

afterEach(() => {
  z.config({ jitless: false });
  vi.unstubAllGlobals();
});

/**
 * A browser, as far as this module can tell.
 *
 * `.test.ts` files run in the node environment — see vitest.config.ts — so the
 * global has to be supplied rather than assumed. The check under test is
 * `typeof window === "undefined"`, which is the only thing about a browser that
 * matters here.
 */
function inBrowser(): void {
  vi.stubGlobal("window", {});
}

describe("disableZodJitInBrowser", () => {
  it("turns the JIT off when there is a window", () => {
    inBrowser();
    disableZodJitInBrowser();
    expect(z.config().jitless).toBe(true);
  });

  it("leaves the JIT on with no window", () => {
    // The server keeps the fast path: there is no CSP to violate there, and the
    // route handlers and Server Actions validate real payloads.
    vi.stubGlobal("window", undefined);
    disableZodJitInBrowser();
    expect(z.config().jitless).toBeFalsy();
  });

  it("stops Zod probing for eval when a schema is built", () => {
    inBrowser();
    // The whole point, asserted the way it was found: Zod calls `new Function("")`
    // inside a `try` while *constructing* a `z.object()`, which a strict CSP
    // reports as a `script-src` violation even though the throw is swallowed.
    const probes: string[] = [];
    const real = globalThis.Function;
    vi.stubGlobal(
      "Function",
      new Proxy(real, {
        construct(target, args: unknown[]) {
          probes.push(String(args[0] ?? ""));
          return Reflect.construct(target, args as never[]);
        },
        apply(target, thisArg, args: unknown[]) {
          probes.push(String(args[0] ?? ""));
          return Reflect.apply(target, thisArg, args as never[]);
        },
      }),
    );

    disableZodJitInBrowser();
    z.object({ id: z.string() }).safeParse({ id: "x" });

    expect(probes).toEqual([]);
  });
});
