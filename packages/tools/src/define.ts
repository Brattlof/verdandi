import type { HandedSource, HarnessTool, ThreadId, ToolParam, TurnId } from "@verdandi/contracts";
import { Cause, Data, Effect } from "effect";

/** A tool call that can't be done; the message tells the agent why and what to do instead. */
export class ToolFailed extends Data.TaggedError("ToolFailed")<{ readonly message: string }> {}

type Value<P extends ToolParam> = P["type"] extends "string" ? string : P["type"] extends "number" ? number : boolean;
export type Args<Ps extends Record<string, ToolParam>> = {
  readonly [K in keyof Ps]: Ps[K]["optional"] extends true ? Value<Ps[K]> | undefined : Value<Ps[K]>;
};
export type ToolAt = { readonly threadId: ThreadId; readonly turnId: TurnId };
/**
 * Scans a tool result built from untrusted text before it reaches the agent (DESIGN §17). Returns the text to hand
 * over: under a warning when the scan flags it, which verdandid also records on the turn.
 */
export type Screen = (source: HandedSource, text: string, at: ToolAt) => Effect.Effect<string>;

/** Why `args` don't fit `params`, or undefined when they do. Arguments it doesn't name are ignored. */
const misfit = (params: Readonly<Record<string, ToolParam>>, args: Readonly<Record<string, unknown>>) => {
  for (const [name, param] of Object.entries(params)) {
    const value = args[name];
    if (value === undefined || value === null) {
      if (!param.optional) return `\`${name}\` is required: ${param.description}`;
    } else if (typeof value !== param.type) return `\`${name}\` must be a ${param.type}, not ${JSON.stringify(value)}.`;
  }
  return undefined;
};

/**
 * One Verdandi tool, defined once for every harness (DESIGN §9.6): its parameters, and what it does over
 * verdandid's services. Arguments are checked before `run` sees them; a `ToolFailed` or any other failure
 * comes back to the agent as an error result, never as a thrown error.
 */
export const defineTool = <const Ps extends Record<string, ToolParam>>(spec: {
  readonly name: string;
  readonly description: string;
  readonly params: Ps;
  readonly ask?: boolean;
  readonly run: (args: Args<Ps>, at: ToolAt) => Effect.Effect<string, ToolFailed>;
}): HarnessTool => ({
  name: spec.name,
  description: spec.description,
  params: spec.params,
  ...(spec.ask && { ask: true }),
  call: (args, at) => {
    const wrong = misfit(spec.params, args);
    if (wrong) return Promise.resolve({ text: wrong, isError: true });
    return Effect.runPromise(
      spec.run(args as Args<Ps>, at).pipe(
        Effect.map((text) => ({ text })),
        Effect.catchCause((cause) => {
          const failed = Cause.findErrorOption(cause);
          const text =
            failed._tag === "Some" && failed.value instanceof ToolFailed
              ? failed.value.message
              : `Verdandi's ${spec.name} tool failed inside verdandid. Carry on without it; the user can check verdandid's log.`;
          return Effect.succeed({ text, isError: true });
        }),
      ),
    );
  },
});
