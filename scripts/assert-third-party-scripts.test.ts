import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOGUE_MODULE,
  NEXT_CONFIG,
  ROOT_LAYOUT,
  checkImageHosts,
  checkMounts,
  checkNoRawScriptTags,
  checkPreconnectPolicy,
  checkScriptOwnership,
  checkScriptStrategies,
  checkSubresourceOrigins,
  collectSources,
  hostMatches,
  isWildcardHost,
  main,
  readIdConstants,
  readImageHostnames,
} from "./assert-third-party-scripts";
import type { SourceFile } from "./assert-third-party-scripts";
import type { ThirdParty } from "../src/lib/third-party/catalogue";

/**
 * Synthetic sources for the regressions, the real tree for the claim that the
 * repository satisfies its own audit. A gate that only ever passes on fixtures
 * is a gate nobody has pointed at anything.
 */
function file(relativePath: string, text: string): SourceFile {
  return { relativePath, text };
}

const REPO_ROOT = path.resolve(__dirname, "..");

function entry(overrides: Partial<ThirdParty> = {}): ThirdParty {
  return {
    id: "vendor",
    title: "Vendor",
    hosts: ["cdn.vendor.example"],
    loading: { mode: "script", strategy: "afterInteractive" },
    preconnect: false,
    mountedBy: "src/components/third-party/vendor.tsx",
    why: "a test fixture",
    ...overrides,
  };
}

