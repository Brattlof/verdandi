import { type Catalog, Effort } from "@verdandi/contracts";

const efforts = Effort.literals;

/**
 * The models the native harness runs on the Anthropic API, metered at list price (cache writes at the 5-minute
 * TTL's 1.25× input). They join the router's catalog only while the harness runs; the built-in policy names none,
 * so a task reaches them through a pin or a project's `routing.yaml` (ADR 0022).
 */
export const nativeCatalog: Catalog = [
  {
    harness: "native",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    access: "metered",
    tier: "S",
    context: 200_000,
    vision: true,
    // Haiku 4.5 takes neither effort nor adaptive thinking: requests to it leave both out.
    efforts: [],
    price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
  {
    harness: "native",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    access: "metered",
    tier: "M",
    context: 1_000_000,
    vision: true,
    efforts,
    price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
  {
    harness: "native",
    provider: "anthropic",
    model: "claude-opus-5-5",
    access: "metered",
    tier: "L",
    context: 1_000_000,
    vision: true,
    efforts,
    price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
  {
    harness: "native",
    provider: "anthropic",
    model: "claude-fable-5-1",
    access: "metered",
    tier: "XL",
    context: 1_000_000,
    vision: true,
    efforts,
    price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  },
];
