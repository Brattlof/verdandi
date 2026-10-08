# GSAP recipes

All times are seconds on the composition's own timeline: a scene's timeline starts at 0 when its host starts.

## Scene skeleton

```html
<template>
  <div id="intro" data-composition-id="intro" data-width="1920" data-height="1080">
    <style>
      .stage { position: absolute; inset: 0; display: grid; place-content: center; gap: 32px; }
      .title { font: 800 140px/1.05 system-ui, sans-serif; color: #f4f1ea; }
    </style>
    <div class="stage">
      <h1 class="title">Seek, don't play</h1>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true, defaults: { duration: 0.6, ease: "power3.out" } });
      tl.fromTo(".title", { opacity: 0, y: 48 }, { opacity: 1, y: 0 }, 0.2);
      window.__timelines["intro"] = tl;
    </script>
  </div>
</template>
```

Selectors in a scene's script match only inside that scene, so `.title` here never hits another scene's `.title`.

## Position parameters

The third argument places a tween. Prefer it to `delay`.

| Position | Starts |
|---|---|
| `1.2` | at 1.2 s |
| `"<"` / `"<0.15"` | with the previous tween / 0.15 s after the previous tween starts |
| `">"` / `">-0.2"` | when the previous tween ends / 0.2 s before it ends (overlap) |
| `"+=0.3"` | 0.3 s after the end of the timeline so far |
| `"hit"` / `"hit+=0.2"` | at a label added with `tl.addLabel("hit", 2.4)` |

Labels name the beats ("hook", "reveal", "cta"), so retiming one beat is one number.

```js
tl.addLabel("reveal", 1.0)
  .fromTo(".card", { opacity: 0, y: 40 }, { opacity: 1, y: 0 }, "reveal")
  .fromTo(".caption", { opacity: 0 }, { opacity: 1, duration: 0.4 }, "<0.2");
```

## Staggers

```js
// Siblings 0.1 s apart.
tl.fromTo(".item", { opacity: 0, y: 24 }, { opacity: 1, y: 0, stagger: 0.1 }, 0.5);
// Spread from the middle outwards, 0.6 s in total however many items there are.
tl.fromTo(".tile", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, stagger: { amount: 0.6, from: "center" } }, 1);
// Per-item values: alternate tilt.
tl.fromTo(".chip", { opacity: 0, rotation: (i) => (i % 2 ? 8 : -8) }, { opacity: 1, rotation: 0, stagger: 0.08 }, 1.5);
```

`stagger: { from: "random" }` is random on every load. Don't use it; use a seeded order (video-core) or `"edges"`.

## Keyframes: one element, several poses

```js
tl.to(".dot", {
  keyframes: [
    { x: 400, duration: 0.5, ease: "power2.inOut" },
    { y: -120, duration: 0.3, ease: "power2.out" },
    { y: 0, duration: 0.4, ease: "bounce.out" },
  ],
}, 1);
```

Each pose has its own duration and ease, and they run back to back. A `to` tween starts from the element's state
when it first renders, which is the CSS rest state, so this is seek-safe as long as no earlier tween moved `.dot`.

## Hold with life, then leave

```js
tl.fromTo(".hero", { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.7 }, 0.2)
  // A slow drift through the hold keeps the frame alive.
  .to(".hero", { scale: 1.04, duration: 2.6, ease: "none" }, ">")
  .to(".hero", { opacity: 0, y: -30, duration: 0.4, ease: "power2.in" }, ">");
```

## Finite loops

```js
// Pulses 3 times (6 half-cycles), then stops at its rest state.
tl.fromTo(".ping", { scale: 1 }, { scale: 1.15, duration: 0.4, ease: "sine.inOut", repeat: 5, yoyo: true }, 2);
```

Compute the repeat count from the time the element is on screen. `repeat: -1` runs past the scene and is cut at
the root's `data-duration`.

## Camera moves

Put everything that should move together in a wrapper and move the wrapper: a slow push-in (`scale` 1 → 1.08
over the scene, `ease: "none"`), a pan across a wide layout (`xPercent`), or a Ken Burns over an image
(`scale` and `x` together). Set `transform-origin` in CSS for where the zoom aims.

```js
tl.fromTo(".camera", { scale: 1, xPercent: 0 }, { scale: 1.08, xPercent: -3, duration: 5, ease: "none" }, 0);
```
