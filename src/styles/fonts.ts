/**
 * The application's two typefaces, self-hosted by `next/font`.
 *
 * Until this module existed the body stack was `system-ui, sans-serif` and the
 * `font-mono` utilities scattered across `/blog`, `/photos` and `/upload`
 * resolved to Tailwind's default `ui-monospace` stack. That renders, and it
 * renders a different document on every operating system — which is a design
 * decision if it was taken and an accident if it was not.
 *
 * What `next/font` does that a `<link>` to `fonts.googleapis.com` does not:
 *
 * 1. **The font files are downloaded at build time and served from this
 *    origin.** No request to `fonts.googleapis.com` for the CSS, no request to
 *    `fonts.gstatic.com` for the file. That removes two DNS lookups and two TLS
 *    handshakes to a third party from the critical path — and it removes them
 *    from the *render-blocking* part of it, because the stylesheet link was a
 *    blocking request to a host the browser had not yet connected to. It is
 *    also the only arrangement a strict CSP can describe without widening
 *    `style-src` and `font-src` to a third-party origin, which Phase 11 will
 *    care about.
 *
 * 2. **The requested subset is preloaded from the document**, so the browser
 *    starts fetching the font file immediately rather than after it has parsed
 *    a stylesheet that it first had to fetch.
 *
 * 3. **A metric-matched fallback face is generated**, which is the half of the
 *    feature a visitor perceives — see the note below, and the long comment
 *    above `@font-face` in `globals.css`.
 *
 * `scripts/assert-font-loading.ts` asserts all of it against the build output,
 * because every one of these properties is invisible from the source: a
 * `subsets` entry deleted, a `display` changed, a fallback face whose numbers
 * have drifted from the metrics they were derived from, a family list
 * reordered, or a `fonts.googleapis.com` link re-introduced by a copy-pasted
 * snippet all build, lint, typecheck and test exactly as they do now.
 *
 * ---
 *
 * **`fallback` is not a free safety net — it replaces the metric-matched
 * face.** This is the sharpest edge in this file and it took two builds to
 * see. Declared with `fallback: ["system-ui", "arial", "sans-serif"]` and
 * `adjustFontFallback: true`, this build emitted no adjusted `@font-face` at
 * all and resolved the family to `"Inter", system-ui, arial, sans-serif`:
 * under Turbopack, supplying `fallback` is what decides whether the generated
 * fallback exists, and an option that reads as *additional* fallbacks is in
 * fact a switch that turns the anti-CLS machinery off. Nothing warns. The
 * build is a second faster and the pages shift.
 *
 * `adjustFontFallback` is the option that is *supposed* to decide this, and in
 * this build it decides nothing: with `adjustFontFallback: false` and no
 * `fallback`, the adjusted faces were emitted anyway. Its implementation lives
 * in `next/dist/build/webpack/loaders/next-font-loader/postcss-next-font.js`,
 * which Turbopack does not run. So it is left unset here rather than set to
 * the value that describes what happens — writing `true` would suggest the
 * flag is load-bearing, and writing `false` would suggest CLS protection had
 * been declined. The gate asserts the emitted CSS instead, which is the only
 * statement about this that cannot go stale.
 *
 * **On subsetting.** `subsets: ["latin"]` decides which font files are
 * *preloaded*, and that is the decision that costs bytes on the critical path.
 * Inter publishes seven subsets (`cyrillic`, `cyrillic-ext`, `greek`,
 * `greek-ext`, `latin`, `latin-ext`, `vietnamese`); all seven are emitted and
 * referenced by `unicode-range`, so a page that renders Greek still gets Greek,
 * but only `latin` is preloaded and only `latin` is fetched for a page whose
 * text is English. The other six cost nothing until a glyph needs them.
 *
 * This is the option that is dangerous to copy without thinking: an
 * application localised into Greek or Vietnamese should preload those subsets
 * rather than discover them a round trip late. `next/font` refuses to build
 * without either `subsets` or `preload: false`, which is the right default —
 * the failure it prevents is silent.
 *
 * **On the missing axis.** Inter is a variable font with two axes, `wght` and
 * `opsz`. Only `wght` is requested (it is the default; `axes` is what adds the
 * others), because optical sizing costs bytes on the critical path and nothing
 * in this application varies type size enough to see it.
 *
 * **On the missing italic.** Neither face requests `style: ["normal",
 * "italic"]`. An italic face is a second file, and it would be downloaded to
 * serve the `<em>` elements in blog post bodies. The browser synthesises an
 * oblique instead, which is worse typography and better loading; revisit it if
 * this boilerplate grows a page where real italics carry meaning.
 */
