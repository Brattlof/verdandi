# Lint and check codes

E = error (lint and check exit 1), W = warning (fails only `check --strict`). Codes from `lint` come from the
source and carry a file and line. The last table's codes come from running the page in `check`.

## Structure

| Code | | Cause | Fix |
|---|---|---|---|
| `root_missing_composition_id` | E | No element has `data-composition-id`. | Give the root `data-composition-id="main"`, plus its size and duration. |
| `root_missing_dimensions` | E | The root in `index.html` has no `data-width` or `data-height`. | Add both. |
| `standalone_composition_wrapped_in_template` | E | `index.html` starts with `<template>`. | Only scene files use `<template>`. |
| `host_missing_composition_id` | E | A `data-composition-src` host has no `data-composition-id`. | Add the scene's id. |
| `missing_sub_composition` | E | The `data-composition-src` file doesn't exist. | Fix the path, or create the file. |
| `unknown_start_reference` | E | A `data-start` like `"intro + 1"` names an id no file in the project has. | Name the clip it should follow, or use seconds. |
| `absolute_project_path` | W | A `src`, `href`, `poster` or `data-composition-src` starts with `/`, which breaks under the Studio's preview prefix. | Make it relative to the file. |
| `duplicate_composition_id` | E | Two compositions in one file share an id. | Rename one. To show a scene twice, mount its file twice. |
| `invalid_timing` | E | `data-start` isn't seconds or `<id> [+-] n`, or `data-duration` isn't positive. | Use `"1.5"`, `"intro + 0.5"`, or `data-duration="2"`. |
| `deprecated_data_layer` | W | Uses `data-layer`. | Rename it to `data-track-index`. |

## Media

| Code | | Cause | Fix |
|---|---|---|---|
| `media_missing_id` / `duplicate_media_id` | E | A `<video>` or `<audio>` has no id, or shares one. | Give each a unique id. |
| `media_missing_data_start` | E | Media without `data-start` never plays. | Add `data-start`. |
| `media_missing_src` | E | No `src` and no `<source>`. | Point it at a file in `assets/`. |
| `base64_media_prohibited` | E | The media is a `data:` URL. | Save it to `assets/`. |
| `missing_local_asset` | E | An img, media, stylesheet or script path doesn't exist (relative to the file it's in). | Fix the path, or add the file. |
| `self_closing_media_tag` | E | `<video … />` swallows what follows it. | Write `<video …></video>`. |
| `video_missing_muted` | E | A `<video>` has neither `muted` nor `data-has-audio`. | Add `muted`, or `data-has-audio="true"` to keep its sound. |
| `video_muted_with_declared_audio` | E | It has both. | Keep one. |
| `video_nested_in_timed_element` | E | A timed `<video>` sits inside another timed plain element. | Time the wrapper or the video, not both. |
| `media_preload_none` | W | `preload="none"` hides the length. | Remove it. |
| `imperative_media_control` | E | A script calls `.play()` or `.pause()`, or sets `.currentTime`, and mentions media or DOM lookups. | Remove it; use `data-start`, `data-duration` and `data-playback-start`. Calls on a variable bound to `gsap.timeline(...)` don't count. |

## Scripts and styles

| Code | | Cause | Fix |
|---|---|---|---|
| `module_script_in_sub_composition` | E | A scene file has `<script type="module">`, which never runs there. | Use a classic `<script>`, or load the module from `index.html`. |
| `missing_gsap_script` | E | `index.html` uses `gsap.` but doesn't load it. | Add `<script src="vendor/gsap.min.js"></script>` to `<head>`. |
| `remote_script` / `remote_stylesheet` | W | Loads code or CSS from the network. | Save it into `vendor/` or `assets/`. |
| `invalid_inline_script_syntax` | E | A script doesn't parse. | Fix the syntax. |
| `gsap_timeline_not_registered` | E | A script builds `gsap.timeline(` but never assigns `__timelines[...]`. | Register it in the same script. |
| `timeline_id_mismatch` | E | The `__timelines` key isn't a `data-composition-id` in that file. | Use the composition's id. |
| `timeline_played` | E | `tl.play(` found. | Remove it; create the timeline `{ paused: true }`. |
| `non_deterministic_code` | E | `Math.random`, `Date.now`, `new Date()`, `performance.now`, `crypto.getRandomValues`, `gsap.utils.random` or `"random(…)"`. | Use a seeded generator or fixed values. |
| `requestanimationframe_in_composition` | E | A `requestAnimationFrame` loop. | Animate on the timeline, or draw on `vd-seek`. |
| `gsap_infinite_repeat` | W, or E without a root duration | `repeat: -1`. | Use a finite count, or set the root's `data-duration`. |
| `css_transition_used` | W | A CSS `transition` runs on the wall clock. | Animate it on the timeline. |
| `invalid_composition_variables_declaration` | E | The declaration isn't a JSON array of `{id, type, label, default}` with a known type. | Fix the JSON. |
| `invalid_variable_values_json` | E | `data-variable-values` isn't a JSON object. | Use `'{"key":"value"}'`, in single quotes around the attribute. |

## From the running page (`check`)

| Code | | Cause | Fix |
|---|---|---|---|
| `composition_not_ready` | E | The runtime never finished starting (60 s) or threw. | Read the message; usually a script error or a load that hangs. |
| `console_error` | E | The page logged an error. `[verdandi] composition script error in <id>` names the scene. | Fix the script. |
| `request_failed` | E | A URL returned 4xx or failed. | Fix the path; paths in a scene file are relative to that file. |
| `no_duration` | E | The video has no length. | Set the root's `data-duration`. |
| `clip_ends_past_root_duration` | W | A clip ends after the root's duration, so it's cut off. | Extend the root's duration, or shorten the clip. |
| `gsap_animates_clip_element` | E | A registered timeline tweens `visibility`, `display` or `autoAlpha` on a clip. | Tween `opacity`, or animate a child. |
| `text_outside_canvas` | W | Visible text extends past the canvas at a sampled time. | Resize or move it, or add `data-layout-ignore` when it leaves the frame on purpose. |
| `clipped_text` | W | Text is cut off by its own element or an ancestor with `overflow` other than `visible` (not one with `text-overflow: ellipsis`, a deliberate cut). | Give it room, or let the box grow. |
| `contrast_aa_failure` | E/W | Visible text has less than WCAG AA contrast with what is behind it (4.5:1, or 3:1 for 24px or 19px bold). Error when seen at two sample times, warning at one (often mid-entrance). | Change the text or background colour, or add a scrim or shadow behind it. |
| `sweep_static` | W | All the sampled frames look identical in a video of 3 s or more. | Check that each timeline is registered under its composition's id and that clips have `data-start`. |

The layout checks only look at text that is visible and not fully transparent at the sampled times. Sample more
densely with `--samples 20` when a short entrance could hide a problem.
