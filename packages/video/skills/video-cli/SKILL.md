---
name: video-cli
description: Reference for every `verdandi video` subcommand (init, catalog, add, lint, check, timeline, snapshot, preview, render, skills) with its flags, plus how to read lint and check findings, which render format and quality to pick, and what to do when Chrome or ffmpeg is missing. Use when running video commands, diagnosing a failed lint, check or render, or choosing an output format.
---

# `verdandi video`

Every command takes the project folder as its first argument, defaulting to the current folder. `add` is the
exception: it takes the block name first, and the folder with `--project`. Every command that opens the page
also accepts `--entry <page>`, which renders a page other than `index.html`. A failed command exits 1 and prints
the cause and the fix.

| Command | Use it to |
|---|---|
| `init <dir> [--resolution R]` | Start a project. `R` is `landscape` (1920×1080, the default), `portrait` (1080×1920), `square` (1080×1080), or `landscape-4k`, `portrait-4k`, `square-4k`. It refuses a folder that isn't empty. |
| `catalog [words…] [--json]` | List the ready-made blocks, or only those matching every word. Each shows the name, length, title, description and tags, then its variables with their defaults (`variables (--vars): id=default, …`). `--json` has the full declarations (type, label, options). |
| `add <block> [--project <dir>] [--vars '<json>'] [--force]` | Copy a block to `compositions/<block>.html` (its assets to `assets/<block>/`) and print the host element to paste (`style="inset: 0"`, `data-track-index="1"`; use track 0 for a full-frame scene such as `end-card`). `--vars` puts `data-variable-values` on that host. It refuses to overwrite a file unless `--force`, which discards your edits to it. |
| `lint [dir] [--json] [--verbose]` | Check the source without a browser. It's fast, so run it after every edit. `--verbose` also shows info findings. Exits 1 on errors. |
| `check [dir] [--samples N] [--strict] [--json]` | Lint, then load the page in Chrome and sample it at N times (default 9). Use it as the gate before showing the user. `--strict` also fails on warnings. |
| `timeline [dir] [--json]` | Print the resolved tracks and clips, each with its absolute start and end. Use it to understand an existing project, or to confirm that `data-start` references resolved as you meant. |
| `snapshot [dir] [--at s,s,…] [--frames N] [--output <dir>]` | Write PNGs at those times, or N evenly spaced ones (default 5), to `snapshots/frame-NN-at-T.TTs.png`. Open the images and look at them. |
| `preview [dir] [--port N] [--no-open] [--home <dir>]` | Open the project in the web UI's Studio (preview, timeline, editor, render queue) and serve it until Ctrl+C. It runs for a long time, so start it in the background or hand the command to the user. It refuses a folder without `index.html`. |
| `render [dir] [--format F] [--quality Q] [--fps N] [--crf N] [--workers N] [--output <file>] [--variables '<json>']` | Encode the video. The default is `renders/<dir name>.mp4`. |
| `skills [--force] [--home <dir>]` | Install these video skills into the profile's skills folder. A copy you edited is kept unless `--force`. |

## The loop

`lint` after each edit, `check` before review, `snapshot --at` the middle of each scene and look, then show the
user the Studio (`verdandi video preview <dir>`). Render only after they approve. `check` already runs
lint, so don't run both in a row.

## Reading findings

Each finding is printed as `✗ file:line code: message`, followed by `Fix: …`. `✗` is an error, `⚠` a warning
and `ℹ` info. Apply the fix the finding gives. `references/lint-codes.md` explains every code. Two things to know:

- `check` **skips the browser pass while lint has errors**: it prints "Skipped the browser pass: fix the lint
  errors first." When the pass ran, it prints "Ran it in Chrome at <times>." No such line means the page wasn't
  tested.
- `check` reports page findings (`console_error`, `request_failed`, layout findings) against `index.html`, with no
  line number, even when a scene file caused them. The message names the element or URL. Find it with
  `timeline`, or by searching for that id in `compositions/`.

## Render formats

| Format | Pick it for | Notes |
|---|---|---|
| `mp4` (default) | Anything that's watched: sharing, upload, embedding | H.264, plus an AAC audio stream only when something is audible (no audio stream for a silent video). No transparency. |
| `webm` | A transparent overlay for the web, or a smaller file | VP9 with alpha, and Opus audio when something is audible. |
| `mov` | A transparent overlay for an editor (Premiere, Final Cut, Resolve) | ProRes 4444 with alpha. Large files. `--quality` and `--crf` don't apply. |
| `gif` | A short silent loop for a README or chat | Two-pass palette. No audio. Keep it short and small. |
| `png-sequence` | Frames for another tool | A folder of `frame_000001.png`, … with alpha. No audio. |

**For transparency**, the page must not paint a background. The template sets `background` on `html, body`, so
remove it, and any full-frame background in the scenes, before you render `webm`, `mov` or `png-sequence` with
alpha.

| Quality | MP4 | Use |
|---|---|---|
| `draft` | x264 ultrafast, CRF 28 | Fast full-motion review while iterating. |
| `standard` (default) | x264 medium, CRF 18 | The deliverable. |
| `high` | x264 slow, CRF 15 | Fine gradients or text, or footage that will be re-encoded. |

`--crf` overrides the preset (lower means better and bigger; for mp4 and webm only). `--fps` is 1 to 240,
default 30: use 24 for a film look, or 60 for fast motion or screen recordings. `--workers` is the number of
Chrome processes capturing at once. The default is 1 below 90 frames, otherwise up to 4 (a third of the CPU
cores); lower it on a machine short of memory. Render time scales with fps × duration × pixels: a 10 s 1080p30
draft took about 25 s on an M-series Mac with 4 workers.

`--variables '{"title":"…"}'` overrides variables for this render only. It applies to every composition, and a
host's `data-variable-values` still wins. Use it to render versions of one template.

After a render, the command prints the output path, its dimensions, duration and frame count, and the time each
stage took. Confirm the result with `ffprobe -v error -show_entries format=duration -of csv=p=0 <file>`.

## Prerequisites

- **Chrome:** `check`, `timeline`, `snapshot` and `render` start headless Google Chrome. If it's missing, the
  user installs it, or sets `VERDANDI_CHROME` to a Chrome or Chromium binary.
- **ffmpeg:** `render` (and `snapshot` when the project plays video files) needs `ffmpeg` and `ffprobe` on
  `PATH`, or `VERDANDI_FFMPEG` and `VERDANDI_FFPROBE`. On macOS: `brew install ffmpeg`. On Windows:
  `winget install ffmpeg`.
- Renders run offline. A composition that loads scripts or media over the network renders only while the
  network is up, and lint warns about it.
