import { expect, test } from "bun:test";
import { nativeCatalog } from "@verdandi/harness-native";
import { builtInCatalog } from "@verdandi/router";

test("Claude Code's models and the native harness's are priced alike: both are Anthropic's list price", () => {
  const claudeCode = builtInCatalog.filter((e) => e.harness === "claude-code");
  // Claude Code names a model by its alias (`opus`), the API by its id (`claude-opus-5-5`).
  const pairs = claudeCode.map((alias) => [alias, nativeCatalog.filter((n) => n.model.includes(alias.model))] as const);
  for (const [alias, natives] of pairs) {
    expect({ alias: alias.model, natives: natives.length }).toEqual({ alias: alias.model, natives: 1 });
    expect({ model: alias.model, price: alias.price }).toEqual({ model: alias.model, price: natives[0]?.price ?? alias.price });
  }
  expect(pairs.flatMap(([, natives]) => natives.map((n) => n.model)).toSorted()).toEqual(nativeCatalog.map((n) => n.model).toSorted());
});
