import { type Catalog, Effort } from "@verdandi/contracts";

const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const efforts = Effort.literals;

/**
 * Catalog entries for the fake harness, one model per tier, so a routing policy can route to it in
 * tests and under `verdandi start --dev-fake-harness`. They cost nothing, so ties go to the earlier target, and
 * take every effort level.
 */
export const fakeCatalog: Catalog = [
  {
    harness: "fake",
    provider: "fake",
    model: "fake-small",
    access: "local",
    tier: "S",
    context: 200_000,
    vision: false,
    efforts,
    price: free,
  },
  { harness: "fake", provider: "fake", model: "fake", access: "local", tier: "M", context: 1_000_000, vision: true, efforts, price: free },
  {
    harness: "fake",
    provider: "fake",
    model: "fake-large",
    access: "local",
    tier: "L",
    context: 1_000_000,
    vision: true,
    efforts,
    price: free,
  },
];
