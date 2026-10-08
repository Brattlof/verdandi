---
name: video-product-launch
description: Step-by-step workflow to make a promo or launch video for a product, app or website with Verdandi, from a brief and the product's own screenshots, logo and footage - hook, problem, product in action, features, proof and call to action, with screenshots framed and animated (pans, zooms, callouts). Use when the user wants to announce, promote or demo a product or site. For explaining a topic from text use video-explainer; for a code change use video-pr.
---

# A product launch video

The product is the hero: real screenshots and footage of it, framed and moved with intent. Skills used along
the way: **video-creative**, **video-animation**, **video-media**, **video-core**, **video-cli**.

## 1. Gather the material

Ask for what you don't have, in one message:

- **The brief**: product name, what it does in one sentence, who it's for, the launch message (what's new), the
  call to action (URL, "available today", store badge).
- **Screenshots** of the screens that matter (PNG, at least the size they'll be shown; 2× for anything you zoom
  into), a **logo** (SVG best, else a large PNG with transparency), and any **screen recordings**.
- **Brand**: colours and fonts (or a site to read them from), and the tone (playful, premium, technical).
- **Destination and length**: 15 s (social cut), 30 s (the usual), 60 s (a demo). 16:9 by default; 9:16 for
  Reels and Shorts.

Only a URL and no screenshots? Ask whether you may capture the site. If yes, Chrome can screenshot a page
headless (`<chrome> --headless --screenshot=assets/screens/home.png --window-size=1440,900 <url>`), but logged-in
screens and real data must come from the user. Never invent UI or customer names; build only from what they gave.

**No screenshots and no logo?** Make it anyway, without faking the product: set the name as a type-set wordmark
(the brand's font, or a strong system one, with the accent on one letter or an underline), and carry the
features with diagrams, icons built from simple shapes, numbers and kinetic type, as video-explainer does. Never
draw a mock app screen or fake UI; the first real screenshot can replace a diagram later.

Copy everything into `assets/screens/`, `assets/footage/` and `assets/brand/`, and prepare footage per
video-media.

## 2. Story

A shape that works for most launches (30 s):

| Beat | Time | Content |
|---|---|---|
| Hook | 0–3 s | The promise or the pain, in five words or fewer, big |
| Problem | 3–7 s | The before: what's slow, broken or annoying today |
| Product | 7–12 s | The logo or product name lands; the main screen appears |
| Features | 12–24 s | 2–3 features, one per scene, each a screenshot with one callout and a 3–6 word label |
| Proof | 24–27 s | A number, a quote or a logo row, only if the user supplied it |
| Call to action | 27–30 s | Logo, URL or "Available today"; holds to the end |

By length:

- **15 s** (social cut): hook 2 s, product 3 s, one feature 6 s, call to action 4 s. No problem beat.
- **20–25 s**: hook, product, 2 features of about 5 s each, call to action; fold the problem into the hook.
- **30 s and over**: the full shape above. Past 30 s add features (one scene each, 4–6 s) or a short flow from a
  screen recording, not longer holds; a 60 s demo is about 8–10 scenes.

Write `STORYBOARD.md` and `design.md` (video-creative), using the brand's colours and fonts, and wait for the
user's yes.

## 3. Show screenshots well

- **Frame them**: a screenshot floats on the background in a simple device or browser frame built with CSS
  (rounded corners, a thin border, a soft shadow, three dots for a browser bar). Never stretch a screenshot;
  `object-fit: cover` crops instead.
- **Move them slowly**: a push-in (scale 1 → 1.06 over the scene) or a pan down a tall screenshot (`y` from 0
  to the overflow, `ease: "none"`), so a still image reads as alive (video-animation → camera moves).
- **Point at one thing**: zoom towards the feature (`transform-origin` on it, scale 1 → 1.6), or dim the rest
  and ring the feature with a highlight box that draws in. One callout per scene.
- **Real footage beats fake UI**: when there's a screen recording of a flow, use it (`<video muted>`, trimmed
  with `data-playback-start`), framed the same way.
- Text never sits on top of a busy screenshot without a plate behind it.

## 4. Build

1. `verdandi video init <dir> [--resolution …]`; the brand palette and fonts go in `index.html` as custom
   properties and `@font-face`.
2. Logo: an SVG inline in the scene can be drawn stroke by stroke or assembled; a PNG logo scales and fades in.
   Check `verdandi video catalog logo` for a ready-made sting first.
3. One scene file per storyboard row, built and checked in order; the first one sets the look.
4. Music, if the user supplied a track: trim and fade it (video-media), place it as `<audio data-volume="…">`
   for the whole video, and time the cuts to its beats where you can. Never use music without the user's file and
   their right to use it.
5. The call to action holds at least 2 s at the end.

## 5. Check, review, render

```bash
verdandi video check <dir>
verdandi video snapshot <dir> --at <each scene's settled moment, plus the last frame>
```

Tile and open the frames. For each: is the product recognisable, the label readable at phone size, the callout
on the right spot, the brand colours right? Then show the user, and on approval
`verdandi video render <dir>` (and `--format webm` or a 9:16 variant only if asked). Report path, length and
size.
