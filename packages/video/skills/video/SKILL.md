---
name: video
description: Entry point for making videos with Verdandi's video maker, where a video is an HTML composition rendered in headless Chrome and ffmpeg. Use whenever the user asks to make, edit, animate, preview or render a video, animation, motion graphic, title card, lower third, explainer, promo or social clip, or works in a folder made by `verdandi video init`. Covers the brief, the scene plan and the build-check-review-render loop, and routes to the workflow skills (explainer, product launch, PR, motion graphics, captions) and the craft skills.
---

# Making a video

In Verdandi a video is a web page. `index.html` is the **root composition**. Each scene is a **sub-composition**
under `compositions/`, mounted on the root's timeline. Elements declare when they show (`data-start`,
`data-duration`), and GSAP timelines are registered paused so the runtime can seek them. A render seeks the page
frame by frame in headless Chrome and encodes the screenshots with ffmpeg. Everything runs locally: no cloud
render and no stock-media service. Speech (voiceover, transcription) comes only from local tools the user has
installed (video-media).

## Which skill

| The request | Load |
|---|---|
| Explain or teach a topic from text, notes or an article | **video-explainer** |
| Promote, announce or demo a product, app or website | **video-product-launch** |
| A video of a pull request, change or release note | **video-pr** |
| A short unnarrated piece: kinetic type, a number hit, logo sting, title card, lower third, overlay | **video-motion-graphics** |
| Captions or subtitles on an existing video | **video-captions** |

The workflows above pull in the craft skills as they go; load these directly for anything else:
**video-creative** (design.md, STORYBOARD.md, type, contrast, pacing), **video-animation** (motion, transitions,
text reveals), **video-media** (footage, audio, voiceover, caption words), **video-core** (the composition
contract; load it before writing any composition HTML) and **video-cli** (command flags, render formats, what
each lint or check finding means).

## 1. Where are we?

Take the first row that matches:

| State | Do |
|---|---|
| The user wants one operation on an existing project (lint, check, snapshot, render) | Run only that operation (video-cli). Don't re-brief. |
| The user wants a specific edit to an existing project | Run `verdandi video timeline <dir>` to see the tracks and clips instead of reading every file, then make the edit and go to step 5. |
| A new video | Start at step 2. |

A folder is a video project when its `index.html` has an element with `data-composition-id`. The project's
`AGENTS.md` is a short reminder of the contract.

## 2. Confirm the brief

Ask at most three questions in one message, and only about what the request leaves open:

- **Who is it for and what should they take away?** One sentence of message.
- **Length and shape:** seconds; landscape (1920×1080), portrait (1080×1920) or square (1080×1080).
- **Look:** brand colours, fonts, logo, footage or music the user will supply (they go in `assets/`).

If the user says "just make it", choose: 15 to 30 seconds, landscape, 30 fps, a dark neutral background with one
accent colour, and system fonts. State what you chose in one line. Never fetch images, fonts or music from the
network without asking. A render must work offline, so anything you use goes into the project.

## 3. Plan the scenes

Before writing code, write `STORYBOARD.md` and `design.md` in the project (formats in video-creative), and show
the user the scene list as a short table in chat: scene id, start, length, what's on screen, and how it moves.
Rules of thumb:

- One idea per scene, usually 2 to 6 seconds. Hold text long enough to read it twice (about 3 words a second).
- Scene lengths add up to the root's `data-duration`. Scenes follow each other with `data-start="<previous id>"`,
  so retiming one scene moves the ones after it.
- Overlays (lower thirds, captions, a logo bug) are separate clips on their own track, timed against the scenes.
- At 1080p, body text is at least 40px and titles 96px or more. Keep text inside the title-safe area
  (video-creative).

## 4. Build

1. `verdandi video init <dir> [--resolution landscape|portrait|square]`. This creates `index.html`,
   `vendor/gsap.min.js`, `assets/`, `compositions/` and `AGENTS.md`. It refuses a folder that isn't empty.
2. **Reuse before you build.** Run `verdandi video catalog [words]` for ready-made blocks; each lists its
   variables with their defaults (`catalog --json` has the full declarations: types, labels, options). Then
   `verdandi video add <block> --project <dir> [--vars '<json>']`. This copies the block to
   `compositions/<block>.html` and prints the host element (`style="inset: 0"`, `data-track-index="1"`). Paste
   that element into `index.html`, set its `data-start`, and pick its track: 0 for a full-frame scene such as
   `title-card` or `end-card`, higher for an overlay.
3. **Write one file per scene** (`compositions/<scene>.html`, wrapped in `<template>`), each with its own
   paused GSAP timeline. Mount each scene in `index.html` with a host element. The skeletons are in video-core.
4. Set the root's `data-duration` to the end of the last scene.
5. **Run `verdandi video lint <dir>` after every edit** and fix every error before you go on. Each finding
   names its fix.

## 5. Check and look

1. Run `verdandi video check <dir>`. It runs lint, then plays the page in Chrome: script errors, failed loads,
   clips past the end, text off the canvas or clipped, low contrast, and a video where nothing moves. It prints
   "Ran it in Chrome at <times>." when the browser pass ran; while lint has errors it skips it and says so.
   Clear the errors first.
2. Run `verdandi video snapshot <dir> --at <t1,t2,…>` with the middle of each scene and the moments just after
   each entrance. **Open the PNGs and look at them.** Check overlaps, cropped text, contrast, empty frames and
   whether the frame says what the plan said it would. Lint can't judge any of this.
3. Fix the problems and repeat until check is clean and the frames look right.

## 6. Show the user, then render

- Open the **Studio** for the user: `verdandi video preview <dir>` opens the web UI on the project and serves it
  until Ctrl+C, so start it in the background or ask the user to run it. Alternatively, the user runs
  `verdandi web`, opens **Video** in the rail, pastes the project's absolute path and presses **Open**. In the
  Studio they can play the preview, scrub, and drag, trim or hide clips on the timeline. These edits rewrite the
  source files, so after the user has used the Studio, read the files again (or run `timeline`) before you change
  anything. If they can't open it, send the snapshot PNGs instead.
- **Render only after the user approves.** For a quick full-motion review, use
  `verdandi video render <dir> --quality draft`. For the deliverable, use `verdandi video render <dir>`, which
  writes an MP4 at standard quality to `<dir>/renders/<dir name>.mp4`. Pick another format only when the user
  needs one (video-cli covers formats and qualities).
- Report the output path, size and duration. To confirm them, run
  `ffprobe -v error -show_entries format=duration -of csv=p=0 <file>`.

## Rendering needs Chrome and ffmpeg

`check`, `snapshot`, `timeline` and `render` start headless Chrome: Google Chrome, or the binary set in
`VERDANDI_CHROME`. `render` also needs ffmpeg and ffprobe on `PATH`, or the binaries set in `VERDANDI_FFMPEG`
and `VERDANDI_FFPROBE`, and so does `snapshot` when the project plays video files. When one is missing, the command's error names the fix. Pass that fix
on to the user rather than working around it.
