import "@testing-library/jest-dom";
import { cleanup } from "@testing-library/react";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./server";

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
  usePathname: vi.fn(() => "/"),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  redirect: vi.fn(),
  notFound: vi.fn(),
  useParams: vi.fn(() => ({})),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    has: vi.fn(() => false),
    getAll: vi.fn(() => []),
  })),
  headers: vi.fn(async () => new Headers()),
  // Off by default, which matches what `draftMode()` returns everywhere a
  // preview cookie is absent — including at build time. A test that wants a
  // preview says so explicitly (`vi.mocked(draftMode).mockResolvedValue(…)`),
  // so no suite can start previewing by accident and no assertion about the
  // published path is quietly running against the draft one.
  draftMode: vi.fn(async () => ({
    isEnabled: false,
    enable: vi.fn(),
    disable: vi.fn(),
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

// The real `next/image` consumes several props and never forwards them to the
// DOM. The mock has to do the same: React logs "Received `true` for a
// non-boolean attribute `fill`" and "does not recognize the `blurDataURL`
// prop" for every one it leaks, which buries real failures under warnings that
// describe the mock rather than the component.
vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    width,
    height,
    className,
    priority: _priority,
    fill,
    placeholder: _placeholder,
    blurDataURL: _blurDataURL,
    quality: _quality,
    loader: _loader,
    unoptimized: _unoptimized,
    ...rest
  }: {
    src: string;
    alt: string;
    width?: number;
    height?: number;
    className?: string;
    priority?: boolean;
    fill?: boolean;
    placeholder?: string;
    blurDataURL?: string;
    quality?: number;
    loader?: unknown;
    unoptimized?: boolean;
    [key: string]: unknown;
  }) =>
    createElement("img", {
      src,
      alt,
      width,
      height,
      className,
      // Surfaced as a data attribute rather than dropped, so a test can still
      // tell a `fill` image from a sized one.
      ...(fill && { "data-fill": "true" }),
      ...rest,
    }),
}));
