# Text in motion

Readable first: text must hold still, fully formed, long enough to be read (about 3 words a second plus half a
second). Animate it in and out; don't keep it moving while it's being read beyond a slow drift.

## Masked line reveal

The line rises into view from behind an invisible edge. Mask with `clip-path`, not `overflow: hidden`: `check`
reports text cut by an overflow box as `clipped_text`, and the clip-path also leaves room for descenders.

```html
<h1 class="title"><span class="mask"><span>Seek, don't play</span></span></h1>
<style>
  .mask { display: block; clip-path: inset(-0.1em -0.1em 0 -0.1em); }
  .mask > span { display: inline-block; }
</style>
<script>
  tl.fromTo(".title .mask > span", { yPercent: 110 }, { yPercent: 0, duration: 0.8, ease: "power3.out" }, 0.2);
</script>
```

Several lines: one `.mask` per line, then `stagger: 0.12`.

## Words and letters

There's no SplitText in the project. Split once while building, before any tween, so it's deterministic. The
helper replaces the element's content with plain text, so split only elements that hold plain text: an emphasis
or highlight span inside it is lost. Put such a word in its own element next to the split one.

```js
// Wraps each word (or letter, with by = "char") of el in <span class="w">.
const split = (el, by = "word") => {
  const parts = by === "char" ? [...el.textContent] : el.textContent.trim().split(/\s+/);
  el.textContent = "";
  return parts.map((p, i) => {
    const s = document.createElement("span");
    s.className = "w";
    s.style.display = "inline-block";
    s.textContent = by === "char" ? (p === " " ? " " : p) : p;
    el.append(s);
    if (by === "word" && i < parts.length - 1) el.append(" ");
    return s;
  });
};
const words = split(document.querySelector(".line"));
tl.fromTo(words, { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.12 }, 0.6);
```

Letters: `split(el, "char")` and a short stagger (0.02–0.04). Letter-by-letter suits a few large words, never a
sentence.

Emphasis on one word: give it a class in the HTML (`<span class="em">fast</span>`), reveal it last or alone, then
punch it: `tl.fromTo(".em", { scale: 1 }, { scale: 1.12, duration: 0.15, yoyo: true, repeat: 1, ease: "power2.out" }, "hit")`.

## Typewriter

Use a monospace font, so every letter is `1ch` wide, and drive one CSS variable, the number of letters shown, with
a `steps()` ease. The text is uncovered by a clip-path and the cursor moves with it:

```html
<p class="typer"><span class="typed">verdandi video render</span><span class="cursor">_</span></p>
<style>
  .typer { position: relative; font: 500 64px ui-monospace, Menlo, Consolas, monospace; --n: 0; }
  .typed { clip-path: inset(-0.2em calc(100% - var(--n) * 1ch) -0.2em 0); }
  .cursor { position: absolute; left: 0; transform: translateX(calc(var(--n) * 1ch)); }
</style>
<script>
  // 21 letters at 20 a second.
  tl.fromTo(".typer", { "--n": 0 }, { "--n": 21, duration: 21 / 20, ease: "steps(21)" }, 0.5);
  // Then the cursor blinks 4 times: a hard on/off every 0.5 s.
  tl.fromTo(".cursor", { opacity: 1 }, { opacity: 0, duration: 0.5, ease: "steps(1)", repeat: 7, yoyo: true }, ">");
</script>
```

Typing speed: 15–25 letters a second reads as typing; slower drags. Revealing split letters with `opacity`
instead also works, but hidden letters keep their space, so a cursor after them waits at the end of the line.

## Highlighter sweep

A bar behind a word grows from the left. GSAP can't tween `::before`, so use a real element:

```html
<span class="hl"><span class="hl-bar"></span>matters</span>
<style>
  .hl { position: relative; display: inline-block; }
  .hl-bar { position: absolute; inset: 55% -0.1em 5% -0.1em; background: #e0a458; z-index: -1; transform-origin: left; }
</style>
<script>
  tl.fromTo(".hl-bar", { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: "power2.inOut" }, 1.4);
</script>
```

`z-index: -1` needs the text's container to create a stacking context (`isolation: isolate` on it), or the bar
disappears behind the page background.

## Rotating word

Stack the options in one slot and move one out as the next comes in:

```html
<span class="slot"><span class="opt">faster</span><span class="opt">cheaper</span><span class="opt">local</span></span>
<style>
  .slot { display: inline-grid; clip-path: inset(0 -0.1em); vertical-align: bottom; }
  .opt { grid-area: 1 / 1; }
</style>
<script>
  const opts = gsap.utils.toArray(".opt");
  tl.set(opts.slice(1), { yPercent: 100 }, 0);
  opts.slice(1).forEach((el, i) => {
    const at = 1 + i * 1.2;
    tl.to(opts[i], { yPercent: -100, duration: 0.4, ease: "power3.in" }, at)
      .fromTo(el, { yPercent: 100 }, { yPercent: 0, duration: 0.4, ease: "power3.out", immediateRender: false }, at + 0.2);
  });
</script>
```

The slot is as wide as its widest word, so the line doesn't jump.
