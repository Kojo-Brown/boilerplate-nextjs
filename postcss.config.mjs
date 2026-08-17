/**
 * The one file that makes Tailwind actually run.
 *
 * Next does not compile Tailwind for you, and it does not complain when nobody
 * else does either. Without a `postcss.config.*` at the project root it hands
 * every stylesheet to Lightning CSS, which resolves `@import "tailwindcss"` as
 * an ordinary import: it reads the package's CSS, finds at-rules it has no
 * meaning for (`@tailwind`, `@utility`, `@theme`), and drops them. Nothing
 * errors. The build stays green and the production bundle ships the `:root`
 * custom properties from `globals.css` and not one utility class — 1,103 bytes
 * where there should be ~34 KB.
 *
 * That was this repository's state for weeks: `@tailwindcss/postcss` sat in
 * devDependencies, referenced by nothing, while all 14 routes rendered as
 * unstyled block flow. Presence of this file is the entire switch, which is
 * also why its absence was so easy to miss — there was no broken line to find,
 * only a file that was not there.
 *
 * Source detection is left implicit on purpose. Tailwind v4 scans the project
 * automatically, honouring `.gitignore`, and that resolves the components
 * under `src/` correctly from here — verified against the built bundle rather
 * than assumed. A `source()` override in `globals.css` would be one more thing
 * to keep pointing at the right directory for no gain.
 *
 * `scripts/assert-css-output.ts` runs against the built bundle in CI, so if
 * this file is deleted or renamed the build fails loudly instead of quietly
 * shipping an unstyled application again.
 */
/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
