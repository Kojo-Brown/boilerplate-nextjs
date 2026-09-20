# React Compiler

React Compiler is on for the whole client graph:

```ts
// next.config.ts
const config: NextConfig = {
  reactCompiler: true,
};
```

It runs through `babel-plugin-react-compiler`, which Next resolves by name — so
the package is a required devDependency, and a build without it fails with
`E78` rather than quietly skipping the transform. `@babel/core` is there for
`scripts/assert-react-compiler.ts`, which drives the same plugin directly.

Both are pinned to an exact version rather than a range. A code transform is
not a library: a patch bump changes the JavaScript every client component
compiles to, with nothing in the diff to review and no test that would
necessarily notice.

The point of enabling it is not that renders get faster on their own. It is
that `useMemo`, `useCallback` and `memo()` stop being something a reviewer has
to reason about: the compiler works out what to cache from the code, and it
does it everywhere rather than in the places someone remembered.

## What it actually does to a component

`<Dialog>` before:

```tsx
const handleOpenChange = React.useCallback(
  (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  },
  [isControlled, onOpenChange],
);

return (
  <DialogContext.Provider value={{ open, onOpenChange: handleOpenChange }}>
```

The `useCallback` was load-bearing: `<DialogContent>` lists `onOpenChange` in
an effect's dependencies, so a new identity per render tears down and
re-attaches the Escape listener and re-runs the body scroll lock on every
render of every open dialog. The context value beside it — an object literal,
allocated fresh on every render — was invalidating exactly the same effect,
which is the usual shape of hand-written memoization: the expensive thing is
wrapped and the cheap-looking thing next to it undoes the wrapping.

Compiled, both are cached, on the same dependencies the hand-written version
declared:

```js
let t2;
if ($[0] !== isControlled || $[1] !== onOpenChange) {
  t2 = function handleOpenChange(next) {
    /* … */
  };
  $[0] = isControlled;
  $[1] = onOpenChange;
  $[2] = t2;
} else {
  t2 = $[2];
}
const handleOpenChange = t2;

let t3;
if ($[3] !== handleOpenChange || $[4] !== open) {
  t3 = { open, onOpenChange: handleOpenChange };
  /* … */
}
```

So the `useCallback` came out and a plain function went in.

## The audit

Every manual memo in `src/` was looked at once, on the day the compiler was
enabled. There were four, all `useCallback`; there were no `useMemo` calls and
no `memo()` wrappers.

| Site                                                          | Outcome                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/ui/dialog.tsx` — `handleOpenChange`               | Removed. Identity still matters (`<DialogContent>`'s effect deps); the compiler provides it, and also memoizes the context value that was defeating it. |
| `app/photos/_components/photo-modal.tsx` — `handleOpenChange` | Removed. Reaches the same effect through `<Dialog>`.                                                                                                    |
| `components/third-party/video-facade.tsx` — `warm`            | Removed. Only ever a DOM event handler; its identity bought a skipped re-render of one element.                                                         |
| `components/vitals/web-vitals-reporter.tsx` — `report`        | **Kept.** See below.                                                                                                                                    |

### The one that stayed

`useReportWebVitals` is `useEffect(() => { onCLS(fn); onLCP(fn); … }, [fn])`,
and `web-vitals`'s `onX` functions return no teardown. There is nothing for the
effect to clean up, so a new function identity does not _replace_ the previous
subscription — it _adds_ one. An unstable callback would register a fresh set
of six listeners on every render, and one layout shift would be reported once
per render the page had ever done.

That is a correctness requirement, and React Compiler does not offer one. Its
memoization is an optimization it is free to drop: a bail-out anywhere in the
component silently removes it, and the symptom here would be inflated numbers
in a dashboard nobody reads per-commit rather than a failing test. `useCallback`
is the form of this that React guarantees, so it stays, tagged:

```tsx
/**
 * @memo-keep Correctness, not performance. …
 */
const report = useCallback(/* … */);
```

The tag is the rule. With the compiler on, a surviving `useMemo`/`useCallback`/
`memo()` is either load-bearing for correctness or a leftover nobody deleted,
and those look identical in a diff — so `scripts/assert-react-compiler.ts`
fails on any memo without a `@memo-keep <reason>` comment against it, and on a
reason too short to act on.

## The failure mode worth knowing about

`panicThreshold` defaults to `"none"`, which means the compiler **skips what it
cannot compile**. No error, no warning, no difference in the build output. A
component in that state ships with no memoization at all — including whatever
was removed from it on the understanding that the compiler had taken over.

One component was in exactly that state when the compiler was first enabled.
`ImageUpload` contained:

```tsx
try {
  // …
  onUploadComplete?.(publicUrl);
} catch (error) {
  const msg = error instanceof Error ? error.message : "Upload failed";
}
```

React Compiler does not support a value block — a conditional, a logical
operator, an optional call — inside a `try`/`catch`, and it fails the _whole
enclosing component_, not the statement. The XHR body now lives in
`putToPresignedUrl`, a module-scope async function: not a component and not a
hook, so the compiler skips it by design and the bail-out has nowhere to
propagate to. `ImageUpload` compiles.

Finding that required asking the compiler, which is what the gate does.

## The gate

`scripts/assert-react-compiler.ts`, run in the `build` job after `pnpm build`:

| Rule | What it fails on                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1   | `next.config.ts` does not set `reactCompiler: true` (including `compilationMode: "annotation"`, which is a different feature).                   |
| R2   | `.next/required-server-files.json` says the build that produced this output resolved it to something else — a renamed option, an ignored config. |
| R3   | `babel-plugin-react-compiler` or `@babel/core` is undeclared.                                                                                    |
| R4   | Any component in the client graph bails out. Runs the real plugin over every `"use client"` entry point and everything it imports.               |
| R5   | A manual memo with no `@memo-keep` reason, or a reason under 24 characters.                                                                      |
| R6   | A `"use no memo"` directive with no reason — the same de-optimization from the other side.                                                       |

R4's scope is the client graph and not `src/`, because that is the only code
the compiler is ever handed: Next passes the plugin on the client build only,
so a Server Component using an unsupported construct is not a finding.

There is deliberately no assertion over the emitted chunks. Compiled output is
identifiable in a production bundle only by the shape minification happens to
leave behind (`r.H.useMemoCache`, this week) — a check that would fail on a
Terser upgrade and pass on a real regression. R2 reads a manifest Next writes
on purpose instead.

## Adding a component

Nothing to do. Write it without memoization; the compiler handles it. If CI
tells you it bailed out, the message carries the compiler's own reason and the
fix is usually to move the offending expression into a module-scope helper, as
`putToPresignedUrl` was.

Reach for `useMemo`/`useCallback`/`memo()` only when the memoization is
load-bearing for correctness rather than speed — a subscription keyed on
identity, an object handed to something outside React that compares by
reference — and write the reason down in a `@memo-keep` tag. Otherwise CI asks
for one.
