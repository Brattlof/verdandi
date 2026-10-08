# design.md template

Copy this into the project as `design.md`, fill it in, and show it to the user with the storyboard. Keep the
values exact (hex colours, pixel sizes): scenes copy them into CSS custom properties.

```markdown
# Design: <video name>

## Palette
| Role | Colour | Use |
|---|---|---|
| Background | #0b0b0c | Every scene's base |
| Surface | #1a1a1d | Cards, panels |
| Text | #f4f1ea | Body and titles |
| Muted | #9a958a | Secondary text, labels |
| Accent | #e0a458 | One thing per scene that matters: the number, the key word, the line |

Contrast checked: text on background 17.4:1, accent 9.0:1, muted 6.6:1.

## Type
- Display: "<family>", 800, tight (letter-spacing -0.02em, line-height 1.05). File: assets/fonts/<file> (or: installed / system-ui).
- Text: "<family>", 500.
- Scale at 1920×1080: hero 160 px · title 112 px · subtitle 64 px · body 44 px · label 32 px.

## Spacing and layout
- Safe area: 192 px left and right, 108 px top and bottom.
- Grid: 12 columns of 104 px with 32 px gutters inside the safe area.
- Corners: 24 px on cards; 0 on full-frame panels.
- Text aligns left on content scenes, centred on title cards.

## Motion
- Personality: clear and confident.
- Default: 0.6 s, power3.out; staggers 0.08–0.12 s.
- Transitions: push, 0.5 s, power3.inOut; the reveal scene uses a zoom through.
- Holds: every text holds (words ÷ 3) + 0.5 s; the final frame holds 2 s.

## Don'ts
- No gradients on text. No drop shadows except the scrim over footage.
- Accent never on more than one element at a time.
```

In `index.html`, turn the palette and scale into custom properties once, and use them everywhere (custom
properties defined on `:root` in `index.html` reach every mounted scene):

```css
:root {
  --bg: #0b0b0c; --surface: #1a1a1d; --text: #f4f1ea; --muted: #9a958a; --accent: #e0a458;
  --hero: 160px; --title: 112px; --subtitle: 64px; --body: 44px; --label: 32px;
  --safe-x: 192px; --safe-y: 108px;
}
```

## Picking a palette when the user gives none

- Start from the subject: a product's own brand colours (ask for them, or read them from its screenshots), a
  topic's natural colours, or a mood (warm neutrals for calm, near-black with one saturated accent for tech,
  off-white with ink and one colour for editorial).
- One background, one text colour, one muted, one accent. Add a second accent only for a two-sided comparison.
- Large smooth gradients show bands once encoded, dark ones most: keep them subtle, or add a little grain.
- Check every text/background pair for 4.5:1; compute it rather than guessing:

  ```bash
  bun -e 'const L=h=>{const c=[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4);return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]};const [a,b]=process.argv.slice(1).map(L).sort((p,q)=>q-p);console.log(((a+0.05)/(b+0.05)).toFixed(1))' '#f4f1ea' '#0b0b0c'
  ```
