/**
 * Shader transitions between two scenes:
 * `<div data-transition="ripple" data-from="intro" data-to="outro" data-start="intro - 0.4" data-duration="0.8">`.
 * A render captures each scene alone at every frame of the window and blends the two pictures with the shader on a
 * WebGL canvas over the composition. The preview can't read a page's pixels, so it crossfades the scenes instead.
 */
import type { Clips } from "./clips.ts";
import { prelude, type ShaderName, shaders } from "./shaders.ts";

export type ActiveTransition = { readonly shader: string; readonly from: string; readonly to: string; readonly progress: number };

/** Transitions whose window holds `t`, with how far along each is (0..1). */
export const transitionsAt = (clips: Clips, t: number): ActiveTransition[] =>
  [...document.querySelectorAll("[data-transition]")].flatMap((el) => {
    const start = clips.start(el);
    const end = clips.end(el);
    const from = el.getAttribute("data-from") ?? "";
    const to = el.getAttribute("data-to") ?? "";
    if (!(t >= start && t < end && Number.isFinite(end)) || el.closest("[data-hidden]")) return [];
    return [{ shader: el.getAttribute("data-transition") ?? "", from, to, progress: (t - start) / (end - start) }];
  });

const scene = (id: string) => document.getElementById(id) ?? document.querySelector(`[data-composition-id="${CSS.escape(id)}"]`);

/** Preview: the incoming scene fades in over the outgoing one; outside any window, each scene's own opacity returns. */
export const crossfade = (active: readonly ActiveTransition[]) => {
  for (const el of document.querySelectorAll<HTMLElement>("[data-vd-fading]")) {
    el.style.opacity = el.dataset.vdFading ?? "";
    delete el.dataset.vdFading;
  }
  for (const a of active) {
    const to = scene(a.to);
    if (!(to instanceof HTMLElement)) continue;
    to.dataset.vdFading = to.style.opacity;
    to.style.opacity = String(a.progress);
  }
};

/** Render: shows only one side of a transition while the other is hidden, for its picture to be captured. */
export const isolate = (hide: readonly string[]) => {
  for (const id of hide) {
    const el = scene(id);
    if (el instanceof HTMLElement) {
      el.dataset.vdIsolated = "";
      el.style.setProperty("visibility", "hidden", "important");
    }
  }
};

export const restore = () => {
  for (const el of document.querySelectorAll<HTMLElement>("[data-vd-isolated]")) {
    el.style.removeProperty("visibility");
    delete el.dataset.vdIsolated;
  }
};

let gl: WebGLRenderingContext | null = null;
let canvas: HTMLCanvasElement | null = null;
const programs = new Map<string, WebGLProgram>();

const compile = (context: WebGLRenderingContext, name: ShaderName) => {
  const cached = programs.get(name);
  if (cached) return cached;
  const make = (type: number, source: string) => {
    const s = context.createShader(type);
    if (!s) throw new Error("WebGL could not create a shader.");
    context.shaderSource(s, source);
    context.compileShader(s);
    if (!context.getShaderParameter(s, context.COMPILE_STATUS))
      throw new Error(`Shader ${name} failed to compile: ${context.getShaderInfoLog(s)}`);
    return s;
  };
  const program = context.createProgram();
  if (!program) throw new Error("WebGL could not create a program.");
  context.attachShader(
    program,
    make(
      context.VERTEX_SHADER,
      "attribute vec2 pos; varying vec2 vUv; void main() { vUv = pos * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }",
    ),
  );
  context.attachShader(
    program,
    make(context.FRAGMENT_SHADER, `${prelude}\n${shaders[name]}\nvoid main() { gl_FragColor = transition(vUv); }`),
  );
  context.linkProgram(program);
  if (!context.getProgramParameter(program, context.LINK_STATUS))
    throw new Error(`Shader ${name} failed to link: ${context.getProgramInfoLog(program)}`);
  programs.set(name, program);
  return program;
};

const texture = (context: WebGLRenderingContext, unit: number, image: HTMLImageElement) => {
  const tex = context.createTexture();
  context.activeTexture(context.TEXTURE0 + unit);
  context.bindTexture(context.TEXTURE_2D, tex);
  context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, true);
  context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, image);
  for (const [k, v] of [
    [context.TEXTURE_MIN_FILTER, context.LINEAR],
    [context.TEXTURE_MAG_FILTER, context.LINEAR],
    [context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE],
    [context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE],
  ] as const)
    context.texParameteri(context.TEXTURE_2D, k, v);
  return tex;
};

const load = async (src: string) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
};

/**
 * Render: draws `shader` at `progress` from the picture `from` to `to` (data URLs) on a canvas over the whole
 * composition, which covers the scenes until `clearComposite`.
 */
export const composite = async (root: HTMLElement, opts: { shader: string; from: string; to: string; progress: number }) => {
  if (!(opts.shader in shaders)) throw new Error(`Unknown shader "${opts.shader}".`);
  const [a, b] = await Promise.all([load(opts.from), load(opts.to)]);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.dataset.vdComposite = "";
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      zIndex: "2147483647",
      pointerEvents: "none",
    });
    gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL is unavailable in this browser, so shader transitions can't render.");
  }
  const context = gl as WebGLRenderingContext;
  root.append(canvas);
  canvas.width = a.width;
  canvas.height = a.height;
  context.viewport(0, 0, a.width, a.height);
  const program = compile(context, opts.shader as ShaderName);
  context.useProgram(program);
  const buffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), context.STATIC_DRAW);
  const pos = context.getAttribLocation(program, "pos");
  context.enableVertexAttribArray(pos);
  context.vertexAttribPointer(pos, 2, context.FLOAT, false, 0, 0);
  const textures = [texture(context, 0, a), texture(context, 1, b)];
  context.uniform1i(context.getUniformLocation(program, "fromTex"), 0);
  context.uniform1i(context.getUniformLocation(program, "toTex"), 1);
  context.uniform1f(context.getUniformLocation(program, "progress"), opts.progress);
  context.uniform1f(context.getUniformLocation(program, "ratio"), a.width / a.height);
  context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
  context.finish();
  for (const t of textures) context.deleteTexture(t);
  context.deleteBuffer(buffer);
  canvas.style.visibility = "visible";
};

export const clearComposite = () => {
  if (canvas) canvas.style.visibility = "hidden";
};
