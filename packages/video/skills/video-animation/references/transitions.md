# Scene transitions

A transition says how two scenes relate. Pick one main transition for the video and use it for most cuts; save a
bolder one for the turn in the story. A different transition on every cut looks like a demo reel.

| Mood | Main transition | Length | Ease |
|---|---|---|---|
| Calm, premium | crossfade, dip to colour | 0.6–0.9 s | `sine.inOut` |
| Clear, informative | push, wipe | 0.4–0.6 s | `power3.inOut` |
| Energetic, launch | zoom through, fast push | 0.25–0.4 s | `power4.inOut`, `expo.inOut` |

A plain cut (no transition) is fine on a strong beat, such as a music hit or the reveal of a number.

## Overlap the scenes

Two scenes can only be seen together if their windows overlap. Start the incoming scene before the outgoing one
ends, by the transition's length:

```html
<div id="one" data-composition-id="one" data-composition-src="compositions/one.html" data-start="0" data-duration="4"></div>
<div id="two" data-composition-id="two" data-composition-src="compositions/two.html" data-start="one - 0.5" data-duration="4"></div>
```

- A later element in the document is drawn on top. Put scenes in story order; the incoming one covers the
  outgoing one.
- Count the overlap in the video's length: two 4 s scenes with a 0.5 s transition make 7.5 s.
- `data-start="one - 0.5"` follows the end of `one`, so retiming `one` moves `two` with it.

## Animate inside each scene

Animate the scene's `.stage` wrapper (or the scene's root by the id written in the file; both work). The incoming
scene does its part at the start of its own timeline, so it never needs retiming. The outgoing scene's part sits
at its end (`D - T`, its duration minus the transition length).

Most transitions need only the incoming side:

```js
// Crossfade: the incoming scene fades in over the outgoing one.
tl.fromTo(".stage", { opacity: 0 }, { opacity: 1, duration: 0.6, ease: "sine.inOut" }, 0);

// Wipe: the incoming scene is uncovered left to right. Swap the inset sides for other directions,
// or use circle(0% at 50% 50%) → circle(75% at 50% 50%) for an iris.
tl.fromTo(".stage", { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: 0.5, ease: "power3.inOut" }, 0);
```

Push and zoom move both scenes:

```js
// Push. Incoming scene, at 0:
tl.fromTo(".stage", { xPercent: 100 }, { xPercent: 0, duration: 0.5, ease: "power3.inOut" }, 0);
// Outgoing scene (D = 4, T = 0.5), at D - T:
tl.to(".stage", { xPercent: -100, duration: 0.5, ease: "power3.inOut" }, 3.5);

// Zoom through. Incoming scene, at 0:
tl.fromTo(".stage", { scale: 0.85, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: "power3.out" }, 0);
// Outgoing scene, at D - T:
tl.to(".stage", { scale: 1.25, opacity: 0, duration: 0.4, ease: "power3.in" }, 3.6);
```

Use the same length and ease on both sides of a push, or the scenes gap or overlap. Give each scene's `.stage`
its own background, so the incoming one hides the outgoing one.

## Dip to colour

The scenes don't overlap. A full-frame colour block on top fades in, the cut happens under it, and it fades out.
A CSS animation on the block follows its own `data-start`, so it moves with the cut:

```html
<div id="dip" class="dip" data-start="one - 0.3" data-duration="0.6" data-track-index="9"></div>
<style>
  .dip { position: absolute; inset: 0; background: #0b0b0c; animation: dip 0.6s ease-in-out both; }
  @keyframes dip { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }
</style>
```

Put it after the scenes in the document so it's on top.

## The `wipe-transition` block

A ready-made wipe: a coloured panel sweeps in, covers the whole frame at 0.4 s, and sweeps out the other side
(0.8 s; variables `color`, `edge`, `direction`). Like a dip, the scenes don't overlap: mount it after them,
centred on the cut, so it covers the frame at the cut point:

```html
<div id="wipe-1" class="clip" data-composition-id="wipe-1" data-composition-src="compositions/wipe-transition.html"
     data-start="one - 0.4" data-duration="0.8" data-track-index="9" style="inset: 0"></div>
```

To mount it at several cuts, give each host its own `id` and `data-composition-id` (video-core's
`references/sub-compositions.md`).

## What shows when the cover lifts

A wipe, push or dip only hides the cut while it covers the frame. When it lifts, the incoming scene must already
show its content: start its entrance at or before the cut, or hold its first state visible. An incoming scene
whose first frame is empty or transparent shows bare background for a moment. The same goes for a hard cut into
a block that starts transparent (`logo-sting` starts at opacity 0): overlap it with the previous scene, or start
it about 0.3 s earlier, so it has faded in by the cut. Snapshot the frame just after each cover lifts.

## In a single composition

When the scenes are sections of one file rather than sub-compositions, the same tweens go on the one timeline at
absolute times. Each section is a clip with its own window, and the tweens target its inner wrapper:

```js
tl.to("#s1 .stage", { xPercent: -100, duration: 0.5, ease: "power3.inOut" }, 3)
  .fromTo("#s2 .stage", { xPercent: 100 }, { xPercent: 0, duration: 0.5, ease: "power3.inOut" }, 3);
```

## Don'ts

- Don't fade every element out and then cut: the outgoing scene should be fully visible when the transition
  starts. The transition is the exit.
- Don't tween `visibility` or `autoAlpha` on a scene host to hide it; its window already does.
- Don't hold a transition: anything longer than about 1 s reads as a mistake, except a deliberate slow dissolve.
