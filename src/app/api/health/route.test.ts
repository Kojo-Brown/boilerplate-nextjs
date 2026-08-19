import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import type { HealthPayload } from "./route";

const globals = globalThis as { EdgeRuntime?: unknown };

afterEach(() => {
  delete globals.EdgeRuntime;
});

function request(): NextRequest {
  return new NextRequest(new Request("https://example.test/api/health"));
}

describe("GET /api/health", () => {
  it("answers 200 with an ok status and a parseable timestamp", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);

    const body = (await response.json()) as HealthPayload;
    expect(body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });

  it("reports the runtime it actually ran on, not the declared one", async () => {
    // `API_ROUTES` says nodejs; this endpoint has to be able to disagree with
    // it, or it is an echo of the declaration rather than evidence about the
    // deployment.
    globals.EdgeRuntime = "edge-runtime";

    const body = (await (await GET(request())).json()) as HealthPayload;
    expect(body.runtime).toBe("edge");
  });

  it("reports nodejs under Node", async () => {
    const body = (await (await GET(request())).json()) as HealthPayload;
    expect(body.runtime).toBe("nodejs");
  });
});
