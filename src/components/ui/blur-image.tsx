"use client";

import * as React from "react";
import Image from "next/image";
import type { ImageProps } from "next/image";
import { cn } from "@/lib/cn";
import { shimmerDataUrl } from "@/lib/lqip";

export interface BlurImageProps extends Omit<ImageProps, "placeholder"> {
  /**
   * Base64-encoded LQIP data URL. When omitted, a shimmer gradient is used.
   * Generate a real LQIP via `plaiceholder`:
   *   const { base64 } = await getPlaiceholder(src);
   */
  blurDataURL?: string;
  /**
   * Width × height used to generate the shimmer when no blurDataURL is supplied.
   * Defaults to the image width/height (or 700×475 if those are not numeric).
   */
  shimmerSize?: { width: number; height: number };
  /** Extra class applied to the wrapping container div. */
  containerClassName?: string;
}

/**
 * next/image wrapper with blur placeholder + LQIP support.
 *
 * - Shows an animated shimmer while the image is loading.
 * - Fades the image in once loaded.
 * - Accepts a real LQIP base64 string via `blurDataURL` (e.g. from plaiceholder).
 * - When `fill` is true, the wrapper becomes `absolute inset-0` to fill its parent.
 */
export function BlurImage({
  src,
  alt,
  blurDataURL,
  shimmerSize,
  className,
  containerClassName,
  width,
  height,
  fill,
  onLoad,
  ...rest
}: BlurImageProps) {
  const [isLoaded, setIsLoaded] = React.useState(false);

  const shimmerW =
    shimmerSize?.width ?? (typeof width === "number" ? width : 700);
  const shimmerH =
    shimmerSize?.height ?? (typeof height === "number" ? height : 475);

  const placeholder = blurDataURL ?? shimmerDataUrl(shimmerW, shimmerH);

  function handleLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    setIsLoaded(true);
    if (typeof onLoad === "function") onLoad(e);
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden",
        fill && "absolute inset-0",
        containerClassName,
      )}
    >
      {/* Pulse overlay — visible only while the image is loading */}
      {!isLoaded && (
        <div
          aria-hidden="true"
          className="absolute inset-0 animate-pulse bg-[var(--muted)]"
        />
      )}

      <Image
        src={src}
        alt={alt}
        width={fill ? undefined : width}
        height={fill ? undefined : height}
        fill={fill}
        placeholder="blur"
        blurDataURL={placeholder}
        onLoad={handleLoad}
        className={cn(
          "transition-opacity duration-500",
          isLoaded ? "opacity-100" : "opacity-0",
          className,
        )}
        {...rest}
      />
    </div>
  );
}
