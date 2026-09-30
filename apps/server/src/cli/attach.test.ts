import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempHome, removeTempHome } from "@verdandi/testkit";
import { readAttachment } from "./attach.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempHome(d);
});

test("/attach takes a path with spaces, quoted or not, absolute or relative", () => {
  const dir = makeTempHome(); // its path has a space
  dirs.push(dir);
  mkdirSync(join(dir, "my shots"));
  const png = join(dir, "my shots", "broken ui.png");
  writeFileSync(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const expected = { name: "broken ui.png", mediaType: "image/png", data: "iVBORw==" };
  expect(readAttachment(png, "/elsewhere")).toEqual(expected);
  expect(readAttachment(`"${png}"`, "/elsewhere")).toEqual(expected);
  expect(readAttachment(" my shots/broken ui.png ", dir)).toEqual(expected);
  writeFileSync(join(dir, "build.log"), "line\r\n");
  expect(readAttachment("build.log", dir)).toMatchObject({ name: "build.log", mediaType: "text/plain" });
  expect(readAttachment("missing.png", dir)).toContain("doesn't exist");
  expect(readAttachment("my shots", dir)).toContain("is a folder");
  expect(readAttachment("", dir)).toContain("Name a file");
});
