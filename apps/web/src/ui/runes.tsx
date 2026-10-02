/**
 * Elder Futhark runes, drawn as carved strokes on the icons' 16px grid: straight lines, square ends.
 * Each icon's rune is chosen for its meaning (fehu, wealth, for Spend). Runes that hate groups have
 * taken up (Algiz, Tiwaz, Sowilo, Othala, Hagalaz) are left out on purpose; keep them out.
 * Always decorative: the control carries the name, as visible text or an `aria-label`.
 */
const glyphs = {
  fehu: "M5.5 2v12M5.5 6.5l5.5-4M5.5 10.5l5.5-4",
  uruz: "M4.5 14V2l7 4.5V14",
  thurisaz: "M5 2v12M5 5l5.5 3L5 11",
  ansuz: "M5.5 2v12M5.5 2l5.5 4M5.5 6.5l5.5 4",
  raidho: "M5 14V2l5.5 3L5 8l6 6",
  kenaz: "M11 2.5L5 8l6 5.5",
  wunjo: "M5 14V2l5.5 3L5 8",
  naudiz: "M8 2v12M5 6l6 4",
  isa: "M8 2v12",
  eihwaz: "M8 2v12M8 2l3.5 3M8 14l-3.5-3",
  berkano: "M5 2v12l5-3-5-3 5-3-5-3",
  ehwaz: "M4 14V2l4 4 4-4v12",
  mannaz: "M4 14V2M12 14V2M4 2l8 6M12 2L4 8",
  laguz: "M6 14V2l5 4",
  ingwaz: "M8 2l4.5 6L8 14 3.5 8z",
  dagaz: "M3 2v12M13 2v12M3 2l10 12M13 2L3 14",
} as const;

export type RuneName = keyof typeof glyphs;

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "square", strokeLinejoin: "miter" } as const;

/** One rune as an icon, the size of the other icons. */
export const Rune = ({ name, className = "" }: { name: RuneName; className?: string }) => (
  <svg aria-hidden="true" viewBox="0 0 16 16" {...stroke} className={`size-4 shrink-0 ${className}`}>
    <path d={glyphs[name]} />
  </svg>
);

/** The app's name in runes, ᚹᛖᚱᚦᚨᚾᛞᛁ: v as wunjo and ð as thurisaz, as the Younger Futhark wrote them. */
const verdandi: readonly RuneName[] = ["wunjo", "ehwaz", "raidho", "thurisaz", "ansuz", "naudiz", "dagaz", "isa"];

/** A line of runes, like an inscription on a stone: a word spelled `runes`, one 12-unit cell each. */
export const RuneText = ({ runes = verdandi, className = "" }: { runes?: readonly RuneName[]; className?: string }) => (
  <svg aria-hidden="true" viewBox={`0 0 ${runes.length * 12 + 2} 16`} {...stroke} className={`h-3.5 w-auto shrink-0 ${className}`}>
    {runes.map((rune, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: a word's letters never reorder.
      <path key={i} d={glyphs[rune]} transform={`translate(${i * 12 - 2} 0)`} />
    ))}
  </svg>
);

/**
 * Verdandi's mark: a black disc cut by dagaz, the rune of day, for the norn of the present. Decorative;
 * the link or heading it sits in carries the name.
 */
export const RuneMark = ({ className = "" }: { className?: string }) => (
  <svg aria-hidden="true" viewBox="0 0 32 32" className={`shrink-0 ${className}`}>
    <circle cx="16" cy="16" r="16" className="fill-fg" />
    <path d="M10 9v14M22 9v14M10 9l12 14M22 9L10 23" fill="none" className="stroke-panel" strokeWidth="2" strokeLinecap="square" />
  </svg>
);
