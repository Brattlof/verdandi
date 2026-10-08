/**
 * Source lint: the composition contract's rules checked on one file's text, without a browser. Each finding names
 * the cause and the fix. `check` adds the rules only a running page can answer.
 */

import { ancestors, codeOnly, type ParsedFile, type Tag } from "./parse.ts";
import { declaredVariablesProblem } from "./variables.ts";

export type Severity = "error" | "warning" | "info";
export type Finding = {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly file: string;
  readonly line?: number;
  readonly fix?: string;
};

export type FileContext = {
  readonly file: string;
  readonly parsed: ParsedFile;
  /** The project's root page (`index.html`), as opposed to a sub-composition file. */
  readonly isRoot: boolean;
  /** Whether a path relative to this file exists in the project. */
  readonly exists: (relativePath: string) => boolean;
};

type Rule = (ctx: FileContext, report: (f: Omit<Finding, "file">) => void) => void;

const attr = (t: Tag, name: string) => t.attrs.get(name);
const has = (t: Tag, name: string) => t.attrs.has(name);
const where = (t: Tag) => (attr(t, "id") ? `<${t.name} id="${attr(t, "id")}">` : `<${t.name}>`);
const isMedia = (t: Tag) => t.name === "video" || t.name === "audio";

/** The composition root: the first element with `data-composition-id` that isn't a sub-composition host. */
const rootOf = (ctx: FileContext) => ctx.parsed.tags.find((t) => has(t, "data-composition-id") && !has(t, "data-composition-src"));

const scriptsCode = (ctx: FileContext) => ctx.parsed.scripts.filter((s) => !attr(ctx.parsed.tags[s.tag] as Tag, "src"));

const lineOf = (block: { line: number; text: string }, offset: number) =>
  block.line + (block.text.slice(0, offset).match(/\n/g)?.length ?? 0);

