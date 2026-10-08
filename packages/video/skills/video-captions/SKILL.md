---
name: video-captions
description: Step-by-step workflow to add burned-in captions to an existing talking-head or voiceover video with Verdandi, locally - probe and prepare the footage, get word timings (whisper if installed, else the script), build a caption overlay, check, review and render. Use when the user has a video file and wants captions or subtitles added, karaoke-style word highlighting, or a captioned version for social media. Not for making a new video from scratch (video-explainer, video-motion-graphics).
---

# Captioning a video

The footage stays as it is; the captions are a layer over it. Load **video-core** (the contract) and
**video-media** (ffmpeg, transcription, the words JSON) as you go.

## 1. Look at the clip first

```bash
ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate -of compact <video>
ffmpeg -v error -y -i <video> -vf "fps=1,scale=320:-1,tile=6x4" -frames:v 1 /tmp/sheet.png   # then open it
```

Note the length, the orientation (a phone clip is usually 1080×1920), whether it has an audio stream, and where
the speaker and any on-screen text sit. Stop and tell the user when:

- there's no speech (or no audio stream at all): there's nothing to caption;
- the footage already has burned-in captions or heavy text: a second layer would collide;
- it's very long (over ~10 minutes): offer to caption a cut-down, or confirm they want it all, since renders
  run at about real time or slower.

## 2. Set up the project

1. `verdandi video init <dir> --resolution <landscape|portrait|square>`, matching the clip's orientation.
   For a size the presets don't cover, change the root's `data-width`/`data-height` (and the page CSS) to the
   clip's.
2. Prepare the footage into `assets/footage/` (video-media → Prepare video): convert to H.264 when needed, keep
   its sound. Then normalize the sound: extract, `loudnorm`, and use the normalized file as the audio track.
   Simplest: keep the picture muted and add the voice as `<audio>`.

```html
<video id="talk" src="assets/footage/talk.mp4" muted data-start="0" data-track-index="0"></video>
<audio id="voice" src="assets/audio/voice.m4a" data-start="0" data-track-index="1"></audio>
```

With CSS `#talk { inset: 0; width: 100%; height: 100%; object-fit: cover; }`. Set the root's `data-duration`
to the clip's length.

## 3. Get the words

In order of preference (video-media → Captions, speech to text):

1. A transcript or subtitle file the user has: fix it into the words JSON with times from whisper, or from
   script mode if there are no times.
2. `whisper-cli` or `whisper` installed (with a model, or the user's go-ahead to download one): transcribe, then
   `words.mjs whisper`.
3. The user's script: `words.mjs script` over the voice's length. Tell the user the timing is estimated and may
   drift by a few tenths of a second.
4. None of these: ask the user for the script. Don't caption from memory or guesswork.

**Read the words before using them.** Fix misheard names and jargon in `text`, keep the times. Drop filler
("um", "uh") unless the user wants a verbatim record. Save the result as `assets/captions.json`.

## 4. Build the overlay

For karaoke-style captions (phrases with the spoken word lit), use the `caption-karaoke` block:

```bash
verdandi video add caption-karaoke --project <dir> --vars "{\"words\": $(cat <dir>/assets/captions.json)}"
```

Paste the printed element after the `<video>` in `index.html`, set `data-start` to the voice's start and
`data-duration` to the voice's length plus 0.5 s. Its colours are variables too (`color`, `highlight`; see
`verdandi video catalog caption --json`), and its CSS is yours to edit in `compositions/caption-karaoke.html`.

For plain phrase captions, a different position or your own style, use the overlay in
`references/caption-overlay.md` instead: copy it to `compositions/captions.html`, paste the words in, and mount it
the same way.

Style choices, briefly (video-creative has the reasoning):

- Plain phrase captions for interviews and explainers; word highlight (karaoke) for social clips.
- 48–64 px at 1080 p, weight 600+, on a scrim. 2–5 words a phrase, never more than two lines.
- Inside the safe area, clear of the speaker's face and mouth. For 9:16, above the bottom 400 px.
- One accent colour for the highlighted word, from the user's brand if they have one.

## 5. Check and look

1. `verdandi video check <dir>`; every finding needs fixing.
2. Snapshot a moment in each third of the video, and any moment where the speaker moves towards the captions:
   `verdandi video snapshot <dir> --at <times>`. Tile and open them (video-animation → Verify motion).
3. Check: every phrase readable against the footage, no caption over the face, no caption over burned-in text,
   phrases change at natural breaks.

## 6. Review and render

Show the user the snapshots (or the Studio: `verdandi web` → Video). After they approve:

```bash
verdandi video render <dir>                      # MP4 with the voice mixed in
ffprobe -v error -show_entries format=duration -of csv=p=0 <dir>/renders/<dir>.mp4
```

The length should match the source clip. Report the path, length and size. Offer the words JSON too: it's the
start of an `.srt` if they also want a separate subtitle track.
