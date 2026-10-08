# STORYBOARD.md format

The storyboard is the plan the user approves before anything is built. One row per scene; the scene id is the
id of its host element and its file in `compositions/`, so the plan and the code line up.

```markdown
# Storyboard: <video name>

- Destination: LinkedIn feed, 1:1 (1080×1080), 30 fps
- Length: 32 s
- Message: <the one sentence a viewer should remember>
- Audience: <who, and what they already know>
- Sound: voiceover (local TTS, voice "Samantha") + no music | captions only | silent
- Design: design.md

| # | Scene id | Start | Length | On screen | Text on screen | Voiceover | Motion / transition in |
|---|---|---|---|---|---|---|---|
| 1 | hook | 0.0 | 3.0 | Big number, nothing else | "73%" / "of renders fail offline" | "Seventy-three percent of renders fail offline." | Number counts up; hard cut in |
| 2 | problem | 2.5 | 5.0 | Three failing icons in a row | "Fonts. Scripts. Media." | "Fonts, scripts and media load from the network…" | Push from right; icons stagger in |
| 3 | … | | | | | | |
```

Rules:

- **Start** is when the scene's window opens. With a transition of T seconds, a scene starts T before the
  previous one ends (2.5 above, after a 3.0 s scene with a 0.5 s push). The last row's start + length is the
  video's length.
- **Length** fits the words: on-screen text needs (words ÷ 3) + 0.5 s; voiceover needs its words ÷ 2.5. Take
  the larger, plus the entrance.
- **Text on screen** is the exact copy, not a description. Short: a scene with more than about 12 words on screen
  is a slide, not a video.
- **Voiceover** is the exact script for that scene. Join the column to get `SCRIPT.md` (or the TTS input).
- **On screen** names real material when there is some: `assets/screens/dashboard.png`, the logo file, a
  clip and its time range.
- **Motion** says what moves and how the scene arrives, in the motion personality of `design.md`.

Show the user the storyboard (and `design.md`) and wait for a yes before building more than one scene. A change
here costs a minute; the same change after the build costs a rebuild.

## From storyboard to project

- Each row becomes `<div id="<scene id>" data-composition-id="<scene id>" data-composition-src="compositions/<scene id>.html" data-start="<previous id> - <T>" data-duration="<length>">`.
- Overlays that span scenes (captions, a logo bug, the voiceover `<audio>`) are separate clips in `index.html`,
  timed in root seconds.
- The root's `data-duration` is the storyboard's length.
