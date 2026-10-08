# 0038 · Video compositions render through one in-page runtime

## Status

Accepted (owner decision, 2026-10-08).

## Context

The owner asked for a video maker built like HeyGen's HyperFrames (Apache-2.0, about 430,000 lines of TypeScript in
14 packages), as Verdandi's own code rather than a dependency. In HyperFrames a video is an HTML page whose elements
declare when they show (`data-start`, `data-duration`), whose GSAP timelines are registered paused, and whose media the
framework plays. A renderer seeks the page frame by frame in headless Chrome and encodes the screenshots with ffmpeg.

HyperFrames assembles a composition twice: a Node compiler (linkedom, postcss) inlines sub-compositions for a render,
and an in-page loader does it again for preview. Its linter parses HTML, CSS and scripts with htmlparser2, postcss and
acorn, and keeps its own GSAP parser.

## Decision

1. **Same authoring contract.** The attributes (`data-composition-id`, `data-start`, `data-duration`,
   `data-composition-src`, `data-variable-values`, `data-hidden`, …) and `window.__timelines` match HyperFrames', so its
   compositions and what agents know about them carry over. Everything internal is ours: the renderer protocol is
   `window.__vd`, the author helpers `window.__verdandi`, internal attributes `data-vd-*`, the seek event `vd-seek`.
2. **One assembler, in the page.** `packages/video/src/runtime` mounts sub-compositions with `fetch` and `DOMParser`,
   scopes their CSS with native `@scope`, and runs their scripts with `document`, `gsap` and `window.__timelines`
   scoped to them. Preview and render run the same code, so there is no Node HTML or CSS parser.
3. **Facts come from the page.** A render reads the resolved timeline (`__vd.manifest()`: every clip's and media
   element's window) and each frame's video source times (`__vd.frameTargets(t)`) from the running page instead of
   re-parsing the HTML. Audio is mixed and video decoded from those.
4. **No GSAP nesting.** Each top-level registered timeline is seeked at its host's local time; one an author nested
   in another is left to its parent.
5. **Lint without parser dependencies.** Source rules read the tag tree with Bun's built-in `HTMLRewriter` and
   scripts with comments and strings blanked; `check` answers the rest in Chrome against the real DOM, CSSOM and live
   GSAP timelines, which is more exact than a static GSAP parser.
6. **Dependencies the owner approved:** `puppeteer-core` (Chrome is the system's, or `VERDANDI_CHROME`), `gsap`
   (copied into each project at `init`, so renders work offline), and CodeMirror 6 for the Studio's editor. ffmpeg is
   the system's, or `VERDANDI_FFMPEG`.
7. **Engine functions take `env`.** Chrome and ffmpeg run with the caller's environment (`childEnv()` from the CLI), so
   Verdandi's secrets never reach them.
8. **Local-first.** No HeyGen, ElevenLabs or Gemini services; media tools (speech, transcription) come only from local
   programs, when installed.

## Consequences

- Rendering needs Chrome and ffmpeg on the machine; `verdandi video` names the fix when either is missing.
- A composition that loads scripts or fonts from the network renders only online; lint warns about it.
- The render protocol is internal and may change; the authoring contract is the stable surface.
- Capture uses separate Chrome processes, not tabs: on a 12-core M-series Mac one page captures about 24 frames per second
  at 1080p, four tabs in one browser 35, and four browsers 56. Linux BeginFrame capture, shader transitions and HDR are
  later work.
