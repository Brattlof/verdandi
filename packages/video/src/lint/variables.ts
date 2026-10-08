/** Composition variable declarations: `data-composition-variables`, a JSON array of `{ id, type, label, default }`. */

export const variableTypes = ["string", "number", "color", "boolean", "enum", "image"] as const;

/** Why a declaration list is invalid, phrased to follow "data-composition-variables", or `undefined` when it's fine. */
export const declaredVariablesProblem = (raw: string): string | undefined => {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return "isn't valid JSON";
  }
  if (!Array.isArray(list)) return "must be a JSON array of declarations";
  for (const [i, d] of list.entries()) {
    if (!d || typeof d !== "object") return `entry ${i} isn't an object`;
    const { id, type, label, options } = d as Record<string, unknown>;
    if (typeof id !== "string" || !id) return `entry ${i} has no "id"`;
    if (typeof label !== "string") return `"${id}" has no "label"`;
    if (!(variableTypes as readonly unknown[]).includes(type))
      return `"${id}" has type ${JSON.stringify(type)}, not one of ${variableTypes.join(", ")}`;
    if (!("default" in d)) return `"${id}" has no "default"`;
    if (type === "enum" && !(Array.isArray(options) && options.length)) return `"${id}" is an enum without "options"`;
  }
  return undefined;
};
