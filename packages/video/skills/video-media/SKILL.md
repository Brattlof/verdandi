---
name: video-media
description: Local media for Verdandi videos with the tools on the user's machine. Covers where files go (assets/), declaring video and audio, probing, trimming, converting browser-hostile video (HEVC, ProRes, MKV, 10-bit, variable frame rate) to H.264, extracting audio, loudness normalization, fades, silence, contact sheets, and caption words (the text, start and end JSON that caption-karaoke takes) from a whisper transcript or from the script. Also optional local speech, transcription with whisper.cpp or openai-whisper and voiceover with say, espeak-ng, piper or Windows SAPI, when installed. Use when a video project uses footage, screenshots, music, voiceover or captions.
---

# Media for a composition

Verdandi is local-first: media comes from the user or from programs already on their machine. ffmpeg is always
there (renders need it). Speech tools are optional; check for them, and fall back when they're missing. Never
download media, models or voices without asking first.

## Where files go and how they're declared

- Everything goes in the project's `assets/` (`assets/footage/`, `assets/audio/`, `assets/screens/`,
  `assets/fonts/`). Name files for what they are (`vo.m4a`, `demo-trimmed.mp4`). Keep originals out of the
  project, or in `assets/source/` if the user wants them alongside; reference only the prepared copies.
- Never a `data:` URL, never a network URL: a render is offline (lint `base64_media_prohibited`, `remote_script`).
- Declare media as clips. Paths are relative to the file they're in; in a scene file that's `compositions/`, so
  a scene's media path starts `../assets/`.

```html
<video id="demo" src="assets/footage/demo.mp4" muted data-start="2" data-duration="6" data-playback-start="12.5"></video>
<audio id="vo" src="assets/audio/vo.m4a" data-start="0.5"></audio>
<audio id="music" src="assets/audio/bed.m4a" data-start="0" data-volume="0.25" loop data-duration="30"></audio>
```

- A `<video>` needs `muted` (picture only) or `data-has-audio="true"` (its sound goes in the mix).
- `data-playback-start` is the source time to start from: trim without re-encoding by choosing the window.
- `data-volume` is constant over the clip. There are no fades, ducking or volume automation in the runtime: bake
  them into the file with ffmpeg (below).
- The full attribute list is in **video-core**.

## Inspect before you use

```bash
ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate -of compact <file>
# A contact sheet of a clip, one frame a second, to see what's in it (open the PNG):
ffmpeg -v error -y -i <file> -vf "fps=1,scale=320:-1,tile=6x4" -frames:v 1 sheet.png
```

Look for: length, resolution and orientation (a phone clip may be 1080×1920), frame rate (`r_frame_rate` like
`30000/1001` is fine; wildly varying or 120/240 fps phone footage is worth converting), codec and pixel format,
and whether there's an audio stream.

## Prepare video

Convert when the preview can't play a file or `verdandi video timeline` shows a media clip running to `end`
(Chrome couldn't read its length), and always for ProRes, MKV, AVI, WMV, 10-bit H.264 or variable frame rate.
HEVC plays in Chrome on macOS and Windows with hardware support, not everywhere; convert it if the project will
be opened on another machine. The render itself decodes through ffmpeg, so this is about preview and timing.

```bash
# To H.264 at 30 fps, a keyframe every second (snappy scrubbing in the Studio), trimmed to 3 s from 1.5 s.
ffmpeg -v error -y -ss 1.5 -i <in> -t 3 -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 30 -g 30 \
  -c:a aac -b:a 192k -ar 48000 -movflags +faststart assets/footage/<name>.mp4
# Same, scaled to fit 1920 wide (keeps the aspect ratio, even height):
#   add  -vf "scale=1920:-2"
# Picture only (drops the sound): replace the audio options with -an, and declare the video muted.
```

Match the composition's fps (30 unless the user chose otherwise). Use `-crf 18` for footage that will be shown
full frame, 23 for small or background clips.

## Prepare audio

```bash
# Extract a clip's sound:
ffmpeg -v error -y -i <video> -vn -c:a aac -b:a 192k assets/audio/<name>.m4a
# Measure loudness (integrated LUFS):
ffmpeg -hide_banner -i <file> -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+I:" | tail -1
# Normalize: -16 LUFS for voice on the web and social, -14 for music-led pieces; true peak under -1.5 dB.
ffmpeg -v error -y -i <in> -af loudnorm=I=-16:TP=-1.5:LRA=11 -ar 48000 -c:a aac -b:a 192k assets/audio/vo.m4a
# Fade in 0.5 s and out over the last second of a 6 s file:
ffmpeg -v error -y -i <in> -af "afade=t=in:d=0.5,afade=t=out:st=5:d=1" -c:a aac -b:a 192k <out>.m4a
# Silence, e.g. a 2 s gap to splice between two takes:
ffmpeg -v error -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 2 -c:a aac assets/audio/silence-2s.m4a
```

- Normalize every voice and music file before placing it; then music under a voice sits at about
  `data-volume="0.2"`–`"0.3"` (roughly −14 to −10 dB).
- To leave room before a voice starts, set its `data-start` rather than padding the file with silence.
- A finished video with no sound has no audio track. Some platforms want one; add silence after rendering:
  `ffmpeg -i in.mp4 -f lavfi -i anullsrc=r=48000:cl=stereo -shortest -c:v copy -c:a aac out.mp4`.

## Images and screenshots

Put them in `assets/screens/` at least at the size they'll be shown (2× for anything that zooms in). Prefer PNG
for UI and text, JPEG for photos. Chrome doesn't show HEIC (iPhone photos): convert it, on macOS with
`sips -s format png in.heic --out assets/screens/name.png`, elsewhere with ImageMagick (`magick in.heic out.png`)
if installed, else ask the user for a PNG or JPEG. An `<img>` with `data-start` and no
`data-duration` shows for 3 s.

## Captions: words JSON

Caption blocks and hand-made captions take the spoken words with their times:

```json
[{ "text": "Every", "start": 0, "end": 0.39 }, { "text": "frame", "start": 0.39, "end": 0.8 }]
```

Seconds, relative to where the captions clip starts: mount the captions at the voiceover's `data-start` and the
times line up, or pass `--offset <voiceover start>` to place them in root time. The `caption-karaoke` block takes
exactly this as its `words` variable:

```bash
verdandi video add caption-karaoke --project <dir> --vars "{\"words\": $(cat <dir>/assets/captions.json)}"
```

Paste the element it prints after the video in `index.html`, then set its `data-start` to the voiceover's start
and its `data-duration` to the voiceover's length plus 0.5 s (the printed 9.5 s is the demo's).

