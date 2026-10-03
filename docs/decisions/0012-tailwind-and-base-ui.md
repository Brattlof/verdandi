# 0012 · The web UI is styled with Tailwind, and its widgets come from Base UI

## Status

Accepted (2026-09-30). Replaces "shadcn/ui" in the DESIGN §19 UI kit row.

## Context

The web UI started on one hand-written stylesheet of about 500 lines. It was about to get the widgets that are easy to get subtly wrong by hand: tabs (the diff panel had a hand-rolled `role="tablist"` without arrow keys), menus, popovers, dialogs, tooltips and a command palette. Accessibility is something we never cut, and its hardest part is keyboard and focus behaviour.

DESIGN §19 named Tailwind 4 and shadcn/ui. shadcn/ui copies styled components into the repo on top of a primitive library. We only want the primitives, so we can style them the same way as everything else.

Two things were unproven: whether Tailwind runs inside Bun's HTML-import bundler, which verdandid uses to serve the UI (`routes: { "/": web }`), and whether it works in a `bun build --compile` binary that is started outside the repo.

## Decision

1. **Tailwind 4 through `bun-plugin-tailwind`** (made by Tailwind Labs). `bunfig.toml` sets `[serve.static] plugins`, so the stylesheet compiles when the page is first bundled (by verdandid then; by `verdandi web` since ADR 0026). The spike confirmed it on macOS for both paths: Bun's runtime HTML import, and `Bun.build({ compile, plugins: [tailwind] })` started from another folder. A release build has to pass the plugin to `Bun.build`, because bunfig is read from the directory Bun runs in.
2. **The theme holds only our colours** (`--color-*: initial`) and **has no animations** (`--animate-*: initial`), so the no-animation rule is also a missing class. Colours are the same `light-dark()` tokens as before, under Tailwind names (`bg-panel`, `border-line`, `text-muted`).
3. **Styling is utilities on the element.** `styles.css` keeps only three things: the theme, base rules for native controls (buttons, inputs, `pre`), and the element rules for rendered Markdown, because `markdown.tsx` emits bare elements.
4. **Base UI (`@base-ui/react`), used directly, without shadcn/ui.** It is unstyled, so Tailwind classes style it and its `data-*` state attributes (`data-active:`). Widgets are adopted one at a time when a view needs them. The first one is the diff panel's tabs.

## Consequences

- `bun-plugin-tailwind` declares a peer dependency on `bun`, so `bun.lock` lists the `bun` npm package and its platform packages. Nothing runs: lifecycle scripts stay off, and no `bun` binary lands in `node_modules/.bin`. Turning off automatic peer installs (`peer = false`) would have removed it, but it also stopped React from being linked for `@base-ui/react` and `@tanstack/react-virtual`.
- Tailwind's engine is a native binary vendored in the plugin. It only runs at build time, so the shipped binary contains only the generated CSS. It has not been checked on Windows or Linux yet: CI didn't run.
- Biome parses Tailwind directives (`css.parser.tailwindDirectives`).
- If bunfig isn't found, verdandid returns a 500 for the page instead of an unstyled page. The server test checks that the stylesheet is compiled.
