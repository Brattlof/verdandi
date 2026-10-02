import { type Catalog, type DatedCatalogEntry, type DatedPrice, decodeDatedCatalog, type Price } from "@verdandi/contracts";
import catalogData from "./catalog.json";

/** The bundled model catalog with every list price each model has had (DESIGN §8.6). */
export const datedCatalog: readonly DatedCatalogEntry[] = decodeDatedCatalog(catalogData);
for (const e of datedCatalog) {
  const days = e.prices.map((p) => p.since);
  if (days.some((d, i) => i > 0 && d <= (days[i - 1] ?? "")))
    throw new Error(`catalog.json: ${e.harness} ${e.model}'s prices must be oldest first, one per day; found ${days.join(", ")}.`);
}

const strip = ({ since: _, ...price }: DatedPrice): Price => price;

/**
 * The price of `prices` in effect at `at`, an ISO date or timestamp read as UTC: the latest that took effect on or
 * before its day, or the oldest for a time before any. Without `at`, the latest, which the router routes on.
 */
export const priceOn = (prices: DatedCatalogEntry["prices"], at?: string): Price => {
  const day = at?.slice(0, 10);
  const price = day === undefined ? prices.at(-1) : prices.findLast((p) => p.since <= day);
  return strip(price ?? prices[0]);
};

/** The bundled model catalog at its latest prices. */
export const builtInCatalog: Catalog = datedCatalog.map(({ prices, ...e }) => ({ ...e, price: priceOn(prices) }));
