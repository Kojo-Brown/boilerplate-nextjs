import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { preconnect } from "react-dom";
import { VideoFacade, youtubeEmbedUrl } from "./video-facade";
import { YOUTUBE_EMBED_ORIGIN, YOUTUBE_ID } from "@/lib/third-party/catalogue";

/**
 * `preconnect` is mocked rather than observed through the `<link>` React emits.
 *
 * React keeps its resource map for the lifetime of the document, so a hint
 * emitted by one test is still in `document.head` — and still deduplicated —
 * during the next. Asserting on the DOM would therefore have every case after
 * the first passing on a link some earlier case created, which is a suite that
 * cannot fail. The call is the behaviour this component is responsible for;
 * what React does with it is React's.
 */
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  preconnect: vi.fn(),
}));

/**
 * The properties the audit script cannot see.
 *
 * `scripts/assert-third-party-scripts.ts` checks the declaration — that the
 * catalogue says this entry is a facade and that nothing preconnects it. What
 * it cannot check is the only thing that actually matters: that rendering the
 * component contacts nobody. That is a property of a render, so it is asserted
 * against one.
 */
const PROPS = {
  videoId: "jNQXAC9IVRw",
  title: "Me at the zoo",
  poster: { src: "/poster.jpg", alt: "A still from the video" },
};

function renderFacade() {
  return {
    user: userEvent.setup(),
    ...render(<VideoFacade {...PROPS} />),
  };
}

beforeEach(() => {
  vi.mocked(preconnect).mockClear();
});

describe("VideoFacade before activation", () => {
  it("renders no iframe", () => {
    const { container } = renderFacade();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("points nothing at the embed origin", () => {
    // Stronger than "no iframe", and the assertion that would catch a facade
    // regressing into a hidden or eagerly-preloaded embed: a `<link rel=
    // preload>`, a prefetch, or an iframe behind `display: none` would all put
    // a request in the document without an `<iframe>` being visible.
    //
    // `data-third-party="youtube"` is deliberately not matched — it is a label
    // in the DOM, not a URL — so the assertion is about the origin.
    const { container } = renderFacade();
    expect(container.innerHTML).not.toContain(YOUTUBE_EMBED_ORIGIN);
    expect(container.innerHTML).not.toContain("youtube-nocookie");
    expect(container.innerHTML).not.toContain("youtube.com");
  });

  it("is a button, so it is reachable by keyboard", () => {
    renderFacade();
    const control = screen.getByRole("button", {
      name: "Play video: Me at the zoo",
    });
    expect(control).toHaveAttribute("type", "button");
  });

  it("shows the poster with its own description", () => {
    renderFacade();
    const poster = screen.getByAltText("A still from the video");
    expect(poster).toHaveAttribute("src", "/poster.jpg");
  });

  it("names its catalogue entry in the DOM", () => {
    renderFacade();
    expect(screen.getByRole("button", { name: /Play video/ })).toHaveAttribute(
      "data-third-party",
      YOUTUBE_ID,
    );
  });
});

describe("VideoFacade after activation", () => {
  it("mounts the player on click", async () => {
    const { user, container } = renderFacade();

    await user.click(screen.getByRole("button", { name: /Play video/ }));

    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("src")).toContain(YOUTUBE_EMBED_ORIGIN);
  });

  it("mounts the player from the keyboard", async () => {
    // A facade that only responds to a mouse has removed a working embed for
    // keyboard users and replaced it with a picture of one.
    const { user, container } = renderFacade();

    await user.tab();
    expect(screen.getByRole("button", { name: /Play video/ })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("autoplays, so the activation press is the only press needed", async () => {
    const { user, container } = renderFacade();

    await user.click(screen.getByRole("button", { name: /Play video/ }));

    const src = container.querySelector("iframe")?.getAttribute("src") ?? "";
    expect(new URL(src).searchParams.get("autoplay")).toBe("1");
  });

  it("gives the frame an accessible name", async () => {
    const { user } = renderFacade();
    await user.click(screen.getByRole("button", { name: /Play video/ }));
    expect(screen.getByTitle("Me at the zoo")).toBeInTheDocument();
  });

  it("delegates only the capabilities a player needs to play", async () => {
    // `allow` is a Permissions Policy delegation, so every entry is a
    // capability handed to a third party for the lifetime of the frame. The
    // vendor's copy-paste snippet includes two a video player does not need.
    const { user, container } = renderFacade();
    await user.click(screen.getByRole("button", { name: /Play video/ }));

    const allow =
      container.querySelector("iframe")?.getAttribute("allow") ?? "";
    expect(allow).toContain("autoplay");
    expect(allow).not.toContain("clipboard-write");
    expect(allow).not.toContain("web-share");
  });

  it("replaces the facade rather than rendering both", async () => {
    const { user } = renderFacade();
    await user.click(screen.getByRole("button", { name: /Play video/ }));
    expect(screen.queryByRole("button", { name: /Play video/ })).toBeNull();
  });
});

describe("intent warms the connection", () => {
  it("opens nothing on render", () => {
    // The cost a facade exists to avoid is paid at render time, and a
    // preconnect is part of it: a DNS lookup and a TLS handshake against a
    // connection budget the first-party requests are also using.
    renderFacade();
    expect(preconnect).not.toHaveBeenCalled();
  });

  it("warms on hover, which precedes the press by about a handshake", async () => {
    const { user } = renderFacade();

    await user.hover(screen.getByRole("button", { name: /Play video/ }));

    expect(preconnect).toHaveBeenCalledWith(YOUTUBE_EMBED_ORIGIN);
  });

  it("warms on focus, for a visitor who never hovers anything", async () => {
    const { user } = renderFacade();
    await user.tab();
    expect(preconnect).toHaveBeenCalledWith(YOUTUBE_EMBED_ORIGIN);
  });

  it("warms the origin and nothing beyond it", () => {
    // `preconnect` takes an origin. Passing a full URL would have the browser
    // parse the origin back out of it, and would put the video id — which is
    // content — into a hint that is shared across every facade on the page.
    renderFacade();
    const control = screen.getByRole("button", { name: /Play video/ });
    control.focus();

    for (const [origin] of vi.mocked(preconnect).mock.calls) {
      expect(new URL(origin).pathname).toBe("/");
    }
  });
});

describe("youtubeEmbedUrl", () => {
  it("builds a player URL on the privacy-enhanced origin", () => {
    const url = new URL(youtubeEmbedUrl("jNQXAC9IVRw"));
    expect(url.origin).toBe(YOUTUBE_EMBED_ORIGIN);
    expect(url.pathname).toBe("/embed/jNQXAC9IVRw");
    expect(url.searchParams.get("rel")).toBe("0");
  });

  it("encodes an id rather than letting it add parameters", () => {
    // An id reaches this from content in practice. Interpolating one carrying
    // `?` would append parameters to a URL that is about to be granted camera
    // and microphone adjacent capabilities by the `allow` list.
    const url = new URL(youtubeEmbedUrl("abc?autoplay=0&foo=bar"));
    expect(url.pathname).toBe("/embed/abc%3Fautoplay%3D0%26foo%3Dbar");
    expect(url.searchParams.get("autoplay")).toBe("1");
    expect(url.searchParams.get("foo")).toBeNull();
  });
});
