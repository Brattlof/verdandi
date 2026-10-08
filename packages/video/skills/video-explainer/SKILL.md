---
name: video-explainer
description: Step-by-step workflow to turn a topic, article, notes or brief into an explainer video with Verdandi - script, storyboard and design, then one scene per idea with invented visuals (type, diagrams, numbers, simple shapes), optional local voiceover, captions, check and render. Use when the user wants a video that explains or teaches something from text, with no product footage or website to show. For a product or website promo use video-product-launch; for a pull request use video-pr.
---

# An explainer from text

The visuals are invented, scene by scene: there's no footage to capture. What makes it work is the script: one
idea per scene, said simply, shown concretely. Skills used along the way: **video-creative** (design, pacing,
storyboard), **video-animation** (motion), **video-media** (voice, captions), **video-core** and **video-cli**.

## 1. Brief

From the request, settle in one message (ask at most three questions):

- **Audience and takeaway**: who watches, and the one sentence they should remember.
- **Length and destination**: 30–90 s is typical; 16:9 for YouTube or a site, 9:16 for social.
- **Sound**: a voiceover (the user records it, or local text to speech if installed: video-media), or
  captions and on-screen text only. Many explainers are watched muted; on-screen text must carry the point either
  way.

Save the source text as `source.md` in the project (after step 4's init, or keep it until then).

## 2. Script

Write `SCRIPT.md` from the source, not a summary of it:

1. **Hook** (first 3–5 s): the question, the surprising fact or the problem, in one line.
2. **3–5 points**, each one idea, in the order a newcomer needs them. Each gets a concrete example, number or
   picture.
3. **Close**: the takeaway again in one line, plus what to do next if there is a next step.

Length: about 2.5 spoken words a second, so 60 s holds ~150 words. Short sentences; numbers written the way
they're said. Keep the user's wording when they gave a script; tighten it only with their agreement. Facts come
from the source: don't add claims it doesn't make.

## 3. Storyboard and design

Write `STORYBOARD.md` and `design.md` (formats in video-creative). For each scene pick one visual idea that
shows the point rather than repeating the words:

| The point is… | Show it as |
|---|---|
| A number or proportion | A counting number, bars, a filling ring (video-animation → data-and-lines) |
| A sequence or process | Steps appearing left to right, joined by a drawn line |
| A comparison | A split screen, two columns, before and after |
| A concept or definition | The key word large, with 2–3 supporting words or a simple diagram |
| A structure | Boxes and arrows built up one at a time |
| A quote | The quote set large, the source small |

On-screen text is the headline of what's said, not the full sentence. Show the storyboard and design to the
user and **wait for a yes** before building more than the first scene.

## 4. Build

1. `verdandi video init <dir> [--resolution …]`; move `source.md`, `SCRIPT.md`, `STORYBOARD.md` and `design.md`
   into it.
2. Put the palette and type scale in `index.html` as custom properties (video-creative → design.md template).
3. **Voiceover first, when there is one**: record or generate it per scene (video-media → text to speech),
   normalize it, and measure each file. The voice sets each scene's length; update the storyboard's lengths to
   match before building scenes.
4. Build the **first scene** completely (`compositions/<id>.html`), lint, snapshot and look at it. Its look is
   the template for the rest; fix it now rather than in every scene.
5. Build the remaining scenes the same way. Mount them in story order with `data-start="<previous> - <T>"` for
   the transition (video-animation → transitions) and the voice clips at each scene's start.
6. Captions, when the video has a voice: words JSON from the voice (video-media), then the overlay from
   video-captions' `references/caption-overlay.md`, mounted over the whole video.
7. Set the root's `data-duration` to the last scene's end.

## 5. Check and look

```bash
verdandi video check <dir>
verdandi video timeline <dir>              # scene order, overlaps, nothing past the end
verdandi video snapshot <dir> --at <the settled middle of every scene>
```

Tile and open the snapshots. For each scene ask: does the frame show the scene's point with the sound off? Is
the text readable and inside the safe area? Is anything left over from the previous scene? Fix and repeat.

## 6. Review and render

Show the user the snapshots or the Studio preview. On approval, `verdandi video render <dir>` (draft first if
the motion needs a look). Report the path, length and size; mention anything you chose for them (voice,
palette, fonts) that they may want to change.
