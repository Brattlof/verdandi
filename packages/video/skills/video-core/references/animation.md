# Animation runtimes

Nothing in a composition runs on its own clock. Every runtime is **seeked** to the frame's time, so the same time
always draws the same frame. During a render (and `check`, `snapshot` and `timeline`), `Date`, `Date.now()`,
`performance.now()` and `requestAnimationFrame` are replaced by a frozen clock. Don't rely on that: lint still
rejects them, and the Studio preview runs on a real clock.

## GSAP (the default)

- Build the timeline with `gsap.timeline({ paused: true })`, add tweens, then register it:
  `window.__timelines["<composition id>"] = tl`. Register only after it's fully built. If the build waits on
  something, such as fonts, register inside that callback and push the promise to `window.__vdBuildReady`.
- One registered timeline per composition. The runtime seeks each registered top-level timeline at its host's
  local time, `t − host start`, clamped to its length, so the last state holds after it ends. Don't nest a
  scene's timeline into the root's: a nested timeline is left to its parent.
- Position tweens with the third argument: `tl.to(el, {...}, 1.2)` at 1.2 s, or `"<0.1"` and `"-=0.2"`.
- Use `from`/`fromTo` for entrances and `to` for exits, and leave CSS holding the resting state. Don't also set
  a CSS `transform` on a property GSAP tweens (`x`, `y`, `scale`, `rotation`): use `xPercent`/`yPercent`, or put
  the start state in `fromTo`.
- Exits: fade with `opacity` before the clip's end. The runtime hides the clip at its end anyway, but a hard cut
  looks abrupt. Never tween `visibility`, `display` or `autoAlpha` on an element with `data-start` (`check`
  reports `gsap_animates_clip_element`).
- `repeat` with a count is fine. `repeat: -1` is cut at the root's `data-duration`, and lint rejects it when
  the root has none. `yoyo` is fine.
- Callbacks (`onUpdate`, `tl.call`) run while seeking, so `onUpdate` is a good way to drive canvas drawing from
  scene-local time.
- Lint flags `tl.play(`. Never call `play()` on any timeline.

## CSS animations and Web Animations

`@keyframes` animations and `element.animate(...)` are paused and set to `t − start` of their element's nearest
ancestor with `data-start` (or the element itself). `animation-delay`, `iteration-count` and `fill-mode` behave
as usual. CSS **transitions** are not seeked; lint warns `css_transition_used`.

## Lottie (lottie-web)

Vendor `lottie.min.js` into `vendor/` and load it in the root's `<head>`. Put the animation JSON in `assets/`.
Load the animation with `autoplay: false`. Its `wrapper` must be inside the composition it belongs to: the
animation is seeked at that composition's local time, by frame, looping if `loop` is set.

```js
const anim = lottie.loadAnimation({ container: document.querySelector(".logo"), renderer: "svg",
  loop: false, autoplay: false, path: __verdandi.assetUrl("../assets/logo.json") });
window.__vdBuildReady.push(new Promise((r) => anim.addEventListener("DOMLoaded", r)));
```

Animations listed by `lottie.getRegisteredAnimations()` are found automatically. Any others go in
`(window.__vdLottie ??= []).push(anim)`.

## anime.js

Create instances with `autoplay: false` and push them to `(window.__vdAnime ??= []).push(a)`. They are seeked
with `a.seek(ms)` at the **root** timeline's time, not the scene's. Inside a scene that starts later, offset the
animation (for example with `delay`) by the scene's start, or use GSAP instead.

## Canvas, WebGL, Three.js

Draw on demand, never in a `requestAnimationFrame` loop. Inside a scene, the simplest approach is a GSAP tween
on a plain object whose `onUpdate` draws, because the tween's time is scene-local:

```js
const state = { p: 0 };
const draw = () => { /* render the canvas for state.p */ };
tl.to(state, { p: 1, duration: 3, ease: "none", onUpdate: draw }, 0);
draw();
```

At the root level, or when you need the exact time, listen for `vd-seek` on `window`. `detail.time` is the
**root** time in seconds, and `detail.waitUntil(promise)`, called synchronously, holds the frame until the
promise settles (for example, a texture loading):

```js
window.addEventListener("vd-seek", (e) => { renderer.render(sceneAt(e.detail.time), camera); });
```

## Seeded randomness

```js
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rand = mulberry32(42);
```

Compute every random value once, while you build the timeline, never while seeking.

## Fonts

Use system fonts, or ship the font files in `assets/` with `@font-face { src: url("assets/x.woff2") }` in
`index.html`. In a scene file, a relative `url()` in CSS is relative to the scene file. The
runtime waits for `document.fonts.ready` (up to 15 s) before the first frame.
