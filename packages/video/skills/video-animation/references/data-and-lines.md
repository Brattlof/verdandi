# Numbers, bars and lines

## Counting number

Tween a plain object and write the formatted value in `onUpdate`. GSAP calls it on every seek, forwards or back.
Put the start value in the HTML too, so the first frame is right before the timeline renders.

```html
<div class="stat"><span class="num">0</span><span class="unit">%</span></div>
<style>
  .stat { font: 800 220px system-ui; font-variant-numeric: tabular-nums; }
</style>
<script>
  const num = document.querySelector(".num");
  const counter = { v: 0 };
  tl.to(counter, {
    v: 1280, duration: 1.5, ease: "power2.out",
    onUpdate: () => { num.textContent = Math.round(counter.v).toLocaleString("en-US"); },
  }, 0.4);
</script>
```

- `tabular-nums` keeps digits the same width, so the number doesn't jitter as it counts. With a font that lacks
  it, give the number a fixed `min-width` and right-align it.
- `power2.out` or `expo.out`: fast at first, settling on the final value. Hold the final value at least 1.5 s.
- Pin the locale (`"en-US"`, or the audience's) so the separators don't depend on the machine.
- Pair it with a scale punch on landing: `tl.fromTo(".stat", { scale: 1 }, { scale: 1.06, duration: 0.15, yoyo: true, repeat: 1 }, ">")`.

## Bars

Grow from an edge with `scaleX`/`scaleY` and a `transform-origin`; the final width or height is plain CSS.

```html
<div class="bars">
  <div class="bar" style="width: 72%"></div>
  <div class="bar" style="width: 45%"></div>
  <div class="bar" style="width: 88%"></div>
</div>
<style>
  .bars { display: grid; gap: 24px; width: 1200px; }
  .bar { height: 56px; background: #e0a458; transform-origin: left center; }
</style>
<script>
  tl.fromTo(".bar", { scaleX: 0 }, { scaleX: 1, duration: 0.8, ease: "power3.out", stagger: 0.12 }, 0.5);
</script>
```

Label each bar's value with a counting number that starts with it.

## Drawing a line (SVG)

Measure the path once while building (`getTotalLength()` is geometry, so it doesn't wait for fonts), make one
dash as long as the path, and move the dash offset from the full length to 0:

```html
<svg viewBox="0 0 800 120" width="800" height="120">
  <path class="draw" d="M10 60 C 200 0, 400 120, 790 60" />
</svg>
<style>
  .draw { fill: none; stroke: #e0a458; stroke-width: 12; stroke-linecap: round; }
</style>
<script>
  for (const [i, path] of document.querySelectorAll(".draw").entries()) {
    const len = path.getTotalLength();
    tl.fromTo(path, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.2, ease: "power2.inOut" }, 0.6 + i * 0.15);
  }
</script>
```

- Don't use the `pathLength="1"` shortcut with a dash of 1: in Chrome the line stays hidden and then appears whole
  halfway through, instead of drawing.
- With `stroke-linecap: round`, a dot of the cap shows at the start before the line draws. Fade the stroke in
  over the first 0.1 s, or use `butt` caps, if that matters.
- Lettering or an icon traced as paths draws the same way, one path after another.
- A progress ring is a `<circle>` (also measurable with `getTotalLength()`) with `transform: rotate(-90deg)` and
  `transform-origin: center`, drawn to `strokeDashoffset: len * (1 - share)`.
- Fill after drawing: tween `fillOpacity` from 0 once the stroke completes (`">"`).
- Line charts: one `<path>` from your data points, drawn the same way, with dots popping in at each point.

## Pie or donut share

A donut segment is the same ring with `strokeDashoffset` ending at `len * (1 - share)`. For several segments, give each
circle a `rotate` equal to the sum of the shares before it × 360°, and stagger them.
