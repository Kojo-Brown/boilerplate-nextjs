"use client";

import * as React from "react";
import { preconnect } from "react-dom";
import { BlurImage } from "@/components/ui/blur-image";
import { cn } from "@/lib/cn";
import { YOUTUBE_EMBED_ORIGIN, YOUTUBE_ID } from "@/lib/third-party/catalogue";

/**
 * The facade pattern: markup this repository serves, standing in for a
 * third-party embed until a visitor asks for it.
 *
 * An embedded YouTube player is roughly 1.2 MB of JavaScript across ten-odd
 * requests, and it loads when the page loads — not when anyone presses play.
 * On an article page that is a straight transfer of cost from the few readers
 * who watch the video to every reader who scrolls past it, and it lands in the
 * worst place: the player's script parses on the main thread while the page is
 * trying to become interactive, so it is paid for in INP and in LCP if the
 * iframe is anywhere near the top.
 *
 * What replaces it is a poster frame and a play button. They render with the
 * document, cost one image the page was going to lay out anyway, and contact
 * nobody. The `<iframe>` is mounted on the first activation and not before —
 * `activated` starts `false` and there is no effect, no timer and no
 * intersection observer that can flip it, because "the visitor scrolled near
 * it" is not the same as "the visitor wants it" and a facade that loads on
 * scroll is a slower embed rather than an absent one.
 *
 * Three details are what make it a real replacement rather than a screenshot:
 *
 *  1. **It is a `<button>`.** Not a div with an onClick. The whole poster is
 *     the control, it is in the tab order, it responds to Enter and Space, and
 *     it carries an accessible name that says what will be played. A facade
 *     that is unreachable by keyboard has removed a working embed and put
 *     nothing in its place for the people who were using it.
 *
 *  2. **`autoplay=1` on the activated URL.** The press is the gesture the
 *     browser's autoplay policy requires, so the video starts from the one
 *     interaction rather than asking for a second press inside the iframe. A
 *     facade without it makes every viewer click twice — which is the tell that
 *     the pattern was copied without being used.
 *
 *  3. **The connection is warmed on intent, not on render.** Hover and focus
 *     are evidence that the press is coming; they precede it by a few hundred
 *     milliseconds, which is about what a DNS lookup and a TLS handshake cost.
 *     Doing it in the catalogue as `preconnect: true` instead would move that
 *     handshake onto every page load for every reader, which is most of what
 *     the facade exists to avoid — so the catalogue records `preconnect: false`
 *     for this entry and `scripts/assert-third-party-scripts.ts` fails if that
 *     changes.
 *
 * `preconnect` is React 19's, from `react-dom`, rather than a hand-injected
 * `<link>`: React deduplicates the hint across components and across repeated
 * calls, so hovering the same facade twenty times emits one hint, and two
 * facades on one page emit one between them.
 *
 * The poster is a required prop with no default, and it should come from an
 * origin the page already talks to — this repository's own, or one already on
 * its critical path. Taking it from the embed's thumbnail CDN is the obvious
 * shortcut and it quietly undoes the pattern: the page is back to contacting
 * the vendor on load, just for a smaller file.
 *
 * See docs/third-party-scripts.md. The catalogue entry is `YOUTUBE_ID`, which
 * this module imports rather than repeating — the audit checks that link, so a
 * facade cannot end up standing in for something the inventory never declared.
 */
export interface VideoFacadeProps {
  /** YouTube video id — the 11-character `v=` parameter. */
  videoId: string;
  /** Names the video. Used for the button's accessible name and the iframe's. */
  title: string;
  poster: {
    src: string;
    /**
     * Describes the poster image. Deliberately separate from `title`: a screen
     * reader user gets the button's name from `title` already, and repeating it
     * here would announce the same words twice.
     */
    alt: string;
  };
  className?: string | undefined;
}

/**
 * The player URL, built only once a visitor has activated the facade.
 *
 * Exported for the audit's benefit as much as the tests': it is the single
 * place the embed origin is turned into a request, so "does anything contact
 * the player before the press" is a question about this function's callers
 * rather than about the whole component tree.
 */
export function youtubeEmbedUrl(videoId: string): string {
  const params = new URLSearchParams({
    // See (2) above: the activation click is the user gesture.
    autoplay: "1",
    // Related videos restricted to the same channel. `rel=0` no longer removes
    // the panel — YouTube changed that in 2018 — so this is the strongest
    // available form of "do not send the viewer somewhere else", not a claim
    // that nothing is suggested.
    rel: "0",
  });

  // `encodeURIComponent` rather than trusting the caller. The id reaches this
  // from content in practice, and an id carrying `?` or `#` would otherwise
  // append parameters to a URL that is about to be given camera and microphone
  // permissions by the `allow` list below.
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

export function VideoFacade({
  videoId,
  title,
  poster,
  className,
}: VideoFacadeProps) {
  const [activated, setActivated] = React.useState(false);

  // Hover and focus both count as intent; `preconnect` is idempotent, so no
  // "have we already warmed it" flag is needed here.
  //
  // Plain function, not `useCallback`: it is only ever a DOM event handler, so
  // its identity buys nothing beyond skipping a re-render of the host element,
  // which React Compiler now decides. See docs/react-compiler.md.
  function warm(): void {
    preconnect(YOUTUBE_EMBED_ORIGIN);
  }

  if (activated) {
    return (
      <div
        // Names the catalogue entry in the DOM. It is what the end-to-end test
        // finds the embed by, and it is how someone auditing a running page can
        // tell which declared third party a frame belongs to without matching
        // URLs by eye.
        data-third-party={YOUTUBE_ID}
        data-state="activated"
        className={cn(
          "relative aspect-video overflow-hidden rounded-xl",
          className,
        )}
      >
        <iframe
          className="absolute inset-0 h-full w-full"
          src={youtubeEmbedUrl(videoId)}
          title={title}
          // Exactly the permissions the player needs to play and to offer
          // full-screen, and no more. `allow` is a Permissions Policy
          // delegation: anything listed here is granted to the third party for
          // the lifetime of the frame, so the list is the security boundary and
          // the copy-pasted vendor default — which usually includes
          // `clipboard-write` and `web-share` — grants two capabilities a video
          // player does not need to play a video.
          allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      data-third-party={YOUTUBE_ID}
      data-state="facade"
      onClick={() => setActivated(true)}
      onMouseEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
      // The poster image is decorative relative to this name — the button says
      // what pressing it does, which is what a screen reader user needs and is
      // not what an `alt` describing the still frame would say.
      aria-label={`Play video: ${title}`}
      className={cn(
        "group relative block aspect-video w-full overflow-hidden rounded-xl",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2",
        className,
      )}
    >
      <BlurImage
        src={poster.src}
        alt={poster.alt}
        fill
        containerClassName="rounded-xl"
        className="object-cover transition-transform duration-300 group-hover:scale-105"
        sizes="(max-width: 768px) 100vw, 768px"
      />

      {/* Scrim, so the play control keeps its contrast over a bright frame. */}
      <span
        aria-hidden="true"
        className="absolute inset-0 bg-black/25 transition-colors group-hover:bg-black/35"
      />

      <span
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/70 text-white transition-transform duration-200 group-hover:scale-110"
      >
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className="ml-1 h-7 w-7"
          role="presentation"
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      </span>

      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-3 pt-8 text-left text-sm font-medium text-white">
        {title}
      </span>
    </button>
  );
}
