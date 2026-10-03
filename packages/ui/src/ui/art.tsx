import { useId } from "react";

/*
 * The UI's Norse imagery. The raven and the longship are game-icons.net silhouettes, by Lorc ("raven") and
 * Delapouite ("drakkar"), CC BY 3.0; the engraving is Ludwig Burger's, from 1882, in the public domain. The
 * projects page credits them; keep that credit if any of them stays. The rest is drawn here.
 */

const silhouette =
  (d: string) =>
  ({ className = "" }: { className?: string }) => (
    <svg aria-hidden="true" viewBox="0 0 512 512" className={`shrink-0 fill-current ${className}`}>
      <path d={d} />
    </svg>
  );

/** Muninn, Odin's raven of memory. */
export const Raven = silhouette(
  "M343.313 22.22c-57.33 0-61.26 36.153-91.125 54.874C154.782 42.52 133.115 221.496 169.844 330c-15.396 31.924-30.736 75.9-43.813 134.906 56.828 30.66 119.124 38.655 182.22 9.906-6.2-37.715-14.18-68.858-21.97-95.375 25.025-12.63 59.594-14.573 86.5 14.407.24-28.626-19.022-40.956-40.53-42.25l-22.03-47.313c42.606-45.056 74.38-100.18 57.905-157.06-10.303-38.45 58.203-62.225 122.344-53.75-24.523-21.164-55.99-30.482-85.845-33.876-8.843-21.763-32.616-37.375-61.313-37.375zm10.968 21.936c9.808 0 17.783 7.944 17.783 17.75 0 9.807-7.974 17.75-17.782 17.75-9.807 0-17.75-7.943-17.75-17.75 0-9.806 7.945-17.75 17.75-17.75zm-58.092 274.25l16.28 34.938c-11.62 2.698-22.325 8.217-29.312 15.687-3.298-10.84-6.498-20.903-9.47-30.28 7.58-6.45 15.128-13.253 22.502-20.344z",
);

/** A longship under sail. */
export const Longship = silhouette(
  "M248.672 23.266l-64 32 61.566 15.39V87h19.524V23.266h-17.09zM146.334 105c13.692 21.145 20.243 47.388 20.164 73.742-.08 26.744-6.98 53.69-20.805 75.793h234.23c16.93-18.827 26.41-46.276 26.677-74.15.267-27.947-8.674-55.727-26.647-75.385h-233.62zM416 155.244L441 231h62v-14h-39v-18h39v-1.438l-32-16v-15.076l-55-11.242zm-371.492 6.61c-6.67.12-13.668 2.495-18.922 7.833-9.12 9.27-9.382 21.518-7.256 29.637 2.126 8.12 6.344 13.905 6.344 13.905l14.652-10.46s-2.4-3.49-3.584-8.006c-1.183-4.518-1.444-8.27 2.672-12.452 1.932-1.962 4.236-2.685 7.53-2.43 3.293.257 7.228 1.863 10.148 4.263s4.68 5.353 5.068 8.025c.388 2.67-.034 5.552-3.86 9.822l-.06.065-.054.064c-19.097 22.143-25.463 40.51-25.323 78.704.14 38.193.465 69.313 40.77 97.133l-56.87 48.746 11.714 13.666 61.35-52.585c2.307 1.25 4.674 2.5 7.173 3.75 7.86.786 15.04 1.502 22.164 2.21l-38.45 32.958 11.714 13.666 51.55-44.186c11.823 1.147 22.805 2.183 32.77 3.06l-32.035 27.46 11.715 13.665 45.582-39.07c12.314.895 23.462 1.514 34.158 1.87l-27.455 23.533 11.715 13.666 43.027-36.882c12.13-.13 24.454-.622 38.07-1.482l-28.812 24.697 11.715 13.666 47.427-40.653c12.838-1.1 27.384-2.48 43.473-4.053l-37.316 30.943 11.49 13.858 57.848-47.967c3.278-.327 6.228-.62 9.65-.963 50.065-50.065 60.964-100.13 63.338-142.535H441.68c-13.08 22.76-22.973 42.718-48.78 57.828 3.594 6.09 5.67 13.167 5.67 20.707 0 22.537-18.463 41-41 41-12.906 0-24.468-6.062-32-15.47-7.53 9.408-19.094 15.47-32 15.47-12.906 0-24.468-6.062-32-15.47-7.53 9.408-19.094 15.47-32 15.47-14.623 0-27.523-7.777-34.785-19.392-7.262 11.615-20.162 19.392-34.785 19.392-22.537 0-41-18.463-41-41 0-.17.012-.338.014-.508-29.774-3.39-49.577-21.213-64.58-42.46-5.57-7.888-4.7-17.596-4.704-25.907-.005-11.62 3.798-24.738 21.084-44.78l-.113.128c6.645-7.412 9.443-16.39 8.275-24.428-1.17-8.04-5.742-14.646-11.455-19.342-5.714-4.695-12.713-7.72-20.18-8.3-.934-.073-1.88-.102-2.832-.084zm201.73 110.68v17.59c6.004 2.7 11.26 6.794 15.332 11.88 1.282-1.6 2.69-3.096 4.192-4.49v-24.98h-19.524zm-86.238 32c-12.81 0-23 10.192-23 23 0 12.81 10.19 23 23 23s23-10.19 23-23c0-12.808-10.19-23-23-23zm69.57 0c-12.81 0-23 10.192-23 23 0 12.81 10.19 23 23 23s23-10.19 23-23c0-12.808-10.19-23-23-23zm64 0c-12.81 0-23 10.192-23 23 0 12.81 10.19 23 23 23s23-10.19 23-23c0-12.808-10.19-23-23-23zm64 0c-12.81 0-23 10.192-23 23 0 12.81 10.19 23 23 23s23-10.19 23-23c0-12.808-10.19-23-23-23z",
);