`scripts/words.mjs` (in this skill's folder; runs with `bun` or `node`) makes the JSON:

```bash
# From a transcript with word timings (whisper.cpp or openai-whisper JSON):
bun <skill dir>/scripts/words.mjs whisper vo.json > assets/captions.json
# From the script alone, spread over the voiceover's length (no transcription needed):
bun <skill dir>/scripts/words.mjs script SCRIPT.txt --duration "$(ffprobe -v error -show_entries format=duration -of csv=p=0 assets/audio/vo.m4a)" > assets/captions.json
```

Script timing is an estimate: words land within a few tenths of a second, fine for phrase captions, loose for
word-by-word karaoke. Transcribe when the timing must be exact and a transcriber is installed. With no
voiceover at all, pace captions at reading speed instead: `--duration` = words ÷ 2.5.

Read the transcript before using it. Whisper invents words over silence and music ("Thank you."), and mishears
names and jargon: fix the `text` values against the script, keep the times.

## Optional: speech to text

| Check | Tool | Run |
|---|---|---|
| `command -v whisper-cli` | whisper.cpp (`brew install whisper-cpp`) | needs a model file `ggml-*.bin`; ask the user where theirs is, or whether to download one (`ggml-base.en.bin` is ~150 MB) |
| `command -v whisper` | openai-whisper (Python) | downloads its model on first use: ask first |

```bash
# whisper.cpp wants 16 kHz mono WAV, and one word per segment for word timings:
ffmpeg -v error -y -i assets/audio/vo.m4a -ar 16000 -ac 1 -c:a pcm_s16le /tmp/vo16k.wav
whisper-cli -m <model.bin> -f /tmp/vo16k.wav -ml 1 -sow -oj -of vo -np      # writes vo.json
# openai-whisper:
whisper assets/audio/vo.m4a --model base --word_timestamps True --output_format json --output_dir .
```

Neither installed: use the script mode above, or ask the user for a transcript or subtitle file.

## Optional: text to speech

Local voices are serviceable, not studio quality. Say so, and offer the alternatives: the user records the
voiceover, or the video runs on captions and music only.

| Check | Tool | Run |
|---|---|---|
| macOS: `command -v say` | built in | `say -v '?'` lists voices; `say -v Samantha -r 175 -f SCRIPT.txt -o /tmp/vo.aiff` |
| `command -v espeak-ng` | espeak-ng (robotic) | `espeak-ng -v en-us -s 160 -f SCRIPT.txt -w /tmp/vo.wav` |
| `command -v piper` | piper (neural, needs a voice `.onnx`) | `piper --model <voice.onnx> --output_file /tmp/vo.wav < SCRIPT.txt` |
| Windows | SAPI, built in | `powershell -c "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('vo.wav'); $s.Speak((Get-Content SCRIPT.txt -Raw))"` |

Then normalize it into `assets/audio/vo.m4a` (above), measure its length with ffprobe, and fit the storyboard to
it: the voice sets the pace, not the other way round. One file per scene (`vo-01-hook.m4a`, …) makes retiming a
scene easy; one file for the whole script keeps the delivery even. Spell numbers and acronyms the way they should
be said ("seventy-three percent", "S Q L") in the TTS input, not in the on-screen text.

