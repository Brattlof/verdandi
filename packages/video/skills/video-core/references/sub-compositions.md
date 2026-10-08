# Sub-compositions

## File shape

`compositions/<name>.html`:

```html
<template>
  <div id="<name>-root" data-composition-id="<name>" data-width="1920" data-height="1080"
       data-composition-variables='[{"id":"headline","type":"string","label":"Headline","default":"Hello"}]'>
    <style>
      /* Scoped to this mount. html, body and :root mean the scene itself. */
      .headline { position: absolute; left: 96px; top: 96px; font-size: 96px; color: var(--accent, #e0a458); }
    </style>
    <h1 class="headline" data-var-text="headline">Hello</h1>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.from(".headline", { opacity: 0, x: -40, duration: 0.6, ease: "power3.out" });
      window.__timelines["<name>"] = tl;
    </script>
  </div>
</template>
```

- Put the `<style>` and `<script>` **inside** `<template>`. A templated file's `<head>` is ignored.
  `<link rel="stylesheet">` is hoisted into the page.
- A file without `<template>` also works: its `<body>` is mounted, with its `<head>` styles and scripts.
- Only classic scripts run. Lint rejects a `<script type="module">` inside a sub-composition
  (`module_script_in_sub_composition`), and the runtime logs an error if one gets through.
- The inner root's `data-start`, `data-duration` and `data-track-index` are dropped. The **host** decides
  timing.
- The inner root gets the file's `data-width` × `data-height` as its size. Position things inside it relative to
  the host: give the host `position: absolute; inset: 0`, or a box of its own for an overlay.

## Host

```html
<div id="intro" class="clip scene" data-composition-id="intro" data-composition-src="compositions/intro.html"
     data-start="0" data-duration="4" data-track-index="0"
     data-variable-values='{"headline":"Q3 in numbers"}'></div>
```

- Use the same id for the host's `id` and `data-composition-id`, the file's inner `data-composition-id`, and the
  `window.__timelines` key. A host id that differs from the file's id still works: the file's registration is
  redirected to the host's id.
- The host must be empty. Whatever it contains is replaced by the mounted scene.
- `data-composition-src` is relative to the file the host is in: for a host in `index.html`, the project root;
  for a host nested in `compositions/card.html`, `compositions/`. Relative `src`, `href`, `poster`,
  `data-var-src` values and CSS `url()`s inside a scene file are likewise relative to that file
  (`../assets/x.png` from `compositions/`).
- Without `data-duration`, the host lasts as long as the scene's registered timeline. Set it explicitly anyway,
  so the root's length and the following `data-start` references are what you planned.
- Inside the scene, `data-start` values are relative to the host's start.

## What a scene's script sees

The runtime runs each scene script inside a function whose globals are scoped to the mount:

| Name | Scoped behaviour |
|---|---|
| `document.querySelector`, `querySelectorAll`, `getElementById` | Search only inside this mount. The inner root's id as written in the file finds it (`"#<name>-root"`). `querySelectorAll` returns an array. |
| `gsap.to/from/fromTo/set`, `tl.to/from/fromTo/set`, `gsap.utils.toArray` | A string selector, or an array of them, resolves inside this mount (`"#<name>-root"` included). Elements pass through unchanged. |
| `window.__timelines` | Writing the file's own id writes the mount's id. |
| `__verdandi` | This mount's variables and asset URLs. |

**Not scoped:** `gsap.utils.selector`, other tween methods given a string selector, and anything reached
through `document.body` or `document.documentElement`. Resolve elements with the scoped
`document.querySelectorAll` and pass them in. Top-level `const` and `let` are local to the script, so
every scene can declare its own `tl`.

Scripts in `index.html` itself are ordinary page scripts, with nothing scoped. Their selectors match elements in
every mounted scene too, so in the root, target your own elements by `id`.

## Mounting one file twice

Mount the same file with two hosts, each with its own `id`, `data-composition-id`, `data-start` and
`data-variable-values`. The runtime keeps the first mount's id, and if two hosts share a
`data-composition-id`, it renames the second to `<id>__vd2` (then `__vd3`, …), so give each host its own id
up front. Element ids **inside** the file aren't renamed and appear once per mount. Scoped lookups still find
the right one, but `#id` selectors in `index.html` and duplicate media ids don't. Inside a reusable scene, use
classes, not ids.

## Inline templates

Instead of a file, a page can hold `<template id="<id>-template">…</template>` and an empty host
`<div data-composition-id="<id>" data-start=… data-duration=…></div>`. It mounts the same way. Files are easier
to lint, reuse and edit in the Studio, so prefer them.

## Blocks

`verdandi video add <block>` copies a ready-made sub-composition into `compositions/` and prints its host.
Blocks are ordinary scene files, so edit the copy freely. `add --force` replaces it and discards your edits.
The `lower-third` block, for example, takes `name`, `role` and `accent` variables, runs 5 s, and positions itself
in the lower left of a 1920×1080 canvas. Time it to overlap a scene, on a higher `data-track-index`, after the
scene in DOM order so it draws on top.
