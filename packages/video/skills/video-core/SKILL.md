---
name: video-core
description: The composition contract for Verdandi videos as its runtime implements it. Covers the root attributes, clip timing (data-start, data-duration, references to other clips), tracks, data-hidden, sub-compositions and their scoping, variables, video and audio, registering paused GSAP timelines, and other seekable runtimes (CSS, Web Animations, Lottie, anime.js, vd-seek for canvas or Three.js), plus the determinism rules. Load it before writing or editing composition HTML in a `verdandi video` project.
---

# The composition contract

The runtime is injected into every page, before any of your scripts. It mounts sub-compositions, shows each timed
element only inside its window, seeks every animation runtime to the current time, and owns `<video>` and
`<audio>` playback. Preview and render run the same code, so what the Studio shows is what renders.

References, to read when you need them:

| File | For |
|---|---|
| `references/attributes.md` | every `data-*` attribute and page global, with defaults |
| `references/sub-compositions.md` | scene files, hosts, scoping, mounting a file twice, variables per instance |
| `references/animation.md` | GSAP in detail, CSS and Web Animations, Lottie, anime.js, canvas and Three.js, seeded randomness |

## The root (`index.html`)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="vendor/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: #0b0b0c; }
      .scene { position: absolute; inset: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="10" data-width="1920" data-height="1080">
      <div id="intro" class="clip scene" data-composition-id="intro" data-composition-src="compositions/intro.html"
           data-start="0" data-duration="5" data-track-index="0"></div>
      <div id="outro" class="clip scene" data-composition-id="outro" data-composition-src="compositions/outro.html"
           data-start="intro" data-duration="5" data-track-index="0"></div>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      window.__timelines.main = tl;
    </script>
  </body>
</html>
```

- The root is the element with `data-composition-id`, or the one with `data-root="true"` if there are several.
  It needs `data-width` and `data-height` (the canvas) and `data-duration` (the length in seconds). Without
  `data-duration` the length is guessed from the clips and timelines.
- Keep the `<script src="vendor/gsap.min.js">` in the root's `<head>`. Sub-compositions use the same `gsap`.
- Never wrap the root in `<template>`. Only sub-composition files use `<template>`.

## Timing

- A **clip** is any element with `data-start`. Give it an `id` and `class="clip"` too. `class="clip"` is a
  convention and the runtime doesn't need it; the `id` is how the timeline, references and findings name it.
- `data-start` is seconds (`"2.5"`), or another clip's end: `"intro"`, `"intro + 0.5"` or `"intro - 0.5"`
  (an overlap). The reference is an element `id` or a `data-composition-id` anywhere in the project; lint
  reports one that names nothing (`unknown_start_reference`). Confirm start times with `verdandi video timeline`.
- `data-duration` is positive seconds. Without it, a clip lasts the length of its media, its sub-composition's
  timeline, or 3 seconds for an `<img>`. Any other element runs to the end.
- A clip shows over **[start, end)**. At t = end it's already gone, so back-to-back clips never overlap by a
  frame. The one exception is the final frame: a clip that runs to the root's end also shows at t = duration,
  so the last frame is never blank.
- `data-start` inside a sub-composition is relative to that scene's start.
- The runtime hides a clip outside its window by setting `visibility`. **Never tween `visibility`, `display` or
  `autoAlpha` on a clip.** Fade it with `opacity`, or animate a child of it.
- `data-track-index` only chooses the lane in the Studio's timeline. It doesn't affect timing or stacking.
  Stacking follows DOM order and `z-index`, so later elements draw on top.
- `data-hidden` (no value needed) removes an element from both preview and render, whatever its window. The
  Studio's H key toggles it. Remove the attribute to bring the element back.
- The root's direct children that have `data-start` get `position: absolute` with no size. Give every clip an
  explicit box: for a scene, `position: absolute; inset: 0`.

## Sub-compositions, in short

A scene file wraps everything in `<template>`. Its root carries `data-composition-id` and the canvas size, and
its `<style>` and `<script>` go **inside** the template:

```html
<template>
  <div id="intro-root" data-composition-id="intro" data-width="1920" data-height="1080">
    <style>
      h1 { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 120px; }
    </style>
    <h1 class="title">Hello</h1>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.from(".title", { opacity: 0, y: 40, duration: 0.8, ease: "power2.out" });
      window.__timelines["intro"] = tl;
    </script>
  </div>
</template>
```

The host in `index.html` sets the timing: `data-composition-id`, `data-composition-src` (the path from the
project root), `data-start` and `data-duration`. Prefer mounting every scene from `index.html`; a host inside a
scene file names its file relative to that scene file (`parts/badge.html` from `compositions/card.html`). Only
classic scripts run in a scene: lint rejects a `<script type="module">` there. Inside a scene, CSS is scoped to it, and so are `document.querySelector*` and
`getElementById`, and the string selectors given to `gsap.to/from/fromTo/set` and `tl.to/from/fromTo/set`.
Class names can therefore repeat across scenes. Scripts in `index.html` are **not** scoped: there, a selector
like `.title` also matches every scene's `.title`, so target root-level elements by `id`. To mount the same
file twice, see `references/sub-compositions.md`.

## Variables, in short

Declare them on a composition root:

```html
data-composition-variables='[{"id":"title","type":"string","label":"Title","default":"Hello"}]'
```

The types are `string`, `number`, `color`, `boolean`, `enum` (needs `options`) and `image`. A host overrides
them for one mount with `data-variable-values='{"title":"Hi"}'`, and `render --variables '<json>'` overrides
them for the whole video. The runtime applies them in three ways:

- each scalar becomes the CSS custom property `--<id>` on the composition, as in `color: var(--accent)`;
- `data-var-text="<id>"` replaces an element's text;
- `data-var-src="<id>"` sets the `src` of an `img`, `video`, `audio` or `source`.

Scripts read them with `__verdandi.getVariables()`.

## Media, in short

```html
<video id="broll" src="assets/broll.mp4" data-start="2" data-duration="4" muted></video>
<audio id="music" src="assets/music.mp3" data-start="0" data-duration="10" data-volume="0.6"></audio>
```

- Every `<video>` and `<audio>` needs a unique `id`, `data-start`, and a `src` (or a `<source>`) pointing at a
  file in the project. A `<video>` also needs `muted` (picture only) or `data-has-audio="true"` (keep its sound).
- `data-playback-start` is the source time to start from (to trim the head). `data-playback-rate` sets the speed
  (0.1 to 10), `data-volume` the gain (0 to about 4, fixed for the whole clip), and `loop` repeats the file to
  fill the window.
- Close the tag: write `<video …></video>`, never `<video … />`.
- Don't put `data-start` on both a `<video>` and a plain element that wraps it; time one of them. A scene host
  wrapping a timed `<video>` is fine.
- **Never** call `play()`, `pause()` or set `currentTime` from a script. The runtime plays media in preview and
  paints decoded frames in a render.

## Animation, in short

- **One paused GSAP timeline per composition**, registered once it's fully built:
  `window.__timelines["<that composition's data-composition-id>"] = tl`. Lint rejects a key that doesn't match
  a composition in the same file. Never call `play()`. The runtime seeks each timeline at its scene's local
  time and holds the last frame past the timeline's end.
- CSS `@keyframes` animations and `element.animate()` are seeked too, relative to the nearest timed ancestor.
  CSS **transitions** are not, so a render misses them.
- Lottie, anime.js, canvas and Three.js work through the hooks in `references/animation.md`.

## Determinism: every frame must render the same way every time

- No `Math.random()`, `Date.now()`, `new Date()`, `performance.now()`, `crypto.getRandomValues()`, GSAP
  `random(…)` or `requestAnimationFrame` loops. Use a seeded generator (`references/animation.md`).
- No `repeat: -1` unless the root has a `data-duration`.
- Nothing from the network: put scripts in `vendor/`, and fonts and media in `assets/`. Load fonts with
  `@font-face` and a relative `url()`.
- Use relative paths (`assets/x.png`), not `/assets/x.png`. The Studio serves the project under its own path
  prefix, so a leading `/` points outside the project there.
- Don't depend on input, hover, scroll position or the window size.
