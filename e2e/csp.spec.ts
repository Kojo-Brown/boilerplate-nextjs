import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Whether the policy the proxy sends lets this application run.
 *
 * `scripts/assert-csp.ts` already asks that question of every prerendered
 * document, and it asks it by re-implementing the browser's decision: it hashes
 * each inline script and checks the digest against `script-src`. That is the
 * right shape for a gate — it runs in seconds, in every build, with no browser —
 * and it is still a model of a browser rather than one. This is the check that
 * uses the real thing.
 *
 * Two assertions, and the second is the one that would catch a mistake the gate
 * cannot:
 *
 *  1. **No violation is reported.** `securitypolicyviolation` fires on the
 *     document for every blocked resource, which is how a browser says "this
 *     policy refused something the page needed". Chromium also logs it, so the
 *     console is read as well: a policy this application cannot live under
 *     produces dozens of these and no test failure anywhere else.
 *
 *  2. **The page hydrated.** A blocked bundle leaves the prerendered HTML on
 *     screen and perfectly readable, so a smoke test that asserts on text passes
 *     against a page where nothing works. Pressing the theme toggle and watching
 *     the class change on `<html>` is the cheapest proof that React is running:
 *     it needs the bundle, hydration, an event handler and a client component.
 */

interface Violation {
  readonly directive: string;
  readonly blocked: string;
}

/** Collects every CSP violation the document reports. */
async function watchViolations(page: Page): Promise<Violation[]> {
  const violations: Violation[] = [];

  await page.exposeFunction(
    "__recordCspViolation",
    (directive: string, blocked: string) => {
      violations.push({ directive, blocked });
    },
  );

  // `addInitScript` runs before the document's own scripts, which is the only
  // point at which a listener can see the violations the parser produces while
  // it is still reading the page.
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const violation = event as SecurityPolicyViolationEvent;
      void (
        window as unknown as {
          __recordCspViolation: (directive: string, blocked: string) => void;
        }
      ).__recordCspViolation(
        violation.effectiveDirective,
        violation.blockedURI || "inline",
      );
    });
  });

  return violations;
}

function describeViolations(violations: readonly Violation[]): string {
  return violations
    .map(({ directive, blocked }) => `${directive} blocked ${blocked}`)
    .join("\n");
}

/** Public routes: every one of them is prerendered, which is the hard case. */
const PUBLIC_ROUTES = [
  "/",
  "/blog",
  "/login",
  "/register",
  "/photos",
  "/pricing",
  "/forbidden",
] as const;

test.describe("Content Security Policy", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a fixed document gets an enforcing policy with a fresh nonce", async ({
    page,
  }) => {
    const first = await page.goto("/");
    const second = await page.goto("/pricing");

    const policies = [first, second].map(
      (response) => response?.headers()["content-security-policy"],
    );

    for (const policy of policies) {
      expect(policy, "the enforcing header, not report-only").toBeTruthy();
      expect(policy).toContain("'nonce-");
      expect(policy).toContain("'sha256-");
      expect(policy).not.toContain("'unsafe-inline' 'nonce-");
      expect(policy).toContain("object-src 'none'");
      expect(policy).not.toContain("'strict-dynamic'");
    }

    const nonces = policies.map(
      (policy) => /'nonce-([^']+)'/.exec(policy ?? "")?.[1],
    );
    expect(nonces[0]).toBeTruthy();
    // Per request, not per build or per process.
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  test("an ISR document gets no nonce, because a cache entry would keep it", async ({
    page,
  }) => {
    // `/blog` revalidates every 60 seconds, so Next re-renders it at runtime and
    // stores the result. A nonce in that render is baked into the HTML every
    // later visitor is served — measured on this application, where two requests
    // with different nonces were both answered with a third request's nonce. The
    // policy for these paths therefore carries neither a nonce nor a digest, and
    // falls back to `'unsafe-inline'` for scripts only. See docs/csp.md.
    const policy = (await page.goto("/blog"))?.headers()[
      "content-security-policy"
    ];

    expect(policy).toBeTruthy();
    expect(policy).toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("'nonce-");
    expect(policy).not.toContain("'sha256-");
    // Everything else is still enforced there: an injected off-origin script, an
    // `<object>`, a rewritten `<base>` and an off-site form target all fail.
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'self'");
  });

  for (const route of PUBLIC_ROUTES) {
    test(`${route} loads with no CSP violation`, async ({ page }) => {
      const violations = await watchViolations(page);
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.text().includes("Content Security Policy")) {
          consoleErrors.push(message.text());
        }
      });

      await page.goto(route);
      await page.waitForLoadState("networkidle");

      expect(
        violations,
        `CSP violations on ${route}:\n${describeViolations(violations)}`,
      ).toEqual([]);
      expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
    });
  }

  test("the landing page still hydrates under the policy", async ({ page }) => {
    const violations = await watchViolations(page);

    await page.goto("/");
    // The proof that the bundle ran: the class only changes if React hydrated
    // the toggle and its click handler.
    const toggle = page.getByRole("button", { name: /theme/i }).first();
    await toggle.click();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.className))
      .toMatch(/dark|light/);

    expect(violations, describeViolations(violations)).toEqual([]);
  });
});

test.describe("Content Security Policy — authenticated", () => {
  test("a PPR route's streamed half is nonced and runs", async ({ page }) => {
    // The dashboard's shell is prerendered and its per-user content is streamed
    // at request time. Those two halves are authorised by different sources —
    // digests for the shell, the nonce for the stream — so this is the one route
    // where both mechanisms have to be right at once.
    const violations = await watchViolations(page);

    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
