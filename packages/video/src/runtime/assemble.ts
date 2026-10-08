/**
 * Mounts sub-compositions into the page: every `[data-composition-src]` host, and every empty host whose
 * `<template id="<id>-template">` is in the document. This is the only assembler: preview and render both run it, so
 * what the Studio shows is what renders.
 *
 * A mounted file contributes its `<template>` content (or its `<body>`), its styles scoped to the host with native
 * `@scope`, its links, and its scripts, each run inside a function whose `document`, `gsap` and `window.__timelines`
 * see only that composition.
 */

const maxDepth = 20;

/** Per-composition variable values, keyed by the composition's runtime id. Read through `__verdandi.getVariables()`. */
export const variablesByComposition = new Map<string, Record<string, unknown>>();

const parseJson = (raw: string | null | undefined): unknown => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[verdandi] ignoring malformed JSON: ${raw.slice(0, 80)}`);
    return undefined;
  }
};

/** The defaults a `data-composition-variables` declaration list gives. */
export const declaredDefaults = (el: Element | null): Record<string, unknown> => {
  const list = parseJson(el?.getAttribute("data-composition-variables"));
  if (!Array.isArray(list)) return {};
  const out: Record<string, unknown> = {};
  for (const d of list) if (d && typeof d === "object" && typeof d.id === "string" && "default" in d) out[d.id] = d.default;
  return out;
};

const overrides = (host: Element) => {
  const v = parseJson(host.getAttribute("data-variable-values"));
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
};

const usedIds = new Map<string, number>();

/** A runtime id for one more mount of `id`: the id itself the first time, `id__vd2`, `id__vd3`, … after. */
const instanceId = (id: string) => {
  const n = (usedIds.get(id) ?? 0) + 1;
  usedIds.set(id, n);
  return n === 1 ? id : `${id}__vd${n}`;
};

const cssEscape = (s: string) => s.replace(/["\\]/g, "\\$&");
const pageRoots = /(^|[\s>+~,(])(?:html|body|:root)(?=$|[\s>+~,.:[#)])/g;

/**
 * Rewrites a mounted file's CSS so it applies only inside its host: style rules (and `@media`/`@supports` blocks of
 * them) go in one `@scope`, with `html`, `body` and `:root` meaning the host and `#<inner root id>` the inner root;
 * `@keyframes`, `@font-face`, `@property` and `@import` stay global.
 */
export const scopeCss = (css: string, scopeSelector: string, innerRootId: string | undefined, sheet = new CSSStyleSheet()) => {
  try {
    sheet.replaceSync(css.replace(/@import[^;]+;/g, ""));
  } catch {
    return `@scope (${scopeSelector}) { ${css} }`;
  }
  const imports = css.match(/@import[^;]+;/g) ?? [];
  const global: string[] = [];
  const scoped: string[] = [];
  const idRef = innerRootId ? new RegExp(`#${innerRootId.replace(/[^\w-]/g, "\\$&")}(?![\\w-])`, "g") : undefined;
  const rewrite = (rule: CSSRule): string => {
    if (rule instanceof CSSStyleRule) {
      let selector = rule.selectorText.replace(pageRoots, "$1:scope");
      if (idRef) selector = selector.replace(idRef, `[data-vd-authored-id="${cssEscape(innerRootId ?? "")}"]`);
      return `${selector} { ${rule.style.cssText} }`;
    }
    if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
      const head = rule instanceof CSSMediaRule ? `@media ${rule.conditionText}` : `@supports ${rule.conditionText}`;
      return `${head} { ${[...rule.cssRules].map(rewrite).join(" ")} }`;
    }
    return rule.cssText;
  };
  for (const rule of sheet.cssRules) {
    if (rule instanceof CSSStyleRule || rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) scoped.push(rewrite(rule));
    else global.push(rule.cssText);
  }
  return [...imports, ...global, scoped.length ? `@scope (${scopeSelector}) { ${scoped.join("\n")} }` : ""].join("\n");
};

/** Targets resolved inside `root`: a selector string matches only that subtree (the root itself included). */
const scopeTargets = (root: Element, targets: unknown): unknown => {
  if (typeof targets !== "string") return targets;
  const found = [...(root.matches(targets) ? [root] : []), ...root.querySelectorAll(targets)];
  return found;
};

type Gsapish = Record<string, unknown> & { timeline?: (...a: unknown[]) => Record<string, unknown> };
const tweenMethods = ["to", "from", "fromTo", "set"] as const;

/** `gsap` as a composition's script sees it: string targets resolve inside its root, on gsap and on its timelines. */
const scopedGsap = (root: Element, gsap: Gsapish | undefined) => {
  if (!gsap) return gsap;
  const scoped: Gsapish = Object.create(gsap);
  for (const m of tweenMethods) {
    const original = gsap[m];
    if (typeof original === "function")
      scoped[m] = (targets: unknown, ...rest: unknown[]) => original.call(gsap, scopeTargets(root, targets), ...rest);
  }
  const timeline = gsap.timeline;
  if (typeof timeline === "function")
    scoped.timeline = (...args: unknown[]) => {
      const tl = timeline.apply(gsap, args);
      for (const m of tweenMethods) {
        const original = tl[m];
        if (typeof original === "function")
          // An own property on this one timeline: GSAP keeps working with the real object, never a proxy.
          tl[m] = (targets: unknown, ...rest: unknown[]) => original.call(tl, scopeTargets(root, targets), ...rest);
      }
      return tl;
    };
  return scoped;
};

