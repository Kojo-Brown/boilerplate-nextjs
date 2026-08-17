// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PHOTOS } from "@/lib/photos";
import { PhotoGrid } from "./photo-grid";

describe("PhotoGrid", () => {
  it("renders a tile per catalogued photo", () => {
    render(<PhotoGrid />);

    expect(screen.getAllByRole("link")).toHaveLength(PHOTOS.length);
    for (const photo of PHOTOS) {
      expect(
        screen.getByRole("link", { name: new RegExp(photo.title, "i") }),
      ).toBeInTheDocument();
    }
  });

  it("links every tile to the photo's own URL", () => {
    // Interception is a routing behaviour layered on top of real hrefs. If a
    // tile ever became a button with an onClick, the modal would still open
    // and the URL would stop changing — which breaks sharing, Back, and
    // middle-click, none of which any other test here would notice.
    render(<PhotoGrid />);

    for (const photo of PHOTOS) {
      expect(
        screen.getByRole("link", { name: new RegExp(photo.title, "i") }),
      ).toHaveAttribute("href", `/photos/${photo.id}`);
    }
  });

  it("gives every image its catalogued alt text", () => {
    render(<PhotoGrid />);

    for (const photo of PHOTOS) {
      expect(screen.getByAltText(photo.alt)).toBeInTheDocument();
    }
  });

  it("requests thumbnails rather than the full-size source", () => {
    render(<PhotoGrid />);

    const first = PHOTOS[0];
    expect(first).toBeDefined();
    const img = screen.getByAltText(first!.alt);
    expect(img.getAttribute("src")).toContain("w=800");
  });
});
