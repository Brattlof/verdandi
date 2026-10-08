/**
 * Shader transitions: each blends the outgoing scene (`getFrom`) into the incoming one (`getTo`) as `progress` runs from
 * 0 to 1, with `vec4 transition(vec2 uv)`. They share `prelude` (uniforms, sampling and value noise). `uv` is 0..1 with
 * (0, 0) at the bottom left; `ratio` is width / height.
 */

export const prelude = `
precision highp float;
uniform sampler2D fromTex;
uniform sampler2D toTex;
uniform float progress;
uniform float ratio;
varying vec2 vUv;
vec4 getFrom(vec2 uv) { return texture2D(fromTex, clamp(uv, 0.0, 1.0)); }
vec4 getTo(vec2 uv) { return texture2D(toTex, clamp(uv, 0.0, 1.0)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
  return v;
}
`;

/** Each shader's body: it defines `vec4 transition(vec2 uv)`. */
export const shaders = {
  /** A soft noise threshold eats the old scene away. */
  dissolve: `vec4 transition(vec2 uv) {
    float n = fbm(uv * vec2(ratio, 1.0) * 6.0);
    float edge = progress * 1.2 - 0.1;
    return mix(getFrom(uv), getTo(uv), smoothstep(edge + 0.08, edge - 0.08, n));
  }`,
  /** Rings ripple out from the centre while the scenes cross. */
  ripple: `vec4 transition(vec2 uv) {
    vec2 d = (uv - 0.5) * vec2(ratio, 1.0);
    float dist = length(d);
    float strength = sin(progress * 3.14159) * 0.035;
    vec2 offset = dist > 0.0 ? (d / dist) * sin(dist * 42.0 - progress * 18.0) * strength : vec2(0.0);
    vec2 p = uv + offset / vec2(ratio, 1.0);
    return mix(getFrom(p), getTo(p), smoothstep(0.25, 0.75, progress));
  }`,
  /** The picture twists into a vortex and unwinds as the new one. */
  swirl: `vec4 transition(vec2 uv) {
    vec2 c = (uv - 0.5) * vec2(ratio, 1.0);
    float r = length(c);
    float turn = sin(progress * 3.14159) * 4.0 * max(0.0, 1.0 - r * 1.4);
    float s = sin(turn), co = cos(turn);
    vec2 p = vec2(c.x * co - c.y * s, c.x * s + c.y * co) / vec2(ratio, 1.0) + 0.5;
    return mix(getFrom(p), getTo(p), smoothstep(0.3, 0.7, progress));
  }`,
  /** A radial blur rushes into the centre, then out into the new scene. */
  "zoom-blur": `vec4 transition(vec2 uv) {
    float s = sin(progress * 3.14159) * 0.35;
    vec4 a = vec4(0.0), b = vec4(0.0);
    for (int i = 0; i < 16; i++) {
      float k = float(i) / 15.0;
      vec2 p = 0.5 + (uv - 0.5) * (1.0 - s * k);
      a += getFrom(p); b += getTo(p);
    }
    return mix(a / 16.0, b / 16.0, smoothstep(0.35, 0.65, progress));
  }`,
  /** Red, green and blue pull apart sideways and snap back on the new scene. */
  "chromatic-split": `vec4 transition(vec2 uv) {
    float s = sin(progress * 3.14159) * 0.04;
    float m = smoothstep(0.4, 0.6, progress);
    vec4 r = mix(getFrom(uv + vec2(s, 0.0)), getTo(uv + vec2(s, 0.0)), m);
    vec4 g = mix(getFrom(uv), getTo(uv), m);
    vec4 b = mix(getFrom(uv - vec2(s, 0.0)), getTo(uv - vec2(s, 0.0)), m);
    return vec4(r.r, g.g, b.b, 1.0);
  }`,
  /** Horizontal slices jump and tear; each slice cuts over at its own moment. */
  glitch: `vec4 transition(vec2 uv) {
    float row = floor(uv.y * 28.0);
    float step = floor(progress * 12.0);
    float shift = (hash(vec2(row, step)) - 0.5) * 0.12 * sin(progress * 3.14159);
    vec2 p = vec2(uv.x + shift, uv.y);
    float cut = hash(vec2(row, 7.0));
    return progress > cut * 0.8 + 0.1 ? getTo(p) : getFrom(p);
  }`,
  /** A circle opens from the centre onto the new scene. */
  iris: `vec4 transition(vec2 uv) {
    float d = length((uv - 0.5) * vec2(ratio, 1.0));
    float radius = progress * (0.5 * sqrt(ratio * ratio + 1.0) + 0.02);
    return mix(getTo(uv), getFrom(uv), smoothstep(radius - 0.005, radius + 0.005, d));
  }`,
  /** The old scene burns away along a glowing, ragged edge. */
  burn: `vec4 transition(vec2 uv) {
    float n = fbm(uv * vec2(ratio, 1.0) * 4.0);
    float edge = progress * 1.3 - 0.15;
    float w = 0.06;
    vec4 glow = vec4(1.0, 0.55, 0.15, 1.0);
    if (n < edge - w) return getTo(uv);
    if (n > edge + w) return getFrom(uv);
    float t = (n - (edge - w)) / (2.0 * w);
    return mix(mix(getTo(uv), glow, smoothstep(0.0, 0.5, t)), getFrom(uv), smoothstep(0.5, 1.0, t));
  }`,
  /** A fast horizontal pan, smeared with motion blur, lands on the new scene. */
  "whip-pan": `vec4 transition(vec2 uv) {
    float blur = sin(progress * 3.14159) * 0.08;
    vec4 c = vec4(0.0);
    for (int i = 0; i < 16; i++) {
      float k = (float(i) / 15.0 - 0.5) * blur;
      vec2 a = vec2(uv.x + progress + k, uv.y);
      vec2 b = vec2(uv.x + progress - 1.0 + k, uv.y);
      c += a.x <= 1.0 ? getFrom(a) : getTo(b);
    }
    return c / 16.0;
  }`,
  /** Out through white, in from white. */
  flash: `vec4 transition(vec2 uv) {
    float w = sin(progress * 3.14159);
    vec4 base = progress < 0.5 ? getFrom(uv) : getTo(uv);
    return mix(base, vec4(1.0), w * w);
  }`,
  /** A warm wash of light sweeps across while the scenes cross. */
  "light-leak": `vec4 transition(vec2 uv) {
    float sweep = progress * 1.6 - 0.3;
    float band = exp(-pow((uv.x + uv.y * 0.35 - sweep) * 3.0, 2.0));
    vec4 leak = vec4(1.0, 0.72, 0.42, 1.0) * band * sin(progress * 3.14159) * 0.9;
    return mix(getFrom(uv), getTo(uv), smoothstep(0.2, 0.8, progress)) + leak;
  }`,
  /** Space bends towards the centre like a lens, then lets go on the new scene. */
  lens: `vec4 transition(vec2 uv) {
    vec2 c = (uv - 0.5) * vec2(ratio, 1.0);
    float r = length(c);
    float pull = sin(progress * 3.14159) * 0.28;
    vec2 p = c * (1.0 - pull * exp(-r * 3.0)) / vec2(ratio, 1.0) + 0.5;
    return mix(getFrom(p), getTo(p), smoothstep(0.35, 0.65, progress));
  }`,
  /** A flowing noise field warps both pictures as one melts into the other. */
  warp: `vec4 transition(vec2 uv) {
    float s = sin(progress * 3.14159) * 0.09;
    vec2 q = vec2(fbm(uv * 3.0 + progress), fbm(uv * 3.0 + 5.2 - progress));
    vec2 p = uv + (q - 0.5) * s * 2.0;
    return mix(getFrom(p), getTo(p), smoothstep(0.3, 0.7, progress));
  }`,
} as const;

export type ShaderName = keyof typeof shaders;
export const shaderNames = Object.keys(shaders) as ShaderName[];
