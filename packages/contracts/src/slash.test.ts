import { expect, test } from "bun:test";
import { commonStart, parseSlash, slashCompletions } from "./slash.ts";

test("a line names a command only on a surface that offers it; anything else stays a message", () => {
  expect(parseSlash("  /revert 2 files ", "chat")).toEqual({ name: "revert", args: ["2", "files"] });
  expect(parseSlash("/exit", "web")).toBeUndefined();
  expect(parseSlash("/compact", "chat")).toBeUndefined();
  expect(parseSlash("/constructor", "chat")).toBeUndefined();
  expect(parseSlash("fix /revert", "chat")).toBeUndefined();
});

test("completion offers the surface's commands, then the choices of the argument being typed", () => {
  const chat = slashCompletions("/r", "chat").map((o) => o.line);
  expect(chat).toContain("/revert ");
  expect(chat.every((line) => line.startsWith("/r"))).toBe(true);
  // /revert isn't a web command: the web reverts from a turn's own button.
  expect(slashCompletions("/r", "web").map((o) => o.line)).not.toContain("/revert ");
  expect(slashCompletions("/revert 2 f", "chat").map((o) => o.line)).toEqual(["/revert 2 files"]);
  expect(slashCompletions("/rate up ", "chat")).toEqual([]);
  expect(slashCompletions("hello", "chat")).toEqual([]);
  // Tab completes only as far as the options agree.
  expect(commonStart(["/rate ", "/revert "])).toBe("/r");
});
