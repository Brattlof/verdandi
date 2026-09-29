import { Schema } from "effect";
import { Item, UsageFields } from "./items.ts";

/** What every harness adapter reports, normalized. */
export const HarnessEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session.started"), sessionId: Schema.String, harnessVersion: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text.delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("item"), item: Item }),
  Schema.Struct({ type: Schema.Literal("usage"), ...UsageFields }),
  Schema.Struct({
    type: Schema.Literal("turn.finished"),
    status: Schema.Literals(["success", "error"]),
    error: Schema.optionalKey(Schema.String),
  }),
]);
export type HarnessEvent = typeof HarnessEvent.Type;
