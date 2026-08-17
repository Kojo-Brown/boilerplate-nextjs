# Styling

TailwindCSS 4, compiled through PostCSS, with the design tokens kept as plain
CSS custom properties and published into Tailwind's colour namespace.

This document exists mostly because of how this setup failed. For six weeks the
application shipped with no compiled CSS at all and nothing noticed, so the
first section is the failure rather than the happy path.

## The failure this setup is built around

`@tailwindcss/postcss` was in `devDependencies`. `globals.css` began with
`@import "tailwindcss"`. `next build` exited 0, 223 unit tests passed, and the
route-shape gate was satisfied. The production stylesheet was **1,103 bytes**:
the `:root` custom properties and not one utility class. Every one of the 14
routes rendered as unstyled block flow.

There was no broken line to find. The bug was a file that did not exist.

Next only runs PostCSS when a `postcss.config.*` sits at the project root.
Without one it hands stylesheets to Lightning CSS, which treats
`@import "tailwindcss"` as an ordinary import: it resolves the package, reads
its CSS, finds `@tailwind` / `@utility` / `@theme` — at-rules it has no meaning
for — and drops them. That is not an error in Lightning CSS's model, so nothing
is reported. The tail of the broken bundle was a literal
`@utility primary{background-color: var(--primary);}`, Tailwind's own syntax
copied verbatim into a file the browser was expected to parse and silently
discarded.

Adding [`postcss.config.mjs`](../postcss.config.mjs) takes the same bundle to
~34 KB. That file is the entire switch.

## How the pieces fit

```
postcss.config.mjs          registers @tailwindcss/postcss — the switch
src/styles/globals.css      @import "tailwindcss", tokens, @theme inline
scripts/assert-css-output.ts  CI gate: reads the built CSS, fails if empty
```

### Tokens are CSS custom properties

`:root` and `.dark` in `globals.css` define `--primary`, `--muted-foreground`,
`--border` and friends. Keeping them as ordinary custom properties rather than
Tailwind theme values is deliberate: about forty call sites read them directly
through `style={{ color: "var(--muted-foreground)" }}` or
`text-[var(--muted-foreground)]`, and inline styles cannot reach a value that
only exists inside Tailwind's compiler.

### `@theme inline` publishes them as utilities

```css
@theme inline {
  --color-primary: var(--primary);
  --color-muted-foreground: var(--muted-foreground);
  /* … */
}
```

This is what generates `bg-primary`, `text-muted-foreground`, `ring-border`,
`border-border` and the rest of the semantic colour utilities.

`inline` is load-bearing. Without it Tailwind emits its own `--color-*` custom
properties and resolves utilities against those, freezing in whatever the
variable held at `:root` — so `bg-background` would keep the light value inside
`.dark`. With it, the `var()` is substituted into the utility itself and the
`.dark` override applies normally.

This block replaced three `@utility` rules that were reaching for the same
thing and could not get there:

```css
/* what was there — defines `.primary`, not `bg-primary` */
@utility primary {
  background-color: var(--primary);
}
```

`@utility primary` defines a bare `.primary` class. Nothing in the codebase
uses `class="primary"`; the landing page asks for `bg-primary`, the auth forms
for `bg-muted`, the avatar for `ring-border`. All of them were requesting
utilities that had never existed — invisible for as long as no utility compiled
at all.

## Writing styles here

- Reach for the semantic utility (`bg-muted`, `text-muted-foreground`) in
  markup. It is shorter than the arbitrary-value form and reads as intent.
- Use `var(--token)` directly when you need the value in an inline `style`, or
  in a property with no semantic utility.
- `cn()` from `@/lib/cn` merges conditional classes; it wraps `tailwind-merge`,
  so a later `bg-*` genuinely replaces an earlier one instead of both landing in
  the class list.
- Adding a token means adding it in three places: `:root`, `.dark`, and
  `@theme inline` if it should be reachable as a utility.

## The gate

```bash
pnpm build && pnpm exec tsx scripts/assert-css-output.ts
```

Runs in CI after the build, alongside the route-shape gate. It reads the CSS
the build actually wrote under `.next/static` and fails if:

- no stylesheet was emitted;
- the total is under 15 KB, the coarse net for "Tailwind did not run";
- a `@tailwind`, `@utility`, `@theme`, `@apply`, `@source` or `@custom-variant`
  at-rule survived into the output — the precise fingerprint of the original
  bug;
- any of eleven required utilities is missing. They span the families that fail
  independently — a core utility, grid and positioning, an arbitrary value, a
  responsive variant, a state variant, and the `@theme inline` colours. Deleting
  the `@theme` block costs about 200 bytes and leaves `flex` intact, so a size
  check alone would not see it; the three colour entries are there for that
  case.

Every required utility is one this application genuinely uses, because Tailwind
generates on demand — requiring a class nothing references would fail a
perfectly healthy build.

The gate was verified the only way that means anything: `postcss.config.mjs`
was moved aside, the project rebuilt, and the build again exited 0 while the
gate exited 1 with 13 violations.

## Known gap

`src/app/blog/[slug]/page.tsx` applies `prose prose-neutral` to the post body.
Those classes come from `@tailwindcss/typography`, which is not a dependency,
so they still compile to nothing and the post body renders with unstyled
paragraph spacing. Adding the plugin is a dependency decision rather than part
of getting Tailwind to run, so it is left as a follow-up rather than folded in
here — it is the one place the application is still unstyled on purpose.
