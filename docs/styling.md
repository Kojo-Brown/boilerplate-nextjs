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
src/styles/globals.css      @import "tailwindcss", tokens, @theme inline,
                              @plugin typography, @utility prose-app
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

### Long-form text: `prose prose-app`

`@tailwindcss/typography` supplies `prose`, which styles a block of ordinary
HTML — paragraph rhythm, measure, list markers, code and table treatment —
without a class on every element. `app/blog/[slug]` is the one place that needs
it.

The plugin ships fixed palettes (`prose-neutral` paints the body `neutral-700`,
`prose-invert` paints it `slate-300`). Neither is `--foreground`, so both would
drift from the rest of the application the first time a token moved.
`@utility prose-app` in `globals.css` re-points every `--tw-prose-*` variable
at the design tokens instead:

```css
@utility prose-app {
  --tw-prose-body: var(--foreground);
  --tw-prose-links: var(--primary);
  /* … */
}
```

Use it as `class="prose prose-app"`. Add `max-w-none` where a layout already
sets the reading width, or prose's own 65ch becomes a second, narrower column
inside it.

**Do not reach for `dark:prose-invert`.** `next-themes` runs with
`attribute="class"` and toggles `.dark`, while Tailwind v4's built-in `dark:`
variant still resolves to `prefers-color-scheme` — so a `dark:` utility here
follows the operating system and ignores the theme toggle. Reading tokens
through `var()` avoids the question: `.dark` reassigns `--foreground`, and
because `prose-app` holds `var()` references rather than resolved colours,
prose re-reads them and follows the toggle with no dark-mode rule at all.

That `dark:` mismatch is not confined to prose — `dark:bg-green-950` and
similar appear in `toast-demo`, `image-upload`, `post-card` and
`posts-manager`, and all of them track the OS rather than the toggle. Fixing it
means declaring `@custom-variant dark (&:where(.dark, .dark *))`, which changes
behaviour across those components; it is tracked in `SPEC.md` rather than
folded in here.

`prose-app` and the plugin's `.prose` are both single class selectors emitted
into `@layer utilities`, so neither specificity nor layer order decides between
them — `prose-app` wins only because the compiler emits it second. The CSS gate
asserts that ordering (see below) rather than trusting it.

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
- any of thirteen required utilities is missing. They span the families that
  fail independently — a core utility, grid and positioning, an arbitrary value,
  a responsive variant, a state variant, the `@theme inline` colours, and the
  typography plugin. Deleting the `@theme` block costs about 200 bytes and
  leaves `flex` intact, so a size check alone would not see it; the three colour
  entries are there for that case, and `prose` / `prose-app` for the equivalent
  one line up, where dropping `@plugin "@tailwindcss/typography"` leaves every
  other check satisfied;
- `.prose-app` stops being emitted after `.prose`. Same-layer, same-specificity
  rules are decided by emission order alone, so the token bindings would lose
  to the plugin's fixed greys with nothing else changing.

Every required utility is one this application genuinely uses, because Tailwind
generates on demand — requiring a class nothing references would fail a
perfectly healthy build.

The gate was verified the only way that means anything: `postcss.config.mjs`
was moved aside, the project rebuilt, and the build again exited 0 while the
gate exited 1 with 13 violations. The typography entries were verified the same
way — deleting the `@plugin` line and rebuilding leaves `next build` at exit 0
and fails the gate on `.prose`.

## Known gaps

- The `dark:` variant does not track the theme toggle; see the note under
  `prose prose-app` above.
- Nothing renders markdown. `Post.content` is plain text from a `<textarea>`,
  and `toParagraphs` in `@/lib/prose` splits it on blank lines so `prose` has
  real paragraphs to space. An author's `#` or `*` stays literal, which is the
  honest reading of a plain-text column.
