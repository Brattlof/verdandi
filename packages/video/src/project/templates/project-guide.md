# Video project

This folder is a Verdandi video composition: HTML that renders to video. `index.html` is the root composition.

- The `#title` heading in a new project and its tween in the script are a sample: remove both together when you
  replace them, or the timeline animates an element that no longer exists.
- Run `verdandi video lint` after every edit, `verdandi video snapshot --at <seconds>` to look at frames, and
  `verdandi video render` only once the user approved what they saw.
- The root element carries `data-composition-id`, `data-width`, `data-height` and `data-duration` (seconds).
- Timed elements carry `class="clip"`, an `id`, `data-start` and `data-duration`. `data-start` is seconds, or
  `<id> + n` to follow another clip. The runtime shows each clip only inside its window: never animate a clip's
  `visibility`, `display` or `autoAlpha` yourself.
- Animate with one paused GSAP timeline per composition, registered as `window.__timelines["<composition id>"]`
  once it is fully built. Never call `play()`, and never use `Math.random()`, `Date.now()` or
  `requestAnimationFrame`: every frame must look the same each time it is rendered.
- `<video>` and `<audio>` need an `id` and `data-start`; the runtime plays and seeks them. A video needs `muted` or
  `data-has-audio`. Put media files in `assets/`.
- Reuse a composition with `<div data-composition-id="x" data-composition-src="compositions/x.html" data-start=…>`;
  the file wraps its root in `<template>` with its `<style>` and `<script>` inside.