const scopedDocument = (root: Element) =>
  new Proxy(document, {
    get(target, key) {
      if (key === "querySelector") return (s: string) => (root.matches(s) ? root : root.querySelector(s));
      if (key === "querySelectorAll") return (s: string) => scopeTargets(root, s);
      if (key === "getElementById")
        return (id: string) =>
          root.querySelector(`[id="${cssEscape(id)}"]`) ?? root.querySelector(`[data-vd-authored-id="${cssEscape(id)}"]`);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/** `window.__timelines` as a composition sees it: its declared id writes through to its runtime id. */
const scopedTimelines = (declaredId: string, runtimeId: string) =>
  new Proxy(window.__timelines, {
    set(target, key, value) {
      target[key === declaredId ? runtimeId : String(key)] = value;
      return true;
    },
    get(target, key) {
      return key === declaredId ? (target[runtimeId] ?? target[declaredId]) : target[String(key)];
    },
  });

const scopedWindow = (timelines: object, api: object) =>
  new Proxy(window, {
    get(target, key) {
      if (key === "__timelines") return timelines;
      if (key === "__verdandi") return api;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" && !/^[A-Z]/.test(String(key)) ? value.bind(target) : value;
    },
    set(target, key, value) {
      return Reflect.set(target, key, value, target);
    },
  });

export type CompositionApi = { readonly getVariables: () => Record<string, unknown>; readonly assetUrl: (path: string) => string };

/** The `__verdandi` helpers for one composition: its variables, and asset URLs relative to its own file. */
export const compositionApi = (runtimeId: string, base: string): CompositionApi => ({
  getVariables: () => ({ ...(variablesByComposition.get(runtimeId) ?? {}) }),
  assetUrl: (path: string) => new URL(path, base).href,
});

/** Runs one script's source as a composition's: its globals scoped, its errors logged with the composition's id. */
const runScoped = (source: string, root: Element, declaredId: string, runtimeId: string, base: string) => {
  const api = compositionApi(runtimeId, base);
  const timelines = scopedTimelines(declaredId, runtimeId);
  const win = scopedWindow(timelines, api);
  try {
    new Function("document", "gsap", "window", "__verdandi", source)(scopedDocument(root), scopedGsap(root, window.gsap), win, api);
  } catch (error) {
    console.error(`[verdandi] composition script error in ${runtimeId}:`, error);
  }
};

/** Loads an external script and resolves once it ran (or failed: a broken script must not hang the page). */
const loadScript = (src: string, loaded: Set<string>) => {
  if (loaded.has(src)) return Promise.resolve();
  loaded.add(src);
  return new Promise<void>((resolve) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => {
      console.error(`[verdandi] failed to load script ${src}`);
      resolve();
    };
    document.head.append(el);
  });
};

/** Makes a mounted file's relative `src`, `href` and `poster` URLs relative to that file instead of the page. */
const rebase = (root: Element | DocumentFragment, base: string) => {
  for (const node of [...(root instanceof Element ? [root] : []), ...root.querySelectorAll("[src],[href],[poster]")])
    for (const attr of ["src", "href", "poster"]) {
      const v = node.getAttribute(attr);
      if (v && !/^(?:[a-z]+:|#|\/)/i.test(v)) node.setAttribute(attr, new URL(v, base).href);
    }
};

type Source = {
  readonly content: DocumentFragment | Element;
  readonly head: HTMLHeadElement | undefined;
  readonly html: Element | undefined;
  readonly base: string;
};

const fetchSource = async (src: string, loaded: Map<string, Promise<string>>): Promise<Source | undefined> => {
  const url = new URL(src, document.baseURI).href;
  let text = loaded.get(url);
  if (!text) {
    text = fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))));
    loaded.set(url, text);
  }
  try {
    const doc = new DOMParser().parseFromString(await text, "text/html");
    const template = doc.querySelector("template");
    // A templated file's own <head> is not part of it: its styles and scripts belong inside the template.
    if (template) return { content: template.content, head: undefined, html: doc.documentElement, base: url };
    return { content: doc.body, head: doc.head, html: doc.documentElement, base: url };
  } catch (error) {
    console.error(`[verdandi] could not load composition ${url}:`, error);
    return undefined;
  }
};

const inlineSource = (host: Element): Source | undefined => {
  const id = host.getAttribute("data-composition-id");
  const template = id ? document.getElementById(`${id}-template`) : null;
  return template instanceof HTMLTemplateElement
    ? { content: template.content, head: undefined, html: undefined, base: document.baseURI }
    : undefined;
};

