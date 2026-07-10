// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  Skeleton,
  SkeletonCard,
  SkeletonHeading,
  SkeletonListItem,
  SkeletonStatTile,
  SkeletonText,
} from "./skeleton";

describe("Skeleton", () => {
  it("renders with base classes", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstChild as HTMLElement;
    expect(el).toBeInTheDocument();
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("rounded-md");
  });

  it("merges custom className", () => {
    const { container } = render(<Skeleton className="h-4 w-32" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("h-4");
    expect(el.className).toContain("w-32");
  });
});

describe("SkeletonText", () => {
  it("renders with h-4 w-full defaults", () => {
    const { container } = render(<SkeletonText />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("h-4");
    expect(el.className).toContain("w-full");
  });
});

describe("SkeletonHeading", () => {
  it("renders with heading size defaults", () => {
    const { container } = render(<SkeletonHeading />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("h-7");
  });
});

describe("SkeletonCard", () => {
  it("renders four grid cells", () => {
    const { container } = render(<SkeletonCard />);
    const cells = container.querySelectorAll(".grid > div");
    expect(cells).toHaveLength(4);
  });
});

describe("SkeletonStatTile", () => {
  it("renders with border and rounded classes", () => {
    const { container } = render(<SkeletonStatTile />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("border");
    expect(el.className).toContain("rounded-xl");
  });
});

describe("SkeletonListItem", () => {
  it("renders avatar circle and text lines", () => {
    const { container } = render(<SkeletonListItem />);
    const circles = container.querySelectorAll(".rounded-full");
    expect(circles.length).toBeGreaterThanOrEqual(1);
  });
});
