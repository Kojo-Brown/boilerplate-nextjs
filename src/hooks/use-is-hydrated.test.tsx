// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useIsHydrated } from "./use-is-hydrated";

function Probe() {
  return <span>{useIsHydrated() ? "client" : "server"}</span>;
}

describe("useIsHydrated", () => {
  it("returns true once rendered on the client", () => {
    const { result } = renderHook(() => useIsHydrated());
    expect(result.current).toBe(true);
  });

  it("stays true across re-renders", () => {
    const { result, rerender } = renderHook(() => useIsHydrated());
    rerender();
    expect(result.current).toBe(true);
  });

  it("returns false when rendered on the server", () => {
    // The server snapshot is what keeps portals from reaching for `document`
    // during SSR, so it is asserted through a real server render rather than by
    // calling the hook directly.
    expect(renderToStaticMarkup(<Probe />)).toBe("<span>server</span>");
  });
});
