import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked so `resolveUploadScanner` can be asked what it does for each shape of
// configuration. The rest of the module takes its endpoint as an argument and
// does not read the environment at all, which is why only this one function
// needs the mock.
vi.mock("@/lib/env/server", () => ({
  serverEnv: {
    UPLOAD_SCANNER_URL: undefined,
    UPLOAD_SCANNER_API_KEY: undefined,
  },
}));

const {
  createHttpScanner,
  parseScanResponse,
  resolveUploadScanner,
  scanAllowsUpload,
  unconfiguredScanner,
} = await import("@/lib/uploads/scan");
type ScanTarget = import("@/lib/uploads/scan").ScanTarget;

const { serverEnv } = await import("@/lib/env/server");
const mutableEnv = serverEnv as unknown as Record<string, unknown>;

beforeEach(() => {
  mutableEnv["UPLOAD_SCANNER_URL"] = undefined;
  mutableEnv["UPLOAD_SCANNER_API_KEY"] = undefined;
});

const TARGET: ScanTarget = {
  bucket: "my-bucket",
  key: "quarantine/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png",
  declaredType: "image/png",
  sizeBytes: 4096,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("unconfiguredScanner", () => {
  it("answers unavailable rather than clean", () => {
    // The point of it existing at all rather than the code branching on
    // `undefined`. "Nothing scanned this" is the truth; that the upload proceeds
    // anyway is the separate fact carried by `requirement`.
    return expect(unconfiguredScanner.scan(TARGET)).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("does not require a verdict, so uploads still work with no scanner", () => {
    expect(unconfiguredScanner.requirement).toBe("absent");
  });

  it("names itself, so the audit line says what did the scanning", () => {
    expect(unconfiguredScanner.name).toBe("none");
  });
});

describe("parseScanResponse", () => {
  it("accepts a clean verdict", () => {
    expect(parseScanResponse({ status: "clean" })).toEqual({ status: "clean" });
  });

  it("accepts an infected verdict and keeps the signature name", () => {
    expect(
      parseScanResponse({ status: "infected", signature: "Eicar-Test-File" }),
    ).toEqual({ status: "infected", signature: "Eicar-Test-File" });
  });

  it("names an infected verdict that arrived without a signature", () => {
    expect(parseScanResponse({ status: "infected" })).toEqual({
      status: "infected",
      signature: "unnamed",
    });
    expect(parseScanResponse({ status: "infected", signature: "" })).toEqual({
      status: "infected",
      signature: "unnamed",
    });
  });

  it("treats an unrecognised body as unavailable, never as clean", () => {
    // The fail-closed direction that matters: a scanner that changes its
    // response format must not start passing everything.
    for (const body of [
      null,
      undefined,
      "clean",
      42,
      {},
      { status: "ok" },
      { status: true },
      { clean: true },
    ]) {
      expect(parseScanResponse(body).status, JSON.stringify(body)).toBe(
        "unavailable",
      );
    }
  });
});

describe("createHttpScanner", () => {
  it("posts the target and returns the verdict", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "clean" }));
    const scanner = createHttpScanner({
      endpoint: "https://scanner.example/scan",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(scanner.scan(TARGET)).resolves.toEqual({ status: "clean" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://scanner.example/scan");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(TARGET);
  });

  it("sends the bytes nowhere — only the object's location", async () => {
    // The scanner reads the object itself. Streaming a 5 MB body through this
    // process to scan it would mean a buffer per concurrent upload and two
    // transfers to do one scan.
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "clean" }));
    const scanner = createHttpScanner({
      endpoint: "https://scanner.example/scan",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await scanner.scan(TARGET);

    const body = JSON.parse(
      String(
        (fetchImpl.mock.calls[0]! as unknown as [string, RequestInit])[1].body,
      ),
    );
    expect(Object.keys(body).sort()).toEqual([
      "bucket",
      "declaredType",
      "key",
      "sizeBytes",
    ]);
  });

  it("sends the api key as a bearer token when one is configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "clean" }));
    const scanner = createHttpScanner({
      endpoint: "https://scanner.example/scan",
      apiKey: "mock-scanner-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await scanner.scan(TARGET);

    const init = (
      fetchImpl.mock.calls[0]! as unknown as [string, RequestInit]
    )[1];
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer mock-scanner-key",
    );
  });

  it("omits the authorization header entirely when no key is configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "clean" }));
    const scanner = createHttpScanner({
      endpoint: "https://scanner.example/scan",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await scanner.scan(TARGET);

    const init = (
      fetchImpl.mock.calls[0]! as unknown as [string, RequestInit]
    )[1];
    expect(init.headers as Record<string, string>).not.toHaveProperty(
      "authorization",
    );
  });

  it("requires a verdict, so its silence refuses the upload", () => {
    expect(
      createHttpScanner({ endpoint: "https://scanner.example/scan" })
        .requirement,
    ).toBe("required");
  });

  it("reports a non-2xx as unavailable with the status in the reason", async () => {
    const scanner = createHttpScanner({
      endpoint: "https://scanner.example/scan",
      fetchImpl: (async () =>
        new Response("", { status: 503 })) as unknown as typeof fetch,
    });

    const verdict = await scanner.scan(TARGET);
    expect(verdict.status).toBe("unavailable");
    if (verdict.status === "unavailable") {
      expect(verdict.reason).toContain("503");
    }
  });

  it("reports a network failure as unavailable, not as evidence", async () => {
    const scanner = createHttpScanner({
      endpoint: "https://scanner.example/scan",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    const verdict = await scanner.scan(TARGET);
    expect(verdict.status).toBe("unavailable");
    if (verdict.status === "unavailable") {
      expect(verdict.reason).toContain("ECONNREFUSED");
    }
  });

  it("reports a body that is not JSON as unavailable", async () => {
    const scanner = createHttpScanner({
      endpoint: "https://scanner.example/scan",
      fetchImpl: (async () =>
        new Response("<html>gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    });

    await expect(scanner.scan(TARGET)).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("gives up after the timeout and aborts the request", async () => {
    // `AbortSignal.timeout` rather than a `Promise.race`: racing leaves the
    // request running, so a scanner that is slow because it is overloaded keeps
    // receiving work it can no longer answer for.
    let observed: AbortSignal | undefined;

    const scanner = createHttpScanner({
      endpoint: "https://scanner.example/scan",
      timeoutMs: 5,
      fetchImpl: ((_url: string, init: RequestInit) => {
        observed = init.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          );
        });
      }) as unknown as typeof fetch,
    });

    const verdict = await scanner.scan(TARGET);

    expect(verdict.status).toBe("unavailable");
    expect(observed?.aborted).toBe(true);
  });
});

describe("scanAllowsUpload", () => {
  it("accepts a clean verdict from either kind of scanner", () => {
    expect(scanAllowsUpload({ status: "clean" }, "required")).toBe(true);
    expect(scanAllowsUpload({ status: "clean" }, "absent")).toBe(true);
  });

  it("refuses an infected verdict even when no scanner is required", () => {
    // `requirement` governs what a *non-answer* means. A positive match is a
    // positive match whoever asked for it.
    expect(
      scanAllowsUpload({ status: "infected", signature: "X" }, "required"),
    ).toBe(false);
    expect(
      scanAllowsUpload({ status: "infected", signature: "X" }, "absent"),
    ).toBe(false);
  });

  it("refuses a non-answer from a configured scanner", () => {
    // The bug this hook exists to prevent: an outage silently becoming an
    // absence of scanning.
    expect(
      scanAllowsUpload(
        { status: "unavailable", reason: "timeout" },
        "required",
      ),
    ).toBe(false);
  });

  it("accepts a non-answer when no scanner is configured", () => {
    // Otherwise a fresh clone rejects every upload, and the first person to hit
    // that fixes it by taking the check out.
    expect(
      scanAllowsUpload(
        { status: "unavailable", reason: "no scanner configured" },
        "absent",
      ),
    ).toBe(true);
  });
});

describe("resolveUploadScanner", () => {
  it("returns the unconfigured scanner when no URL is set", () => {
    // A supported state, not a disabled feature: uploads proceed and each one
    // records that nothing scanned it.
    const scanner = resolveUploadScanner();

    expect(scanner).toBe(unconfiguredScanner);
    expect(scanner.requirement).toBe("absent");
  });

  it("returns an HTTP scanner that requires a verdict once a URL is set", () => {
    // Configuring a scanner is the decision that scanning is required, and that
    // is the only place that decision is made — never a parameter a caller
    // chooses.
    mutableEnv["UPLOAD_SCANNER_URL"] = "https://scanner.example/scan";

    const scanner = resolveUploadScanner();

    expect(scanner.name).toBe("http");
    expect(scanner.requirement).toBe("required");
  });

  it("reads the environment on each call rather than at import time", async () => {
    // So that a deployment reloading configuration, and a test, are not looking
    // at a decision frozen when the module graph was built.
    expect(resolveUploadScanner().requirement).toBe("absent");

    mutableEnv["UPLOAD_SCANNER_URL"] = "https://scanner.example/scan";
    expect(resolveUploadScanner().requirement).toBe("required");

    mutableEnv["UPLOAD_SCANNER_URL"] = undefined;
    expect(resolveUploadScanner().requirement).toBe("absent");
  });

  it("passes the configured api key through to the request", async () => {
    mutableEnv["UPLOAD_SCANNER_URL"] = "https://scanner.example/scan";
    mutableEnv["UPLOAD_SCANNER_API_KEY"] = "mock-scanner-key";

    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "clean" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await resolveUploadScanner(fetchImpl as unknown as typeof fetch).scan(
      TARGET,
    );

    const init = (
      fetchImpl.mock.calls[0]! as unknown as [string, RequestInit]
    )[1];
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer mock-scanner-key",
    );
  });
});
