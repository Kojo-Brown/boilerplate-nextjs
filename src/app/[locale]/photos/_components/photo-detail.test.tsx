// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PHOTOS, type Photo } from "@/lib/photos";
import { PhotoDetail } from "./photo-detail";

const photo: Photo = PHOTOS[0]!;

describe("PhotoDetail", () => {
  describe("page variant", () => {
    it("renders the title as the page heading", () => {
      render(<PhotoDetail photo={photo} variant="page" />);

      expect(
        screen.getByRole("heading", { level: 1, name: photo.title }),
      ).toBeInTheDocument();
    });

    it("offers a way back to the gallery", () => {
      // Someone arriving from a shared link has no history to go back to, so
      // the route has to provide the way out that the modal gets from Escape.
      render(<PhotoDetail photo={photo} variant="page" />);

      expect(screen.getByRole("link", { name: /all photos/i })).toHaveAttribute(
        "href",
        "/photos",
      );
    });

    it("shows the caption", () => {
      render(<PhotoDetail photo={photo} variant="page" />);

      expect(screen.getByText(photo.caption)).toBeInTheDocument();
    });
  });

  describe("modal variant", () => {
    it("omits the heading and caption, which the dialog header already owns", () => {
      render(<PhotoDetail photo={photo} variant="modal" />);

      expect(
        screen.queryByRole("heading", { name: photo.title }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(photo.caption)).not.toBeInTheDocument();
    });

    it("escapes to the full page with a document request, not a soft nav", () => {
      // A <Link> here would be a no-op: the address bar is already on this
      // URL, so the router has nowhere to navigate and the modal would stay
      // open. Only a real document request falls through the interceptor.
      render(<PhotoDetail photo={photo} variant="modal" />);

      const escape = screen.getByRole("link", { name: /open full page/i });
      expect(escape).toHaveAttribute("href", `/photos/${photo.id}`);
    });
  });

  it("renders the same image and copy affordance in both variants", () => {
    const { unmount } = render(<PhotoDetail photo={photo} variant="page" />);
    expect(screen.getByAltText(photo.alt)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy link/i }),
    ).toBeInTheDocument();
    unmount();

    render(<PhotoDetail photo={photo} variant="modal" />);
    expect(screen.getByAltText(photo.alt)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy link/i }),
    ).toBeInTheDocument();
  });
});
