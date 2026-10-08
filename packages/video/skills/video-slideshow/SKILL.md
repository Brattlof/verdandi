---
name: video-slideshow
description: Build a slideshow (a presentation or pitch deck) as a Verdandi composition and present it with `verdandi video present`, slide by slide with presenter notes. Use when the user wants slides to talk over rather than a video that plays on its own; the same project still renders to a video.
---

# Slideshow

A slideshow is an ordinary composition whose scenes are marked as slides. Presenting plays each slide's entrance,
then holds until you move on; rendering still makes a video of the whole thing.

## Build it

1. Set up and design as for any video (`video` skill): `verdandi video init`, a `design.md` (video-creative), one
   scene per slide under `compositions/`, mounted from `index.html` one after another.
2. Mark each scene's host as a slide and give it notes:

   ```html
   <div id="problem" class="clip" data-composition-id="problem" data-composition-src="compositions/problem.html"
        data-start="intro" data-duration="4" data-track-index="0" style="inset: 0"
        data-slide="The problem" data-notes="Ask who has paid for a model they didn't need."></div>
   ```

   - `data-slide`: the slide's title, shown in the presenter view.
   - `data-notes`: what to say; plain text.
   - `data-hold`: seconds after the slide's start where presenting waits. Without it, presenting waits just before
     the slide's end, so build the entrance early and let the slide rest in its final state until its end.
3. Animate entrances inside each slide; put exits in the next slide's entrance or in a transition (video-animation),
   because presenting waits before the end.
4. `verdandi video lint` and `check` as usual; lint warns about a slide without `data-start`.

## Present it

`verdandi video present <dir>` opens it in the browser (the Studio's Present button does the same):

- → or Space: play on into the next slide; ← back one slide; Home and End jump.
- P opens the presenter window with the notes, the next slide's title and the time; F goes full screen; Esc leaves.

Rehearse once: every slide should rest on a finished state, with nothing still moving when it waits.
