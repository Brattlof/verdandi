/**
 * Render-only clock, injected before anything else on the page: `Date`, `Date.now()` and `performance.now()` read the
 * time being rendered, and `requestAnimationFrame` callbacks run only when a frame is seeked, with that time. Timers
 * keep real time (the originals stay on `__VD_VIRTUAL_TIME__` for the runtime's own waits).
 */
export {};

const RealDate = Date;
const realNow = performance.now.bind(performance);
const realRaf = window.requestAnimationFrame.bind(window);
let now = 0;
let queue: [number, FrameRequestCallback][] = [];
let nextId = 1;

class VirtualDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(now);
    else super(...(args as [string]));
  }
  static override now() {
    return now;
  }
}

window.Date = VirtualDate as DateConstructor;
performance.now = () => now;
window.requestAnimationFrame = (cb) => {
  const id = nextId++;
  queue.push([id, cb]);
  return id;
};
window.cancelAnimationFrame = (id) => {
  queue = queue.filter(([qid]) => qid !== id);
};

window.__VD_VIRTUAL_TIME__ = {
  seekToTime(ms: number) {
    now = ms;
    const run = queue;
    queue = [];
    for (const [, cb] of run) {
      try {
        cb(now);
      } catch (error) {
        console.error("[verdandi] animation frame callback failed:", error);
      }
    }
  },
  realNow,
  realRaf,
};