/**
 * Mounts every sub-composition host in the document, breadth first, nested ones included (at most 20 deep, cycles
 * skipped), and runs their scripts in document order. Resolves once all have mounted.
 */
export const mountCompositions = async () => {
  const texts = new Map<string, Promise<string>>();
  const scripts = new Set<string>([...document.scripts].map((s) => s.src).filter(Boolean));
  const queue: { host: Element; chain: readonly string[] }[] = [
    ...document.querySelectorAll("[data-composition-src], [data-composition-id]:empty"),
  ].map((host) => ({ host, chain: [] }));
  for (let item = queue.shift(); item; item = queue.shift()) {
    const { host, chain } = item;
    const src = host.getAttribute("data-composition-src");
    if (src && (chain.includes(src) || chain.length >= maxDepth)) {
      console.warn(`[verdandi] skipping ${src}: ${chain.includes(src) ? "it includes itself" : `nested over ${maxDepth} deep`}`);
      continue;
    }
    const source = src ? await fetchSource(src, texts) : inlineSource(host);
    if (!source) continue;
    const { content, head, base } = source;
    const hostId = host.getAttribute("data-composition-id");
    const innerRoot =
      (hostId && content.querySelector(`[data-composition-id="${cssEscape(hostId)}"]`)) || content.querySelector("[data-composition-id]");
    const declaredId = innerRoot?.getAttribute("data-composition-id") ?? hostId ?? "";
    const runtimeId = instanceId(hostId ?? declaredId);
    host.setAttribute("data-composition-id", runtimeId);
    if (runtimeId !== (hostId ?? declaredId)) host.setAttribute("data-vd-original-composition-id", hostId ?? declaredId);

    variablesByComposition.set(runtimeId, {
      ...declaredDefaults(source.html ?? null),
      ...declaredDefaults(innerRoot ?? null),
      ...((window.__vdVariables as Record<string, unknown> | undefined) ?? {}),
      ...overrides(host),
    });

    const styles = [...(head?.querySelectorAll("style") ?? []), ...content.querySelectorAll("style")];
    const links = [...(head?.querySelectorAll("link[rel=stylesheet]") ?? []), ...content.querySelectorAll("link[rel=stylesheet]")];
    const scriptEls = [...(head?.querySelectorAll("script") ?? []), ...content.querySelectorAll("script")];
    for (const el of [...styles, ...links, ...scriptEls]) el.remove();

    const innerId = innerRoot?.id || undefined;
    const scope = `[data-composition-id="${cssEscape(runtimeId)}"]`;
    for (const link of links) {
      const href = link.getAttribute("href");
      if (href && !document.querySelector(`link[href="${cssEscape(new URL(href, base).href)}"]`)) {
        const el = document.createElement("link");
        el.rel = "stylesheet";
        el.href = new URL(href, base).href;
        document.head.append(el);
      }
    }
    if (styles.length) {
      const style = document.createElement("style");
      style.dataset.vdScope = runtimeId;
      style.textContent = styles.map((s) => scopeCss(s.textContent ?? "", scope, innerId)).join("\n");
      document.head.append(style);
    }

    const fragment = document.importNode(innerRoot ? innerRoot : content, true);
    if (fragment instanceof Element) {
      // The inner root becomes a plain wrapper inside the host: the host keeps the composition's identity and timing.
      for (const attr of ["data-composition-id", "data-start", "data-duration", "data-end", "data-track-index"])
        fragment.removeAttribute(attr);
      if (fragment.id) {
        fragment.setAttribute("data-vd-authored-id", fragment.id);
        fragment.removeAttribute("id");
      }
      fragment.setAttribute("data-vd-inner-root", "");
      const w = innerRoot?.getAttribute("data-width");
      const h = innerRoot?.getAttribute("data-height");
      if (w && !host.hasAttribute("data-width")) host.setAttribute("data-width", w);
      if (h && !host.hasAttribute("data-height")) host.setAttribute("data-height", h);
      if (fragment instanceof HTMLElement) {
        fragment.style.width = w ? `${w}px` : "100%";
        fragment.style.height = h ? `${h}px` : "100%";
      }
    }
    rebase(fragment, base);
    host.replaceChildren(fragment);
    if (src) {
      host.setAttribute("data-vd-composition-file", src);
      host.removeAttribute("data-composition-src");
    }

    for (const script of scriptEls) {
      const external = script.getAttribute("src");
      if (external) await loadScript(new URL(external, base).href, scripts);
      else if (!script.type || script.type === "text/javascript") runScoped(script.textContent ?? "", host, declaredId, runtimeId, base);
    }
    for (const nested of host.querySelectorAll("[data-composition-src]"))
      queue.push({ host: nested, chain: src ? [...chain, src] : chain });
  }
};

declare global {
  interface Window {
    __timelines: Record<string, unknown>;
    __vdVariables?: Record<string, unknown>;
    gsap?: Gsapish;
  }
}