import { Inter, JetBrains_Mono } from "next/font/google";

/**
 * Why the CSS variables are named after the typeface rather than its role.
 *
 * Tailwind v4 generates the `font-sans` utility from a theme variable that is
 * itself called `--font-sans`, so handing that name to `next/font` would leave
 * two different mechanisms writing one property: the class Next puts on
 * `<html>` sets `--font-sans` to the generated family list, and `@theme` in
 * `globals.css` sets it to whatever the theme says. The winner would depend on
 * cascade order between a class attribute and a `:root` rule, which is not a
 * thing to build a type system on.
 *
 * Naming the raw families `--font-inter` and `--font-jetbrains-mono` keeps the
 * two layers separate: `next/font` owns the family list, and `globals.css`
 * decides that `--font-sans` is `var(--font-inter)` plus a generic tail. The
 * role can be re-pointed at a different typeface by editing one line there.
 */
export const sans = Inter({
  subsets: ["latin"],
  // `swap` over `block`: a blocking period renders nothing at all for up to
  // three seconds on a slow connection, which trades a shift the metric
  // override has already made imperceptible for text the visitor cannot read.
  // `optional` is the other defensible answer and is weighed in docs/fonts.md.
  display: "swap",
  variable: "--font-inter",
  // No `fallback`, deliberately — see the note in the module comment. Omitting
  // it is what lets the build emit `Inter Fallback`, whose `size-adjust`,
  // `ascent-override`, `descent-override` and `line-gap-override` make a line
  // of Arial occupy the same box as the same line of Inter, so that the swap
  // when the real font arrives changes the glyphs and not the layout. The
  // generic tail this would otherwise have supplied is in `globals.css`,
  // *after* that face, where it cannot displace it.
});

/**
 * The monospace face, and the one place this module overrides Next's own
 * choice of metric donor.
 *
 * `next/font` picks the donor by category: Times New Roman for a serif, Arial
 * for everything else — monospace included. For JetBrains Mono that means
 * scaling Arial by 134.59% so their *average* advance agrees, and average is
 * the wrong statistic for a monospace face. Arial's advances do not agree with
 * each other, so a fallback line of code has the right total width and the
 * wrong width everywhere within it: inline `font-mono` spans sit inside
 * flowing paragraphs on `/blog` and `/photos`, and a span that measures
 * differently moves the wrap point of the paragraph around it, which moves
 * every line after it. That is a layout shift the anti-CLS machinery is
 * supposed to prevent and, donor chosen this way, causes.
 *
 * Courier New is monospace, is on every desktop platform, and its advance —
 * 1229/2048 em against JetBrains Mono's 600/1000 — is the same 0.6 em to
 * within two hundredths of a percent. So `JetBrains Mono Metric Fallback` in
 * `globals.css` declares that pairing, and `fallback` here names it. Passing
 * `fallback` at all is what suppresses the Arial-donor face the build would
 * otherwise generate, which in this one case is the behaviour we want; the
 * gate asserts the resolved order, so if a future Turbopack stops suppressing
 * it and puts the Arial face back in front, CI says so rather than the code
 * quietly reverting to the worse of the two.
 */
export const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
  fallback: ["JetBrains Mono Metric Fallback", "ui-monospace", "monospace"],
});

/**
 * The class that publishes both families as CSS variables.
 *
 * Belongs on `<html>` and only on `<html>`: `globals.css` resolves
 * `--font-sans` and `--font-mono` from these in `@theme`, which is emitted at
 * `:root`, so a variable defined any deeper in the tree is out of scope for
 * the rules that read it and every `font-sans` utility in the application
 * silently falls back to the generic stack.
 *
 * `next/font` also exposes `.className` and `.style`, which apply a family
 * directly. They are deliberately unused here — applying the family by class
 * would put the font on one element and leave its descendants inheriting
 * whatever the cascade gave them, and applying it in two places is how a
 * codebase ends up with two sources of truth for its type.
 */
export const fontVariables = `${sans.variable} ${mono.variable}`;