describe("R1 — no hand-written <script>", () => {
  it("fails on a raw script tag", () => {
    const findings = checkNoRawScriptTags([
      file(
        "src/app/page.tsx",
        `export default function Page() {
          return <script src="https://cdn.vendor.example/a.js" />;
        }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R1");
    expect(findings[0]?.file).toBe("src/app/page.tsx");
  });

  it("allows JSON-LD, which is data rather than code", () => {
    expect(
      checkNoRawScriptTags([
        file(
          "src/app/page.tsx",
          `export default function Page() {
            return (
              <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
              />
            );
          }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("fails on a script smuggled through dangerouslySetInnerHTML", () => {
    const findings = checkNoRawScriptTags([
      file(
        "src/app/page.tsx",
        `export default function Page() {
          return (
            <div
              dangerouslySetInnerHTML={{
                __html: '<script src="https://cdn.vendor.example/a.js"></script>',
              }}
            />
          );
        }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R1");
  });

  it("ignores .ts modules, which have no JSX to inspect", () => {
    expect(
      checkNoRawScriptTags([
        file("src/lib/thing.ts", `export const html = "<script></script>";`),
      ]),
    ).toEqual([]);
  });
});

describe("R2 and R3 — strategy", () => {
  it("fails when <Script> is rendered without a strategy", () => {
    const findings = checkScriptStrategies([
      file(
        "src/components/third-party/vendor.tsx",
        `import Script from "next/script";

        export function Vendor() {
          return <Script src="https://cdn.vendor.example/a.js" />;
        }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R2");
  });

  it("accepts a strategy read from the catalogue rather than written out", () => {
    // The whole point of R2 is presence, not literalness: `strategy={…}` from
    // the inventory is the spelling the gate is trying to encourage, so it must
    // not be the spelling that fails.
    expect(
      checkScriptStrategies([
        file(
          "src/components/third-party/vendor.tsx",
          `import Script from "next/script";

          export function Vendor({ entry }) {
            return <Script src={entry.src} strategy={entry.strategy} />;
          }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("follows the local name next/script was imported under", () => {
    const findings = checkScriptStrategies([
      file(
        "src/components/third-party/vendor.tsx",
        `import NextScript from "next/script";

        export function Vendor() {
          return <NextScript src="https://cdn.vendor.example/a.js" />;
        }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R2");
  });

  it("does not mistake an unrelated <Script> for next/script's", () => {
    expect(
      checkScriptStrategies([
        file(
          "src/components/thing.tsx",
          `import { Script } from "./local-script";

          export function Thing() {
            return <Script />;
          }`,
        ),
      ]),
    ).toEqual([]);
  });

  it("fails on beforeInteractive outside the root layout", () => {
    const findings = checkScriptStrategies([
      file(
        "src/components/third-party/vendor.tsx",
        `import Script from "next/script";

        export function Vendor() {
          return (
            <Script
              src="https://cdn.vendor.example/a.js"
              strategy="beforeInteractive"
            />
          );
        }`,
      ),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R3");
  });

  it("allows beforeInteractive in the root layout, which is the one place Next honours it", () => {
    expect(
      checkScriptStrategies([
        file(
          ROOT_LAYOUT,
          `import Script from "next/script";

          export default function RootLayout() {
            return <Script src="https://cdn.vendor.example/a.js" strategy="beforeInteractive" />;
          }`,
        ),
      ]),
    ).toEqual([]);
  });
});

describe("R4 — subresource origins", () => {
  const entries = [entry({ hosts: ["cdn.vendor.example"] })];

  it("fails on an undeclared iframe origin", () => {
    const findings = checkSubresourceOrigins(
      [
        file(
          "src/components/embed.tsx",
          `export function Embed() {
            return <iframe src="https://player.other.example/embed/1" title="x" />;
          }`,
        ),
      ],
      entries,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R4");
    expect(findings[0]?.message).toContain("player.other.example");
  });

  it("accepts a declared origin", () => {
    expect(
      checkSubresourceOrigins(
        [
          file(
            "src/components/embed.tsx",
            `export function Embed() {
              return <img src="https://cdn.vendor.example/a.png" alt="" />;
            }`,
          ),
        ],
        entries,
      ),
    ).toEqual([]);
  });

  it("ignores relative URLs, which are first-party by definition", () => {
    expect(
      checkSubresourceOrigins(
        [
          file(
            "src/components/embed.tsx",
            `export function Embed() {
              return <img src="/logo.png" alt="" />;
            }`,
          ),
        ],
        entries,
      ),
    ).toEqual([]);
  });

  it("ignores data: URLs, which are bytes the page already has", () => {
    expect(
      checkSubresourceOrigins(
        [
          file(
            "src/components/embed.tsx",
            `export function Embed() {
              return <img src="data:image/svg+xml;base64,AAA" alt="" />;
            }`,
          ),
        ],
        entries,
      ),
    ).toEqual([]);
  });

  it("does not read an SVG's xmlns as a request", () => {
    // `xmlns="http://www.w3.org/2000/svg"` is a namespace identifier, not a
    // URL anything fetches. An audit that failed on it would be turned off.
    expect(
      checkSubresourceOrigins(
        [
          file(
            "src/components/icon.tsx",
            `export function Icon() {
              return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" />;
            }`,
          ),
        ],
        entries,
      ),
    ).toEqual([]);
  });

  it("does not read a link in body copy as a request", () => {
    // `<a href>` is navigation on click, not a subresource on load — the whole
    // reason the attribute list is per-tag rather than "anything named href".
    expect(
      checkSubresourceOrigins(
        [
          file(
            "src/app/page.tsx",
            `export default function Page() {
              return <a href="https://github.com/vercel/next.js">Docs</a>;
            }`,
          ),
        ],
        entries,
      ),
    ).toEqual([]);
  });

  it("skips a computed URL rather than guessing at it", () => {
    expect(
      checkSubresourceOrigins(
        [
          file(
            "src/components/embed.tsx",
            `export function Embed({ src }) {
              return <iframe src={src} title="x" />;
            }`,
          ),
        ],
        entries,
      ),
    ).toEqual([]);
  });
});

describe("R5 — remote image hosts", () => {
  const config = `const config = {
    images: {
      remotePatterns: [
        { protocol: "https", hostname: "images.unsplash.com" },
        { protocol: "https", hostname: "**.googleusercontent.com" },
      ],
    },
  };`;

  it("reads every configured hostname", () => {
    expect(readImageHostnames(config)).toEqual([
      "images.unsplash.com",
      "**.googleusercontent.com",
    ]);
  });

  it("fails on a configured host with no catalogue entry", () => {
    const findings = checkImageHosts(config, [
      entry({
        id: "unsplash",
        loading: { mode: "asset" },
        mountedBy: null,
        hosts: ["images.unsplash.com"],
      }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R5");
    expect(findings[0]?.message).toContain("googleusercontent.com");
  });

  it("fails on a catalogue asset host next/image would refuse to load", () => {
    const findings = checkImageHosts(
      `const config = { images: { remotePatterns: [] } };`,
      [
        entry({
          id: "unsplash",
          loading: { mode: "asset" },
          mountedBy: null,
          hosts: ["images.unsplash.com"],
        }),
      ],
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe(CATALOGUE_MODULE);
  });

  it("passes when both sides agree", () => {
    expect(
      checkImageHosts(config, [
        entry({
          id: "unsplash",
          loading: { mode: "asset" },
          mountedBy: null,
          hosts: ["images.unsplash.com", "**.googleusercontent.com"],
        }),
      ]),
    ).toEqual([]);
  });
});

describe("R6 — declared mounts", () => {
  const catalogue = `export const VENDOR_ID = "vendor";`;

  const mount = file(
    "src/components/third-party/vendor.tsx",
    `import Script from "next/script";
    import { VENDOR_ID, findThirdParty } from "@/lib/third-party/catalogue";

    export const id = VENDOR_ID;
    export function Vendor() {
      const declared = findThirdParty(VENDOR_ID);
      return <Script src={declared.src} strategy={declared.strategy} />;
    }`,
  );

  it("passes when the mount imports the id constant", () => {
    expect(checkMounts([mount], catalogue, [entry()])).toEqual([]);
  });

  it("fails when the named mount does not exist", () => {
    const findings = checkMounts([], catalogue, [entry()]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("does not exist");
  });

  it("fails when the mount does not name its entry through the catalogue", () => {
    const findings = checkMounts(
      [
        file(
          "src/components/third-party/vendor.tsx",
          `import Script from "next/script";

          export function Vendor() {
            return <Script src="https://cdn.vendor.example/a.js" strategy="lazyOnload" />;
          }`,
        ),
      ],
      catalogue,
      [entry()],
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("VENDOR_ID");
  });

  it("fails when a script entry names no mount at all", () => {
    const findings = checkMounts([mount], catalogue, [
      entry({ mountedBy: null }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("names no mountedBy module");
  });

  it("fails when an asset entry claims a mount it cannot have", () => {
    const findings = checkMounts([mount], catalogue, [
      entry({ loading: { mode: "asset" } }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("asset entry");
  });

  it("reads the id constants out of the catalogue's own source", () => {
    expect(
      readIdConstants(
        `export const A_ID = "a";\nconst B_ID = "b";\nexport const C = 3;`,
      ),
    ).toEqual(new Map([["a", "A_ID"]]));
  });
});

describe("R7 — only declared mounts import next/script", () => {
  it("fails on a <Script> mounted from an undeclared module", () => {
    const findings = checkScriptOwnership(
      [
        file(
          "src/app/dashboard/page.tsx",
          `import Script from "next/script";

          export default function Page() {
            return <Script src="https://cdn.other.example/a.js" strategy="lazyOnload" />;
          }`,
        ),
      ],
      [entry()],
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R7");
  });

  it("allows the declared mount", () => {
    expect(
      checkScriptOwnership(
        [
          file(
            "src/components/third-party/vendor.tsx",
            `import Script from "next/script";`,
          ),
        ],
        [entry()],
      ),
    ).toEqual([]);
  });
});

describe("R8 — preconnect policy", () => {
  it("fails when a facade's origin is preconnected", () => {
    const findings = checkPreconnectPolicy([
      entry({ loading: { mode: "facade" }, preconnect: true }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("R8");
    expect(findings[0]?.message).toContain("facade");
  });

  it("fails when a wildcard host is preconnected", () => {
    const findings = checkPreconnectPolicy([
      entry({
        loading: { mode: "asset" },
        mountedBy: null,
        hosts: ["**.googleusercontent.com"],
        preconnect: true,
      }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("wildcard");
  });

  it("allows a concrete host for a script that always loads", () => {
    expect(
      checkPreconnectPolicy([
        entry({ hosts: ["plausible.io"], preconnect: true }),
      ]),
    ).toEqual([]);
  });
});

describe("hostMatches", () => {
  it("matches exactly", () => {
    expect(hostMatches("plausible.io", "plausible.io")).toBe(true);
    expect(hostMatches("plausible.io", "evil-plausible.io")).toBe(false);
  });

  it("matches any depth under **.", () => {
    expect(
      hostMatches("**.googleusercontent.com", "lh3.googleusercontent.com"),
    ).toBe(true);
    expect(
      hostMatches("**.googleusercontent.com", "a.b.googleusercontent.com"),
    ).toBe(true);
    expect(
      hostMatches("**.googleusercontent.com", "googleusercontent.com"),
    ).toBe(false);
  });

  it("matches exactly one label under *.", () => {
    expect(hostMatches("*.example.com", "cdn.example.com")).toBe(true);
    expect(hostMatches("*.example.com", "a.cdn.example.com")).toBe(false);
  });

  it("recognises a wildcard host", () => {
    expect(isWildcardHost("**.example.com")).toBe(true);
    expect(isWildcardHost("example.com")).toBe(false);
  });
});

describe("the repository itself", () => {
  it("passes its own audit", () => {
    expect(main(REPO_ROOT)).toBe(0);
  });

  it("collects application sources and excludes tests", () => {
    const paths = collectSources(REPO_ROOT).map((f) => f.relativePath);

    expect(paths).toContain(ROOT_LAYOUT);
    expect(paths).toContain(CATALOGUE_MODULE);
    expect(paths.some((p) => p.endsWith(".test.ts"))).toBe(false);
    expect(paths.some((p) => p.endsWith(".test.tsx"))).toBe(false);
    expect(paths.some((p) => p.startsWith("src/test/"))).toBe(false);
  });

  it("declares every host next.config.ts permits", () => {
    const config = readFileSync(path.join(REPO_ROOT, NEXT_CONFIG), "utf8");
    expect(checkImageHosts(config)).toEqual([]);
    expect(readImageHostnames(config).length).toBeGreaterThan(0);
  });
});
