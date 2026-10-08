# Caption overlay

A sub-composition that turns the words JSON (video-media's `words.mjs`) into phrase captions on a rail near the
bottom of the frame, optionally lighting each word as it's spoken. Save it as `compositions/captions.html`, paste
the JSON into `WORDS`, and mount it at the voiceover's start:

```html
<div id="captions" data-composition-id="captions" data-composition-src="compositions/captions.html"
     data-start="<voiceover start>" data-duration="<voiceover length + 0.5>" data-track-index="2"></div>
```

Put it after the video in the document so it draws on top. Word times are relative to the captions' own start.

```html
<template>
  <div id="captions" data-composition-id="captions" data-width="1920" data-height="1080">
    <style>
      .rail { position: absolute; left: 192px; right: 192px; bottom: 140px; display: grid; justify-items: center; }
      .phrase { grid-area: 1 / 1; max-width: 1300px; padding: 10px 28px; border-radius: 14px; background: rgb(0 0 0 / 0.6);
        font: 700 56px/1.25 system-ui, sans-serif; color: rgb(255 255 255 / 0.7); text-align: center; opacity: 0; }
    </style>
    <div class="rail"></div>
    <script>
      const WORDS = [/* paste assets/captions.json here */];
      const HIGHLIGHT = "#ffd166"; // the spoken word; set to null for plain phrase captions
      // Phrases: break after punctuation, a pause over 0.4 s, or 5 words.
      const phrases = [];
      let current = [];
      WORDS.forEach((w, i) => {
        current.push(w);
        const next = WORDS[i + 1];
        if (!next || current.length >= 5 || /[.!?,;:]$/.test(w.text) || next.start - w.end > 0.4) {
          phrases.push(current);
          current = [];
        }
      });
      const rail = document.querySelector(".rail");
      const tl = gsap.timeline({ paused: true });
      phrases.forEach((words, i) => {
        const el = document.createElement("div");
        el.className = "phrase";
        const spans = words.map((w) => {
          const s = document.createElement("span");
          s.textContent = w.text;
          el.append(s, " ");
          return s;
        });
        rail.append(el);
        const start = words[0].start;
        const next = phrases[i + 1]?.[0].start ?? Infinity;
        const end = Math.min(words[words.length - 1].end + 0.4, next);
        tl.set(el, { opacity: 1 }, start).set(el, { opacity: 0 }, end);
        if (HIGHLIGHT) words.forEach((w, j) => tl.set(spans[j], { color: HIGHLIGHT }, w.start));
      });
      window.__timelines["captions"] = tl;
    </script>
  </div>
</template>
```

Adjust in this order:

- **Position**: `.rail`'s `bottom` and `left`/`right` keep it in the safe area. For 1080×1920 social video, raise
  it to `bottom: 420px` (above the app's own captions and buttons) and narrow the phrase to `max-width: 900px`.
  Move it to the top (`top: 160px`, drop `bottom`) when the bottom of the footage is busy: a desk, hands, a
  product.
- **Phrase length**: `current.length >= 5` sets the most words per phrase. Fewer (2–3) for punchy social
  captions; up to 7 for calm interviews, but never more than two lines.
- **Look**: the scrim (`background`) keeps text readable over any footage. Keep it unless the footage is dark and
  even behind the rail everywhere. `HIGHLIGHT = null` gives plain captions.
- **Phrase motion**: the captions cut in and out (`tl.set`), which reads best for speech. For a softer entrance,
  replace the first `set` with `tl.fromTo(el, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.15, ease: "power2.out" }, start)`.

Everything is built from the JSON while the script runs and changed only through the timeline, so it's
seek-safe.
