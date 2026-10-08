---
name: video-creative
description: Design direction for Verdandi videos. Covers writing the project's design.md (palette, type scale, spacing, motion personality), picking fonts that render offline, contrast and safe areas, pacing (reading speed, words per second, scene lengths), aspect ratios per destination (16:9, 9:16, 1:1), and the STORYBOARD.md format. Use before building any video with more than one idea in it, when the user asks for a look, style or brand, or when frames look generic, cramped, unreadable or rushed.
---

# Design direction

Decide the look and the pacing on paper before writing HTML. Two files in the project carry the decisions, so
every scene (and every agent that works on it later) uses the same ones:

- `design.md`: palette, type, spacing and motion personality. Template in `references/design-md.md`.
- `STORYBOARD.md`: the scenes, their lengths, what's on screen and what's said. Format in
  `references/storyboard.md`.

If the project already has a `design.md`, read it first and follow it exactly; change it only when the user asks.

## 1. Pick the frame for the destination

| Destination | Ratio | `verdandi video init --resolution` | Notes |
|---|---|---|---|
| YouTube, a website, a presentation, a README | 16:9 | `landscape` (1920×1080) | The default |
| Reels, TikTok, Shorts, Stories | 9:16 | `portrait` (1080×1920) | Platform buttons and captions cover the edges |
| Feed posts (LinkedIn, Instagram, X) | 1:1 | `square` (1080×1080) | Reads well muted in a feed |

Ask when the destination is unclear; a video can't be reframed after the fact without redesigning it. When the
user needs two ratios, build the 16:9 one first, then copy the project and re-lay out each scene. Don't scale.

## 2. Keep text inside the safe area

- **Title-safe** is the centred 80% of the frame: 192 px in from each side and 108 px from top and bottom at
  1920×1080. All text and logos stay inside it.
- **9:16 for social**: also keep text out of the top 250 px and bottom 400 px and the right 140 px of
  1080×1920, where the app's own buttons, captions and progress bar sit. These figures are approximate and
  differ by app; leave more room when in doubt.
- Backgrounds, images and motion may run to the edges. `verdandi video check` reports text off the canvas, but
  not text outside the safe area: look at the snapshots.

## 3. Make it readable on a phone

- **Sizes at 1080 p**: body text ≥ 40 px, captions 48–64 px, titles ≥ 96 px. At 1080×1920 the width is smaller,
  so keep the same pixel sizes and use fewer words per line.
- **Contrast**: at least 4.5:1 between text and what's behind it, 3:1 for titles over 96 px. Over photos or
  video, put a scrim (a dark gradient behind the text) rather than hoping the footage cooperates.
- **Video compression smears colour**: an MP4 stores colour at half the resolution of brightness. Thin coloured
  text on a coloured background goes blurry; make the text differ from its background in lightness, not only in
  hue. Avoid hairlines (under 2 px) and fine stripes: they flicker when they move.
- **Weights**: 500 or heavier for anything under 60 px; thin weights break up when encoded.
- At most two typefaces (one for display, one for text, or one family in two weights) and one accent colour.

## 4. Fonts that render offline

A render runs in the machine's own Chrome with no network, so a font must be installed or shipped:

1. **Ship the file** (most reliable, and the same on every machine): copy a `.woff2`, `.ttf` or `.otf` the user
   has the right to use into `assets/fonts/`, and declare it in `index.html`:

   ```css
   @font-face { font-family: "Display"; src: url("assets/fonts/Display-Bold.woff2") format("woff2"); font-weight: 700; }
   ```

   Declare fonts in `index.html`, not in a scene file: a relative `url()` in a scene's CSS resolves against the
   page.
2. **Use an installed font**: list them with `fc-list : family | sort -u` (Linux, or macOS with fontconfig), or
   `ls /System/Library/Fonts /Library/Fonts ~/Library/Fonts` on macOS, or `Get-ChildItem C:\Windows\Fonts` on
   Windows. A system font renders on this machine only; another machine falls back silently.
3. **System stacks** always render: `system-ui, sans-serif`; `ui-monospace, Menlo, Consolas, monospace`;
   `Georgia, "Times New Roman", serif`.

Never link Google Fonts or another font CDN: the render is offline and lint warns about network stylesheets.
Snapshot a frame with the type and look: a missing font falls back without any error.

## 5. Pace it

| Thing | Rule of thumb |
|---|---|
| On-screen text with no voice | Hold for (words ÷ 3) + 0.5 s at least; a 6-word title holds ≥ 2.5 s |
| Narration | About 2.5 words a second (150 a minute). 30 s of video holds about 70 spoken words |
| A scene | One idea, 2–6 s. Under 2 s only for a deliberate rapid sequence |
| The hook | The point, or a question, in the first 2 s, especially on social |
| The end | Hold the last frame (logo, call to action) 1.5–3 s |
| Words per caption | 2–6 words, at most 2 lines of about 32 characters |

Count the script before designing scenes: words ÷ 2.5 gives the narrated length, and the storyboard has to fit
it. When a scene has more text than its length allows, cut text, don't speed up.

## 6. Give the motion a personality

Write it down in `design.md` in one line, then hold to it. Examples:

- **Calm and premium**: slow fades and drifts, `sine.inOut` and `power2.out`, 0.8–1.2 s entrances, crossfades.
- **Clear and confident** (product, explainer): `power3.out`, 0.5–0.7 s entrances, short staggers, pushes.
- **Punchy** (launch, social): `power4.out`/`expo.out`, 0.3–0.4 s, hard cuts on beats, scale punches.
- **Playful**: overshoot (`back.out(1.6)`) on transforms, bouncier staggers, rotation.

The animation recipes themselves are in **video-animation**.

## 7. Before you build, ask

- Does every scene say one thing, and would a viewer with the sound off still get it?
- Is anything on screen that doesn't serve that scene's one thing? Remove it.
- Does the palette have one clear accent, used only for what matters?
- Is the biggest text the most important text?
