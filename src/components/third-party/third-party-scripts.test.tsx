import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThirdPartyScripts } from "./third-party-scripts";
import { PLAUSIBLE_SCRIPT_SRC } from "@/lib/third-party/catalogue";

/**
 * `next/script` is replaced with a component that records what it was handed.
 *
 * The real one loads a script into a document, which is neither interesting
 * here nor possible in jsdom. What this component is responsible for is the
 * arguments: the source and the strategy come from the catalogue rather than
 * from a literal typed into this file, and `data-*` attributes reach the tag
 * the vendor reads them off. Those are exactly what the stand-in captures.
 */
vi.mock("next/script", () => ({
  default: (props: Record<string, unknown>) => (
    <div
      data-testid="next-script"
      data-src={String(props["src"])}
      data-strategy={String(props["strategy"])}
      data-domain={props["data-domain"] as string | undefined}
    />
  ),
}));

/**
 * Rendered on the server rather than into jsdom, because that is where it runs.
 *
 * It is a Server Component — the selection of what a deployment loads happens
 * during the server render and never reaches the browser as configuration — and
 * server rendering also keeps each case's `<link>` elements in its own output
 * string. Rendering into a document instead would have React hoist them into a
 * `<head>` shared by every test in the file, where a hint emitted by one case
 * is still present during the next.
 */
function markup(config: Parameters<typeof ThirdPartyScripts>[0]["config"]) {
  return renderToStaticMarkup(<ThirdPartyScripts config={config} />);
}

describe("ThirdPartyScripts", () => {
  it("mounts no script when analytics is not configured", () => {
    // The default everywhere: a fresh clone, CI, and every preview deployment.
    expect(markup({})).not.toContain("next-script");
  });

  it("does not warm an analytics origin it never contacts", () => {
    expect(markup({})).not.toContain("plausible.io");
  });

  it("still warms the image CDN, which every gallery page uses", () => {
    const html = markup({});
    expect(html).toContain('rel="preconnect"');
    expect(html).toContain("https://images.unsplash.com");
  });

  it("mounts the analytics script once configured", () => {
    const html = markup({ plausibleDomain: "app.example.com" });
    expect(html).toContain(PLAUSIBLE_SCRIPT_SRC);
    expect(html).toContain('data-domain="app.example.com"');
  });

  it("takes the strategy from the catalogue rather than a literal", () => {
    const html = markup({ plausibleDomain: "app.example.com" });
    expect(html).toContain('data-strategy="afterInteractive"');
  });

  it("warms the analytics origin only when the script is mounted", () => {
    expect(markup({ plausibleDomain: "app.example.com" })).toContain(
      "https://plausible.io",
    );
  });

  it("never emits a hint for the facade's origin", () => {
    // Asserted here as well as in the catalogue's own tests because this is
    // the component that would emit it. `scripts/assert-third-party-scripts.ts`
    // fails the build on the declaration; this fails on the output.
    const html = markup({ plausibleDomain: "app.example.com" });
    expect(html).not.toContain("youtube-nocookie");
  });

  it("never emits a hint for a wildcard host", () => {
    const html = markup({ plausibleDomain: "app.example.com" });
    expect(html).not.toContain("googleusercontent");
  });

  it("marks the preconnect as anonymous so the connection is reusable", () => {
    // A preconnect without `crossorigin` opens a connection in the
    // uncredentialed pool; a CORS request cannot reuse it and opens a second.
    // Getting this wrong costs a handshake instead of saving one.
    expect(markup({})).toContain('crossorigin=""');
  });
});
