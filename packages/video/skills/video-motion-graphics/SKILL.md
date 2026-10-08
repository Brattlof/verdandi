---
name: video-motion-graphics
description: Step-by-step workflow for a short, unnarrated, design-led motion graphic with Verdandi, usually under 10 seconds - kinetic typography, a stat or number hit, a logo sting, a title card, a lower third or a social overlay (also with a transparent background). Use when the motion itself is the message and there's no voiceover or story of several scenes. Longer or narrated pieces use video-explainer or video-product-launch.
---

# A short motion graphic

One idea, a few seconds, no narration. It lives or dies on type, timing and one well-made move. Load
**video-animation** for the recipes and **video-core** for the contract.

## 1. Pin the brief in one line

Answer these yourself from the request and ask only what's missing (one question at most):

- **Kind**: kinetic type (a line or quote), stat hit (a number), logo sting, title card, lower third or overlay.
- **Copy**: the exact words or number. Kinetic type takes 3–12 words; more is a different video.
- **Size and length**: 16:9 unless it's for social (9:16 or 1:1); 4–8 s, up to ~10.
- **Background**: solid (the default) or transparent, for an overlay to drop onto other footage.
- **Look**: brand colours and fonts, else choose and say what you chose.

## 2. Plan the beats

Write the plan as 3–5 beats with times before any code. A reliable shape:

| Beat | Share | What happens |
|---|---|---|
| Hook | first 0.5–1 s | Something moves at once: the first word, a shape, a line |
| Build | middle | The rest arrives in order, staggered, one idea at a time |
| Punch | one moment | The key word or number lands: scale punch, accent colour, a hard cut |
| Hold | last 1.5–2 s | The final frame, still and readable |

For kinetic type, split the copy into groups of 1–4 words by meaning and give each group its own beat; one or
two words in the whole piece get the accent colour. A stat hit counts up during the build and punches when it
lands. A logo sting draws or assembles the mark, then holds the lockup.

Write a two-line `design.md` (video-creative): palette (background, text, one accent) and one typeface. Fonts
must render offline: ship the file in `assets/fonts/` or use an installed or system font.

## 3. Build it in one composition

1. `verdandi video init <dir> [--resolution portrait|square]`.
2. Look for a ready-made block: `verdandi video catalog <kind>`. If one fits (a lower third, a title), add it
   with `verdandi video add <block> --project <dir> --vars '<json>'` and restyle it.
3. Otherwise write everything in `index.html`: no scenes are needed for a single idea. Each beat's group is a
   plain element (not a clip), and one timeline on the root does all the motion with labels per beat:

```js
const tl = gsap.timeline({ paused: true, defaults: { duration: 0.6, ease: "power3.out" } });
tl.addLabel("hook", 0.2).addLabel("build", 1.4).addLabel("punch", 3.2);
// … recipes from video-animation, placed at the labels …
window.__timelines["main"] = tl;
```

4. Set the root's `data-duration` to the plan's length, including the hold.
5. Transparent background: set `html, body` and the root's background to `transparent`, keep the elements
   readable on both light and dark footage (a shadow or a solid plate), and render to WebM or MOV.

## 4. Check, look, fix

```bash
verdandi video lint <dir>
verdandi video check <dir>
verdandi video snapshot <dir> --at <one time inside each beat, plus the final frame>
```

Tile the snapshots and open the sheet (video-animation → Verify motion). Look for: text fully formed at each
beat's settle point, the accent on the right word, nothing outside the safe area, the final frame holding.
Fix and repeat until check is clean and every frame is right.

## 5. Render

Ask the user to look at the snapshots or the Studio preview, then render:

```bash
verdandi video render <dir> --quality draft                   # a quick full-motion review
verdandi video render <dir>                                   # the MP4
verdandi video render <dir> --format webm                     # transparent overlay (or --format mov for editors)
verdandi video render <dir> --format gif --fps 15             # a looping GIF for a README or chat
```

A transparent render keeps its alpha when `ffprobe -v error -show_entries stream_tags=alpha_mode -of csv=p=0 <file>.webm`
prints `1` (ffprobe's default decoder reports `yuv420p` either way).

Report the output path, its length (`ffprobe -v error -show_entries format=duration -of csv=p=0 <file>`) and
size.