const rules: Record<string, Rule> = {
  root(ctx, report) {
    const root = rootOf(ctx);
    if (!root) {
      report({
        code: "root_missing_composition_id",
        severity: "error",
        message: "No element declares data-composition-id, so there is no composition to render.",
        fix: 'Give the root element data-composition-id="main" (and data-width, data-height, data-duration).',
      });
      return;
    }
    if (ctx.isRoot && (!has(root, "data-width") || !has(root, "data-height")))
      report({
        code: "root_missing_dimensions",
        severity: "error",
        line: root.line,
        message: `The root ${where(root)} has no data-width or data-height, so the canvas size is a guess (1920×1080).`,
        fix: 'Add data-width="1920" data-height="1080" (or the size you want) to the root.',
      });
    if (ctx.isRoot && /^\s*<template/i.test(ctx.parsed.source))
      report({
        code: "standalone_composition_wrapped_in_template",
        severity: "error",
        line: 1,
        message: "index.html wraps its root in <template>, so nothing on the page renders.",
        fix: "Only sub-composition files use <template>; put the root directly in <body>.",
      });
  },

  hosts(ctx, report) {
    const ids = new Map<string, Tag>();
    for (const t of ctx.parsed.tags) {
      const src = attr(t, "data-composition-src");
      if (src !== undefined) {
        if (!has(t, "data-composition-id"))
          report({
            code: "host_missing_composition_id",
            severity: "error",
            line: t.line,
            message: `${where(t)} mounts ${src} but has no data-composition-id.`,
            fix: "Give the host the same data-composition-id as the file's root.",
          });
        if (!/^(?:[a-z]+:|\/\/)/i.test(src) && !ctx.exists(src))
          report({
            code: "missing_sub_composition",
            severity: "error",
            line: t.line,
            message: `${where(t)} mounts ${src}, which doesn't exist.`,
            fix: "Fix the path (relative to this file), or create the composition.",
          });
        continue;
      }
      const id = attr(t, "data-composition-id");
      if (!id) continue;
      if (ids.has(id))
        report({
          code: "duplicate_composition_id",
          severity: "error",
          line: t.line,
          message: `data-composition-id="${id}" is declared twice in this file.`,
          fix: "Give each composition in a file its own id; to show one twice, mount its file twice.",
        });
      ids.set(id, t);
    }
  },

  timing(ctx, report) {
    for (const t of ctx.parsed.tags) {
      if (has(t, "data-layer"))
        report({
          code: "deprecated_data_layer",
          severity: "warning",
          line: t.line,
          message: `${where(t)} uses data-layer, an old name.`,
          fix: "Rename it to data-track-index.",
        });
      for (const name of ["data-start", "data-duration"]) {
        const v = attr(t, name);
        if (v === undefined) continue;
        const bad =
          name === "data-duration"
            ? !(Number(v) > 0)
            : v.trim() === "" || (Number.isNaN(Number(v)) && !/^[A-Za-z0-9_.:-]+(?:\s*[+-]\s*\d+(?:\.\d+)?)?$/.test(v.trim()));
        if (bad)
          report({
            code: "invalid_timing",
            severity: "error",
            line: t.line,
            message: `${where(t)} has ${name}="${v}", which isn't ${name === "data-duration" ? "a positive number of seconds" : 'seconds or "<id> + n"'}.`,
            fix:
              name === "data-duration"
                ? 'Use seconds, e.g. data-duration="2.5".'
                : 'Use seconds (data-start="1.5") or follow another clip (data-start="intro + 0.5").',
          });
      }
    }
  },

  media(ctx, report) {
    const ids = new Map<string, Tag>();
    for (const t of ctx.parsed.tags) {
      if (!isMedia(t)) continue;
      const id = attr(t, "id");
      const src = attr(t, "src") ?? ctx.parsed.tags.find((c) => c.parent === t.index && c.name === "source")?.attrs.get("src");
      if (t.selfClosing)
        report({
          code: "self_closing_media_tag",
          severity: "error",
          line: t.line,
          message: `${where(t)} is written <${t.name} … />, which the browser leaves open, swallowing what follows.`,
          fix: `Close it: <${t.name} …></${t.name}>.`,
        });
      if (!has(t, "data-start"))
        report({
          code: "media_missing_data_start",
          severity: "error",
          line: t.line,
          message: `${where(t)} has no data-start, so it never plays.`,
          fix: 'Add data-start (seconds), e.g. data-start="0".',
        });
      if (!id)
        report({
          code: "media_missing_id",
          severity: "error",
          line: t.line,
          message: `<${t.name}${src ? ` src="${src}"` : ""}> has no id; renders and the Studio need one to address it.`,
          fix: 'Add a unique id, e.g. id="voiceover".',
        });
      else if (ids.has(id))
        report({
          code: "duplicate_media_id",
          severity: "error",
          line: t.line,
          message: `Two media elements share id="${id}".`,
          fix: "Give each <video> and <audio> its own id.",
        });
      if (id) ids.set(id, t);
      if (!src)
        report({
          code: "media_missing_src",
          severity: "error",
          line: t.line,
          message: `${where(t)} has no src and no <source>.`,
          fix: "Point src at a file in the project, e.g. assets/clip.mp4.",
        });
      else if (src.startsWith("data:"))
        report({
          code: "base64_media_prohibited",
          severity: "error",
          line: t.line,
          message: `${where(t)} embeds its media as a data: URL.`,
          fix: "Save the media into assets/ and reference the file.",
        });
      else if (!/^(?:[a-z]+:|\/\/)/i.test(src) && !ctx.exists(src))
        report({
          code: "missing_local_asset",
          severity: "error",
          line: t.line,
          message: `${where(t)} plays ${src}, which doesn't exist.`,
          fix: "Fix the path (relative to this file), or add the file.",
        });
      if (attr(t, "preload") === "none")
        report({
          code: "media_preload_none",
          severity: "warning",
          line: t.line,
          message: `${where(t)} has preload="none", which delays knowing its length.`,
          fix: 'Remove preload, or use preload="auto".',
        });
      if (t.name === "video") {
        const muted = has(t, "muted");
        const declared = attr(t, "data-has-audio");
        if (!muted && declared === undefined)
          report({
            code: "video_missing_muted",
            severity: "error",
            line: t.line,
            message: `${where(t)} says neither muted nor data-has-audio, so whether its sound belongs in the mix is a guess.`,
            fix: 'Add muted for picture only, or data-has-audio="true" to keep its sound.',
          });
        if (muted && declared === "true")
          report({
            code: "video_muted_with_declared_audio",
            severity: "error",
            line: t.line,
            message: `${where(t)} is muted but declares data-has-audio="true".`,
            fix: "Remove one: muted (picture only) or data-has-audio (keep the sound).",
          });
        const timedParent = ancestors(ctx.parsed, t).find((a) => has(a, "data-start") && !has(a, "data-composition-id"));
        if (has(t, "data-start") && timedParent)
          report({
            code: "video_nested_in_timed_element",
            severity: "error",
            line: t.line,
            message: `${where(t)} has data-start inside ${where(timedParent)}, which is also timed, so the two windows fight.`,
            fix: "Time the wrapper or the video, not both.",
          });
      }
    }
  },

  images(ctx, report) {
    for (const t of ctx.parsed.tags) {
      const src =
        t.name === "img" || t.name === "source"
          ? attr(t, "src")
          : t.name === "link" && attr(t, "rel") === "stylesheet"
            ? attr(t, "href")
            : undefined;
      if (src && !/^(?:[a-z]+:|\/\/|#)/i.test(src) && !ctx.exists(src))
        report({
          code: "missing_local_asset",
          severity: "error",
          line: t.line,
          message: `${where(t)} references ${src}, which doesn't exist.`,
          fix: "Fix the path (relative to this file), or add the file.",
        });
    }
    for (const t of ctx.parsed.tags) {
      if (t.name !== "script") continue;
      const src = attr(t, "src");
      if (src && !/^(?:[a-z]+:|\/\/)/i.test(src) && !ctx.exists(src))
        report({
          code: "missing_local_asset",
          severity: "error",
          line: t.line,
          message: `<script src="${src}"> doesn't exist.`,
          fix: "Fix the path, or run verdandi video init to get vendor/gsap.min.js.",
        });
      if (src && /^https?:/i.test(src))
        report({
          code: "remote_script",
          severity: "warning",
          line: t.line,
          message: `<script src="${src}"> loads from the network, so a render offline fails.`,
          fix: "Save the library into vendor/ and load it from there.",
        });
    }
  },

  scripts(ctx, report) {
    const compIds = new Set(ctx.parsed.tags.flatMap((t) => attr(t, "data-composition-id") ?? []));
    const usesGsap = scriptsCode(ctx).some((s) => /\bgsap\s*\./.test(codeOnly(s.text)));
    const loadsGsap = ctx.parsed.tags.some((t) => t.name === "script" && /gsap/i.test(attr(t, "src") ?? ""));
    if (ctx.isRoot && usesGsap && !loadsGsap)
      report({
        code: "missing_gsap_script",
        severity: "error",
        message: "Scripts use gsap, but no <script src> loads it.",
        fix: 'Add <script src="vendor/gsap.min.js"></script> in <head>.',
      });
    for (const block of scriptsCode(ctx)) {
      const tag = ctx.parsed.tags[block.tag];
      if (tag && attr(tag, "type") && !/javascript|module/.test(attr(tag, "type") ?? "")) continue;
      try {
        new Bun.Transpiler({ loader: "js" }).transformSync(block.text);
      } catch (error) {
        report({
          code: "invalid_inline_script_syntax",
          severity: "error",
          line: block.line,
          message: `A script doesn't parse: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}.`,
          fix: "Fix the syntax error; the composition's timeline never registers otherwise.",
        });
        continue;
      }
      const code = codeOnly(block.text);
      const banned: [RegExp, string][] = [
        [/\bMath\.random\s*\(/, "Math.random()"],
        [/\bDate\.now\s*\(/, "Date.now()"],
        [/\bnew\s+Date\s*\(\s*\)/, "new Date()"],
        [/\bperformance\.now\s*\(/, "performance.now()"],
        [/\bcrypto\.getRandomValues\s*\(/, "crypto.getRandomValues()"],
        [/\bgsap\.utils\.random\s*\(/, "gsap.utils.random()"],
      ];
      for (const [re, name] of banned) {
        const m = re.exec(code);
        if (m)
          report({
            code: "non_deterministic_code",
            severity: "error",
            line: lineOf(block, m.index),
            message: `${name} gives a different value on every render, so frames don't repeat.`,
            fix: "Use a seeded generator (e.g. mulberry32 with a constant seed) or a fixed value.",
          });
      }
      if (/["']random\(/.test(block.text))
        report({
          code: "non_deterministic_code",
          severity: "error",
          line: block.line,
          message: 'A GSAP "random(…)" value differs on every render.',
          fix: "Precompute the values with a seeded generator.",
        });
      const raf = /\brequestAnimationFrame\s*\(/.exec(code);
      if (raf)
        report({
          code: "requestanimationframe_in_composition",
          severity: "error",
          line: lineOf(block, raf.index),
          message: "requestAnimationFrame runs on the wall clock, not the composition's time.",
          fix: "Animate on the timeline, or listen for the vd-seek event and draw detail.time.",
        });
      const control = /\.\s*(play|pause)\s*\(\s*\)|\.currentTime\s*=(?!=)/.exec(code);
      if (control && /video|audio|media|querySelector|getElementById/.test(code))
        report({
          code: "imperative_media_control",
          severity: "error",
          line: lineOf(block, control.index),
          message: "A script plays, pauses or seeks media; the runtime owns <video> and <audio> playback.",
          fix: "Remove it: set data-start, data-duration and data-playback-start instead.",
        });
      const tlPlay = /\btl\s*\.\s*play\s*\(/.exec(code);
      if (tlPlay)
        report({
          code: "timeline_played",
          severity: "error",
          line: lineOf(block, tlPlay.index),
          message: "A timeline is played; the runtime seeks timelines frame by frame.",
          fix: "Create it with gsap.timeline({ paused: true }) and never call play().",
        });
      if (/\bgsap\s*\.\s*timeline\s*\(/.test(code) && !/__timelines\s*(?:\[|\.)/.test(code))
        report({
          code: "gsap_timeline_not_registered",
          severity: "error",
          line: block.line,
          message: "A script builds a GSAP timeline but never registers it, so it never moves.",
          fix: 'Add window.__timelines["<composition id>"] = tl once it is built.',
        });
      for (const m of block.text.matchAll(/__timelines\s*(?:\[\s*["'`]([^"'`]+)["'`]\s*\]|\.([A-Za-z_$][\w$]*))\s*=(?!=)/g)) {
        const key = m[1] ?? m[2] ?? "";
        if (!compIds.has(key))
          report({
            code: "timeline_id_mismatch",
            severity: "error",
            line: lineOf(block, m.index),
            message: `A timeline is registered as "${key}", but no composition in this file has that id.`,
            fix: `Register it under the composition's data-composition-id (${[...compIds].join(", ") || "none declared"}).`,
          });
      }
      if (/\brepeat\s*:\s*-1\b/.test(code)) {
        const root = rootOf(ctx);
        const finite = root && Number(attr(root, "data-duration")) > 0;
        report({
          code: "gsap_infinite_repeat",
          severity: finite ? "warning" : "error",
          line: block.line,
          message: finite
            ? "A tween repeats forever; it is cut at the root's data-duration."
            : "A tween repeats forever and the root has no data-duration, so the video has no end.",
          fix: "Use a finite repeat count, or set data-duration on the root.",
        });
      }
    }
  },

  styles(ctx, report) {
    for (const block of ctx.parsed.styles) {
      const css = block.text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
      for (const m of css.matchAll(/(?:^|[;{\s])transition(?:-duration)?\s*:\s*([^;}]+)/g)) {
        const value = m[1]?.trim() ?? "";
        if (value === "none" || /^(?:0m?s\s*,?\s*)+$/.test(value) || !/\d/.test(value)) continue;
        report({
          code: "css_transition_used",
          severity: "warning",
          line: lineOf(block, m.index),
          message: `A CSS transition (${value}) runs on the wall clock, so renders miss it.`,
          fix: "Animate the change on the timeline instead.",
        });
      }
      if (/@import\s+url\(\s*["']?https?:/i.test(css))
        report({
          code: "remote_stylesheet",
          severity: "warning",
          line: block.line,
          message: "A stylesheet @imports from the network, so a render offline fails.",
          fix: "Save the stylesheet (and its fonts) into the project.",
        });
    }
  },

  variables(ctx, report) {
    for (const t of ctx.parsed.tags) {
      const decl = attr(t, "data-composition-variables");
      if (decl !== undefined) {
        const problem = declaredVariablesProblem(decl);
        if (problem)
          report({
            code: "invalid_composition_variables_declaration",
            severity: "error",
            line: t.line,
            message: `data-composition-variables ${problem}.`,
            fix: 'Declare a JSON array: [{"id":"title","type":"string","label":"Title","default":"Hello"}].',
          });
      }
      const values = attr(t, "data-variable-values");
      if (values !== undefined) {
        let ok = false;
        try {
          const v = JSON.parse(values);
          ok = !!v && typeof v === "object" && !Array.isArray(v);
        } catch {}
        if (!ok)
          report({
            code: "invalid_variable_values_json",
            severity: "error",
            line: t.line,
            message: `${where(t)} has data-variable-values that isn't a JSON object.`,
            fix: `Use an object, e.g. data-variable-values='{"title":"Hello"}'.`,
          });
      }
    }
  },
};

/** Every source rule over one file, in a stable order. */
export const lintFile = (ctx: FileContext): Finding[] => {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const rule of Object.values(rules))
    rule(ctx, (f) => {
      const key = `${f.code}|${f.line ?? ""}|${f.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ...f, file: ctx.file });
    });
  return out;
};
