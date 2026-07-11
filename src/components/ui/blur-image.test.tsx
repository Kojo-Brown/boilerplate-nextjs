// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlurImage } from "./blur-image";

// next/image renders as a plain <img> in the jsdom test environment
vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    blurDataURL: _blurDataURL,
    placeholder: _placeholder,
    onLoad,
    className,
    width,
    height,
    ...rest
  }: React.ImgHTMLAttributes<HTMLImageElement> & {
    blurDataURL?: string;
    placeholder?: string;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={typeof src === "string" ? src : ""}
      alt={alt}
      onLoad={onLoad}
      className={className}
      width={width}
      height={height}
      {...rest}
    />
  ),
}));

describe("BlurImage", () => {
  const defaultProps = {
    src: "https://example.com/photo.jpg",
    alt: "A sample photo",
    width: 800,
    height: 600,
  };

  it("renders an img with the correct alt text", () => {
    render(<BlurImage {...defaultProps} />);
    expect(screen.getByAltText("A sample photo")).toBeInTheDocument();
  });

  it("starts with the image hidden (opacity-0)", () => {
    render(<BlurImage {...defaultProps} />);
    const img = screen.getByAltText("A sample photo");
    expect(img).toHaveClass("opacity-0");
  });

  it("shows the shimmer overlay while loading", () => {
    const { container } = render(<BlurImage {...defaultProps} />);
    const overlay = container.querySelector("[aria-hidden=true]");
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveClass("animate-pulse");
  });

  it("fades in and removes shimmer after image loads", () => {
    const { container } = render(<BlurImage {...defaultProps} />);
    const img = screen.getByAltText("A sample photo");

    fireEvent.load(img);

    expect(img).toHaveClass("opacity-100");
    expect(img).not.toHaveClass("opacity-0");
    expect(container.querySelector("[aria-hidden=true]")).not.toBeInTheDocument();
  });

  it("calls the onLoad callback when provided", () => {
    const onLoad = vi.fn();
    render(<BlurImage {...defaultProps} onLoad={onLoad} />);
    fireEvent.load(screen.getByAltText("A sample photo"));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("applies containerClassName to the wrapper div", () => {
    const { container } = render(
      <BlurImage {...defaultProps} containerClassName="my-container" />,
    );
    expect(container.firstChild).toHaveClass("my-container");
  });

  it("applies className to the img element", () => {
    render(<BlurImage {...defaultProps} className="rounded-lg" />);
    expect(screen.getByAltText("A sample photo")).toHaveClass("rounded-lg");
  });

  it("accepts a custom blurDataURL prop without error", () => {
    const blurDataURL = "data:image/png;base64,abc123";
    render(<BlurImage {...defaultProps} blurDataURL={blurDataURL} />);
    expect(screen.getByAltText("A sample photo")).toBeInTheDocument();
  });
});
