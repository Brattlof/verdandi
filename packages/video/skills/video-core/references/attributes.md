# Attributes and globals

Everything the runtime reads. Anything else you add is ordinary HTML.

## Root composition

| Attribute | Meaning |
|---|---|
| `data-composition-id` | The composition's id. Its timeline is registered under this key. |
| `data-width`, `data-height` | Canvas size in pixels. Required on the root (lint `root_missing_dimensions`); 1920×1080 if missing. |
| `data-duration` | Video length in seconds. Without it, the furthest end of any clip, media file or timeline. |
| `data-start` | `"0"` on the root, by convention. |
| `data-root="true"` | Marks the root when a page has several elements with `data-composition-id`. The first one otherwise. |
| `data-composition-variables` | JSON array of variable declarations (see Variables). |

## Clips (any element with `data-start`)

| Attribute | Meaning |
|---|---|
| `data-start` | Seconds, or `<id>`, `<id> + n`, `<id> - n`: the end of the element with that `id` (or `data-composition-id`), shifted. Relative to the enclosing composition. A reference to an id no file has is a lint error (`unknown_start_reference`). |
| `data-duration` | Positive seconds. |
| `data-end` | An alternative to `data-duration` when `data-start` is a number: the end in seconds. |
| `data-track-index` | Integer lane in the Studio's timeline, and nothing else. (`data-layer` is an old name; lint warns about it.) |
| `data-hidden` | Hidden in preview and render (`display: none`), whatever its window. Also works on elements without `data-start`. |
| `data-label` | The clip's name in `verdandi video timeline` and the Studio, when the `id` isn't descriptive enough. |
| `data-layout-ignore` | `check` doesn't report text in this subtree as off the canvas or clipped. Use it for text that leaves the frame on purpose. |
| `class="clip"` | Convention only. |

Default lengths when `data-duration` is missing: the media's natural length (after `data-playback-start`, divided
by the rate) for `<video>` and `<audio>`, 3 s for `<img>`, the registered timeline's length for a sub-composition
host, and to the end for anything else.

## Sub-composition host

| Attribute | Meaning |
|---|---|
| `data-composition-id` | The id this mount is known by: its timeline key and its `data-start` reference. Usually the same as the file's inner id. |
| `data-composition-src` | Path of the scene file, relative to the file the host is in (for a host in `index.html`, the project root). |
| `data-start`, `data-duration` | When the scene plays. |
| `data-variable-values` | JSON object of variable values for this mount only. |
| `data-width`, `data-height` | Optional; copied from the file's inner root if missing. |

An empty element `<div data-composition-id="x"></div>` with a `<template id="x-template">` in the same page mounts
that inline template instead of a file.

## Media (`<video>`, `<audio>`)

| Attribute | Meaning |
|---|---|
| `id` | Required and unique (`media_missing_id`, `duplicate_media_id`). |
| `src` or a `<source src>` child | A file in the project. Never a `data:` URL. |
| `data-start` | Required (`media_missing_data_start`). |
| `data-duration` | Optional; defaults to the source's remaining length. |
| `muted` / `data-has-audio="true"` | One of them is required on `<video>`. `muted` (or `data-has-audio="false"`) keeps it out of the mix. `<audio>` is always mixed. |
| `data-playback-start` | Source seconds to start from (alias `data-media-start`). |
| `data-playback-rate` | Speed, clamped to 0.1 to 10. Audio is time-stretched to match. |
| `data-volume` | Gain, 0 to 3.98, default 1. Constant over the clip: there are no fades or volume automation. |
| `loop` | Repeat the source to fill the window. |
| `preload="none"` | Avoid it (lint warns): the runtime needs metadata to know the length. |

## Variables

`data-composition-variables` on a composition root is a JSON array of
`{ "id", "type", "label", "default" }`, where `type` is `string`, `number`, `color`, `boolean`, `enum` (with
`"options": [...]`) or `image`. The values in force for a mount are merged in this order, the last one winning:
the declared defaults, then `render --variables` (applied to every composition), then the host's
`data-variable-values`.

| Hook | Effect |
|---|---|
| `--<id>` | Each string, number or boolean value is set as a CSS custom property on the composition's element. |
| `data-var-text="<id>"` | Replaces the element's own text with the value. |
| `data-var-src="<id>"` | Sets `src` on an `img`, `video`, `audio` or `source`, from a URL string or `{ "url": … }`. |
| `__verdandi.getVariables()` | In a script: the values for this mount, as an object. |

These apply only within the composition's own elements, not inside compositions nested in it.

## Globals a composition may use

| Global | Use |
|---|---|
| `window.__timelines["<id>"] = tl` | Register the composition's paused GSAP timeline. Created by the runtime before your scripts run. |
| `__verdandi.getVariables()` | Variable values for this composition. |
| `__verdandi.assetUrl("assets/x.png")` | An absolute URL for a path relative to this composition's own file. |
| `__verdandi.duration()` | This mount's clip length in seconds (its host's `data-duration`, or the root's), or `undefined` without one: for a block that must fill its clip, like a ticker. |
| `window.__vdBuildReady.push(promise)` | Holds the first frame until the promise settles, for example while you fetch Lottie JSON or build a scene. Capped at 15 s. |
| `window.__vdLottie.push(anim)` | Registers a lottie-web animation that `lottie.getRegisteredAnimations()` doesn't already list. Create the array if it's missing: `(window.__vdLottie ??= []).push(anim)`. |
| `window.__vdAnime.push(instance)` | Registers an anime.js instance. Create the array if it's missing. |
| `window.addEventListener("vd-seek", e => …)` | Draw `e.detail.time`. Call `e.detail.waitUntil(promise)` synchronously to hold the frame. |
| `vd-ready` event on `window` | Fires once the composition is assembled and seeked to 0. |

`window.__vd` is the renderer's protocol (`seek`, `manifest`, …). Don't call it from a composition.
