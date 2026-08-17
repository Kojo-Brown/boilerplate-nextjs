import { describe, expect, it } from "vitest";
import {
  PHOTOS,
  PHOTO_HEIGHT,
  PHOTO_WIDTH,
  getPhotoById,
  getPhotoIds,
  photoSrc,
} from "./photos";

describe("PHOTOS", () => {
  it("has no duplicate IDs, since the ID is the URL", () => {
    const ids = PHOTOS.map((photo) => photo.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses URL-safe slugs, so `/photos/[id]` never needs encoding", () => {
    for (const photo of PHOTOS) {
      expect(photo.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(encodeURIComponent(photo.id)).toBe(photo.id);
    }
  });

  it("gives every photo alt text that is not just the title again", () => {
    for (const photo of PHOTOS) {
      expect(photo.alt.trim().length).toBeGreaterThan(0);
      expect(photo.alt.toLowerCase()).not.toBe(photo.title.toLowerCase());
    }
  });

  it("sources every image from the host next.config.ts allows", () => {
    // A source from any other origin builds fine and then throws at runtime
    // ("hostname is not configured under images"), which no other gate covers.
    for (const photo of PHOTOS) {
      expect(new URL(photoSrc(photo)).hostname).toBe("images.unsplash.com");
    }
  });

  it("holds at least three photos, so the grid has a row to lay out", () => {
    expect(PHOTOS.length).toBeGreaterThanOrEqual(3);
  });
});

describe("photoSrc", () => {
  it("requests the catalogue width by default", () => {
    const photo = PHOTOS[0];
    expect(photo).toBeDefined();
    const url = new URL(photoSrc(photo!));
    expect(url.searchParams.get("w")).toBe(String(PHOTO_WIDTH));
    expect(url.pathname).toBe(`/${photo!.source}`);
  });

  it("bounds the upstream fetch when a smaller width is asked for", () => {
    const photo = PHOTOS[0]!;
    expect(new URL(photoSrc(photo, 640)).searchParams.get("w")).toBe("640");
  });
});

describe("getPhotoById", () => {
  it("finds every catalogued photo", () => {
    for (const photo of PHOTOS) {
      expect(getPhotoById(photo.id)).toEqual(photo);
    }
  });

  it("returns undefined for an unknown ID so the route can 404", () => {
    expect(getPhotoById("not-a-photo")).toBeUndefined();
  });

  it("does not match on a prefix of a real ID", () => {
    expect(getPhotoById(PHOTOS[0]!.id.slice(0, 4))).toBeUndefined();
  });
});

describe("getPhotoIds", () => {
  it("enumerates the whole catalogue for generateStaticParams", () => {
    // An empty return here is an EmptyGenerateStaticParamsError at build time
    // under Cache Components, so the emptiness matters as much as the contents.
    expect(getPhotoIds()).toEqual(PHOTOS.map((photo) => photo.id));
    expect(getPhotoIds().length).toBeGreaterThan(0);
  });
});

describe("catalogue dimensions", () => {
  it("declares a 3:2 box, which both views crop to", () => {
    expect(PHOTO_WIDTH / PHOTO_HEIGHT).toBeCloseTo(1.5, 2);
  });
});
