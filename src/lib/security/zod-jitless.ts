/**
 * Stops Zod from probing for `eval` in the browser.
 *
 * ## The measurement
 *
 * With the policy enforced and no `'unsafe-eval'` in `script-src`, the landing
 * page reported exactly one violation — `script-src blocked eval` — from a
 * shared chunk, on every page load. Traced by patching `window.Function` and
 * reading the stack: `$ZodObjectJIT`, Zod v4's JIT-compiled object validator.
 * Constructing a `z.object()` evaluates `util.allowsEval`, which is
 * `try { new Function("") } catch { return false }` — a capability probe.
 *
 * Nothing breaks. The throw is caught, Zod falls back to its interpreted path,
 * and the page hydrates: the theme toggle works, no `pageerror` is raised, every
 * other script runs. What it costs is the report. A browser fires
 * `securitypolicyviolation` and logs to the console for a *caught* `eval` just as
 * it does for a real injection, so a deployment with a reporting endpoint gets
 * one violation per page view, indistinguishable at the receiving end from
 * something worth waking up for. A signal that fires on every page view is a
 * signal nobody reads, which is how the real one gets missed.
 *
 * ## Why this and not `'unsafe-eval'`
 *
 * The one-word alternative is to allow `eval` in production, which trades the
 * strongest half of the policy for a quieter console. Zod's own source says what
 * to do instead — the escape hatch exists for this exact case:
 *
 *   // Skip the probe under `jitless`: strict CSPs report the caught
 *   // `new Function` as a `securitypolicyviolation` even though the throw is
 *   // swallowed.
 *
 * ## Why a call rather than an import side effect
 *
 * `allowsEval` is memoised and read when a schema is *constructed*, not when it
 * parses, so the configuration has to be in place before the module-scope
 * `z.object(…)` below it runs. A bare `import "@/lib/security/zod-jitless"`
 * would depend on import order to achieve that, which is a property nobody can
 * see at the call site and a bundler is free to rearrange. An explicit call
 * above the schema is ordered by the language, and
 * `scripts/assert-csp.ts` checks that every module in the client graph that
 * imports Zod makes it, above its first schema.
 *
 * Browser-only, deliberately: the server has no CSP to violate and the JIT
 * fast-path is worth keeping for the route handlers and Server Actions that
 * validate real payloads.
 */
import { z } from "zod";

export function disableZodJitInBrowser(): void {
  if (typeof window === "undefined") return;
  z.config({ jitless: true });
}
