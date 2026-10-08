---
name: video-animation
description: Motion craft for Verdandi video compositions, where every timeline is paused and scrubbed frame by frame. Covers seek-safe GSAP (fromTo over CSS start states, position parameters, staggers, eases, keyframes), the entrance-hold-exit rhythm, scene transitions (crossfade, push, wipe, zoom, dip) built from tweens, text reveals, counting numbers, SVG line drawing, and CSS, Web Animations, Lottie, anime.js or canvas through vd-seek. Use when animating anything in a `verdandi video` project, choreographing scenes, or fixing motion that looks wrong in snapshots.
---

# Animating a composition

A render never plays your animation. It **seeks** it: frame 212 is drawn by jumping straight to 7.07 s, often
on a page that has never drawn frame 211, and several pages capture frames in parallel. So every frame must be a
pure function of time. Write motion as states at times, not as things that happen.

The contract (registering timelines, clip windows, the other runtimes' hooks) is in **video-core**; load it first.
This skill is how to make the motion good and keep it seekable.

## The rules that keep motion seekable

1. **One paused GSAP timeline per composition**, built synchronously and registered last:
   `window.__timelines["<composition id>"] = tl`. Never `play()`, never `gsap.to()` outside the timeline.
2. **Use `fromTo` for anything that enters.** It states the start and the end, so a seek from any direction lands
   on the same frame. `from()` reads the current CSS as the end, which breaks when CSS hides the element
   (`opacity: 0` → animates from 0 to 0).
3. **Leave CSS at the resting (visible) state** and put the hidden start state in the tween. Two tweens on the
   same property of the same element: give the later one `immediateRender: false`.
4. **Animate transforms and opacity** (`x`, `y`, `xPercent`, `yPercent`, `scale`, `rotation`, `opacity`), plus
   `clipPath`, colours, `strokeDashoffset` and CSS variables. Avoid `width`, `height`, `top`, `left`: they reflow
   text and look wobbly at 30 fps.
5. **Never touch a clip's visibility.** The runtime shows each `[data-start]` element only inside its window.
   Don't tween `visibility`, `display` or `autoAlpha` on it (`check` errors `gsap_animates_clip_element`).
   `opacity` and transforms on a clip are fine; `autoAlpha` on a child is fine.
6. **No clocks, no chance.** No `Math.random()`, `Date.now()`, `performance.now()`, `requestAnimationFrame`,
   `setTimeout` loops or CSS `transition`. Use a seeded generator (video-core) and compute values while building.
7. **No state that accumulates across frames.** A `vd-seek` handler or `onUpdate` must draw from the time alone,
   never "add a bit more than last frame".
8. **Measure text only once fonts have loaded.** A scene file's script runs after its fonts load (up to 5 s),
   so measuring there is safe. Scripts in `index.html` run before web fonts load, so widths come from the
   fallback font: build inside `document.fonts.ready.then(…)`, push that promise to `window.__vdBuildReady`, and
   register the timeline at the end of the callback. Either way, `xPercent`/`yPercent` and CSS layout need no
   measuring.
9. **In a scene file, the scene's root keeps its id for your script and CSS** (`tl.to("#scene-root", …)` works), even
   though the runtime renames it in the page so two mounts don't clash. A misspelled selector animates nothing:
   `check` reports it as `gsap_target_not_found`.

## Rhythm: enter, hold, leave

Every element has three phases. Most bad motion is missing the middle one.

- **Enter** in 0.4–0.8 s with an `.out` ease. Stagger siblings 0.05–0.15 s apart, never all at once.
- **Hold** until it has been read: about 3 words a second, plus half a second. A title of 6 words holds ≥ 2.5 s.
  Something may keep drifting during the hold (scale 1 → 1.03 over the hold, `ease: "none"`), so the frame
  isn't frozen.
- **Leave** in 0.3–0.5 s with an `.in` ease, or let the scene transition carry it out. Exits are faster than
  entrances.
- Leave **the last 1–1.5 s of the video** on a held final frame (logo, call to action, conclusion). Don't end
  on black or mid-motion unless asked.

Pick one easing family as the house style (`power3.out` for most work) and vary energy within it: `sine` and
`power1` for calm, `power3` standard, `power4`/`expo` for punch. `back` and `elastic` overshoot: playful pieces
only, transforms only (never on `opacity`). `ease: "none"` for camera drifts and counters that should feel
mechanical. Set defaults once: `gsap.timeline({ paused: true, defaults: { duration: 0.6, ease: "power3.out" } })`.

## Recipes

| Need | Read |
|---|---|
| Entrances, position parameters, staggers, keyframes, holds and exits | `references/gsap-recipes.md` |
| Text reveals: masked lines, words, letters, typewriter | `references/text.md` |
| Counting numbers, bars, SVG line drawing | `references/data-and-lines.md` |
| Scene transitions: crossfade, push, wipe, zoom, dip to colour | `references/transitions.md` |
| CSS keyframes, Web Animations, Lottie, anime.js, canvas | video-core's `references/animation.md` |

Copy a recipe, then change its numbers to your layout and beats; snapshot the result (below).

## Verify motion, don't trust it

1. `verdandi video check <dir>`. Fix every error. A warning at a time inside a transition is usually the
   transition itself (text pushed past the edge); snapshot that time to be sure.
2. Snapshot **around** each move, not just after it: the start, mid-move and the settled state.
   `verdandi video snapshot <dir> --at 0.2,0.5,0.9,1.5`.
3. Look at several frames at once by tiling them into one image, then open that image:

   ```bash
   ffmpeg -v error -y -pattern_type glob -i '<dir>/snapshots/frame-*.png' \
     -vf "scale=480:-1,tile=4x2:padding=6:color=white" -frames:v 1 <dir>/snapshots/sheet.png
   ```

4. To prove a move is seekable, snapshot out of order into another folder
   (`verdandi video snapshot <dir> --at 4,1,3 -o <dir>/snap-check`) and compare each frame with the in-order one
   at the same time (the file names end `-at-4.00s.png`; the numbers before differ):

   ```bash
   ffmpeg -hide_banner -i <dir>/snapshots/frame-03-at-4.00s.png -i <dir>/snap-check/frame-01-at-4.00s.png \
     -lavfi psnr -f null - 2>&1 | grep PSNR
   ```

   Identical frames print `average:inf`, and above 60 dB is a match too (edges of scaled text can differ by one
   level in a few pixels, so don't compare bytes). Lower than that, look at both: a visible difference is a seek
   bug, a `to()` that depends on an earlier state, or state kept outside the timeline.
5. A move that looks right in snapshots but wrong in motion (too fast, jittery): render a draft
   (`verdandi video render <dir> --quality draft`) and ask the user to watch it.

## Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Element never appears | `from()` with CSS `opacity: 0`, or a selector that matches nothing (GSAP only warns in the console) | `fromTo`; check the selector exists inside this composition |
| Element pops in at full size, then animates | CSS start state differs from the tween's `from` | Let the tween own the start state; keep CSS at rest |
| Second tween on a property jumps | Both tweens render their start immediately | `immediateRender: false` on the later one |
| Text cut off mid-reveal is reported as `clipped_text` | Mask built with `overflow: hidden` | Mask with `clip-path: inset(…)` (see `references/text.md`) |
| Different frames on each render | Randomness, clocks or accumulating state | Seeded values, computed at build; draw from time only |
| Motion stops halfway in the render | Timeline shorter than intended, or clip window ends first | `verdandi video timeline <dir>`; extend the clip or the tween |