/**
 * Ludwig Burger's engraving of the three norns, Urðr, Verðandi and Skuld, beneath Yggdrasil (1882). Black ink
 * on paper: the paper takes the page's colour, and in dark mode the ink turns light.
 */
export const Engraving = ({ className = "" }: { className?: string }) => (
  <figure className={className}>
    <div
      role="img"
      aria-label="The three norns sitting beneath the world tree, an eagle in its branches"
      className="engraving aspect-[632/768] w-full"
    />
    <figcaption className="mt-2 text-xs text-muted">Urðr, Verðandi and Skuld beneath Yggdrasil. Ludwig Burger, 1882.</figcaption>
  </figure>
);

/**
 * A two-strand plait, the simplest Norse interlace, as a rule across its container: two ribbons, each with
 * an edge line, crossing over then under each other. `surface` is the colour behind the rule; it draws the
 * ribbons' insides and the gap where one passes over the other.
 */
export const Plait = ({ surface = "stroke-bg", className = "" }: { surface?: string; className?: string }) => {
  const id = useId();
  // Each half of a 32-unit tile: the strand rising under, then the strand falling over it.
  const rising = ["M0 13c5 0 11-10 16-10", "M16 13c5 0 11-10 16-10"];
  const falling = ["M0 3c5 0 11 10 16 10", "M16 3c5 0 11 10 16 10"];
  return (
    <svg aria-hidden="true" className={`block h-4 w-full ${className}`}>
      <defs>
        <pattern id={id} width="32" height="16" patternUnits="userSpaceOnUse">
          <g fill="none">
            {[0, 1].map((half) => (
              <g key={half}>
                <path d={rising[half]} stroke="currentColor" strokeWidth="4.5" />
                <path d={rising[half]} className={surface} strokeWidth="1.5" />
                <path d={falling[half]} className={surface} strokeWidth="8" />
                <path d={falling[half]} stroke="currentColor" strokeWidth="4.5" />
                <path d={falling[half]} className={surface} strokeWidth="1.5" />
              </g>
            ))}
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="16" fill={`url(#${id})`} />
    </svg>
  );
};

/**
 * A stave in the manner of the Vegvísir: eight arms from a ring, each crossed and ending in a knot. Drawn
 * once, faint, and never moves.
 */
export const Stave = ({ className = "" }: { className?: string }) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 200 200"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    className={className}
  >
    <circle cx="100" cy="100" r="14" />
    {[0, 45, 90, 135, 180, 225, 270, 315].map((angle, i) => (
      <g key={angle} transform={`rotate(${angle} 100 100)`}>
        <path d="M100 86V16" />
        {i % 2 === 0 ? <path d="M88 40l12-10 12 10M90 58h20" /> : <path d="M90 34h20M92 52l8 8 8-8" />}
        <circle cx="100" cy="12" r="5" />
      </g>
    ))}
  </svg>
);
