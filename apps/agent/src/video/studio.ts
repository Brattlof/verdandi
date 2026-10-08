/**
 * The Studio's side of verdandid (DESIGN §24): video projects open in this process, their files (read and written
 * with versions, so two editors never overwrite each other unseen), a watcher that tells clients what changed on disk,
 * render jobs with progress, and the sandboxed preview served at `/video/<project id>/…`.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, type FSWatcher, mkdirSync, readFileSync, realpathSync, renameSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type VideoFeed,
  type VideoFile,
  type VideoFormat,
  type VideoProjectId,
  type VideoQuality,
  type VideoRenderJob,
  VideoUnavailable,
  type VideoView,
} from "@verdandi/contracts";
import { projectHandler, render } from "@verdandi/video";
import { Context, Effect, Layer, PubSub, Stream } from "effect";
import { childEnv } from "../home/child-env.ts";

/** Files the Studio edits: the composition's text, never media, vendored libraries or outputs. */
const editable = "**/*.{html,css,js,mjs,json,md,svg,txt}";
const skipped = /^(?:vendor|renders|snapshots|node_modules|\.git)(?:\/|$)/;

const version = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

type Project = {
  readonly id: VideoProjectId;
  readonly path: string;
  readonly handle: (path: string, headers: Headers) => Promise<Response>;
  readonly changes: PubSub.PubSub<VideoFeed>;
  readonly watcher: FSWatcher | undefined;
};

export class VideoStudio extends Context.Service<
  VideoStudio,
  {
    readonly open: (path: string) => Effect.Effect<VideoView, VideoUnavailable>;
    readonly read: (projectId: VideoProjectId, path: string) => Effect.Effect<VideoFile, VideoUnavailable>;
    readonly write: (
      projectId: VideoProjectId,
      path: string,
      content: string,
      expectedVersion: string | null,
    ) => Effect.Effect<{ readonly version: string }, VideoUnavailable>;
    readonly renderStart: (
      projectId: VideoProjectId,
      options: { readonly format: VideoFormat; readonly quality: VideoQuality; readonly fps: number },
    ) => Effect.Effect<VideoRenderJob, VideoUnavailable>;
    readonly renderCancel: (jobId: string) => Effect.Effect<void, VideoUnavailable>;
    readonly feed: (projectId: VideoProjectId) => Stream.Stream<VideoFeed, VideoUnavailable>;
    /** The preview's response for `/video/<id>/<path>`, or undefined for a project that isn't open. */
    readonly serve: (projectId: string, path: string, headers: Headers) => Promise<Response> | undefined;
  }
>()("verdandi/VideoStudio") {}

const notOpen = (projectId: string) =>
  new VideoUnavailable({
    reason: "ProjectNotOpen",
    message: `No video project ${projectId} is open in this verdandid (it restarted, or the id is wrong). Open the project again.`,
  });

/** `rel` inside `root` as an absolute path, or a failure naming why not (absolute, `..`, or a non-text file). */
const within = (root: string, rel: string, needEditable: boolean) => {
  const clean = rel.replaceAll("\\", "/").replace(/^\.\//, "");
  const target = resolve(root, clean);
  const r = relative(root, target);
  if (!clean || isAbsolute(clean) || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r))
    return Effect.fail(
      new VideoUnavailable({
        reason: "InvalidPath",
        message: `${rel} isn't a path inside the project. Use a relative path like compositions/intro.html.`,
      }),
    );
  if (needEditable && !new Bun.Glob(editable).match(clean))
    return Effect.fail(
      new VideoUnavailable({
        reason: "InvalidPath",
        message: `${rel} isn't a text file the Studio edits (html, css, js, json, md, svg, txt).`,
      }),
    );
  return Effect.succeed(target);
};

const listFiles = (root: string) =>
  [...new Bun.Glob(editable).scanSync({ cwd: root, dot: false })]
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !skipped.test(f))
    .sort();

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export const VideoStudioLive = Layer.effect(
  VideoStudio,
  Effect.gen(function* () {
    const projects = new Map<string, Project>();
    const byPath = new Map<string, VideoProjectId>();
    const jobs = new Map<string, { job: VideoRenderJob; projectId: VideoProjectId; abort: AbortController }>();

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const p of projects.values()) p.watcher?.close();
        for (const j of jobs.values()) j.abort.abort();
      }),
    );

    const project = (projectId: string) => {
      const p = projects.get(projectId);
      return p ? Effect.succeed(p) : Effect.fail(notOpen(projectId));
    };

    const view = (p: Project): VideoView => ({
      projectId: p.id,
      path: p.path,
      files: listFiles(p.path),
      renders: [...jobs.values()].filter((j) => j.projectId === p.id).map((j) => j.job),
    });

    const publish = (p: Project, message: VideoFeed) => PubSub.publishUnsafe(p.changes, message);

    const update = (jobId: string, patch: Partial<VideoRenderJob>) => {
      const entry = jobs.get(jobId);
      const p = entry && projects.get(entry.projectId);
      if (!entry || !p) return;
      entry.job = { ...entry.job, ...patch };
      publish(p, { kind: "render", job: entry.job });
    };

    return VideoStudio.of({
      open: (path) =>
        Effect.gen(function* () {
          const real = yield* Effect.try({
            try: () => realpathSync(resolve(path.replace(/^~(?=$|[\\/])/, process.env.HOME ?? "~"))),
            catch: () =>
              new VideoUnavailable({ reason: "NotAProject", message: `${path} doesn't exist. Create one with verdandi video init <dir>.` }),
          });
          if (!existsSync(join(real, "index.html")))
            return yield* new VideoUnavailable({
              reason: "NotAProject",
              message: `${real} has no index.html, so it isn't a video project. Create one with verdandi video init <dir>.`,
            });
          const known = byPath.get(real);
          const existing = known && projects.get(known);
          if (existing) return view(existing);
          const id = randomBytes(32).toString("hex") as VideoProjectId;
          const handle = yield* Effect.promise(() => projectHandler(real, { preview: true }));
          const changes = yield* PubSub.unbounded<VideoFeed>();
          let pending = new Set<string>();
          let timer: ReturnType<typeof setTimeout> | undefined;
          // ponytail: one recursive watcher per open project for verdandid's life; close them when projects can be closed.
          const watcher = (() => {
            try {
              return watch(real, { recursive: true }, (_event, name) => {
                const file = String(name ?? "").replaceAll("\\", "/");
                if (!file || skipped.test(file)) return;
                pending.add(file);
                clearTimeout(timer);
                // Editors save in bursts (temp file, rename); one message per quiet 60 ms.
                timer = setTimeout(() => {
                  const p = projects.get(id);
                  if (p) publish(p, { kind: "changed", paths: [...pending].sort(), files: listFiles(real) });
                  pending = new Set();
                }, 60);
              });
            } catch {
              return undefined;
            }
          })();
          const p: Project = { id, path: real, handle, changes, watcher };
          projects.set(id, p);
          byPath.set(real, id);
          return view(p);
        }),

      read: (projectId, path) =>
        Effect.gen(function* () {
          const p = yield* project(projectId);
          const target = yield* within(p.path, path, true);
          if (!existsSync(target))
            return yield* new VideoUnavailable({ reason: "FileNotFound", message: `${path} doesn't exist in the project.` });
          const bytes = readFileSync(target);
          return { path, content: bytes.toString("utf8"), version: version(bytes) };
        }),

      write: (projectId, path, content, expectedVersion) =>
        Effect.gen(function* () {
          const p = yield* project(projectId);
          const target = yield* within(p.path, path, true);
          const exists = existsSync(target);
          const bytes = exists ? readFileSync(target) : undefined;
          const current = bytes ? version(bytes) : null;
          if (current !== expectedVersion)
            return yield* new VideoUnavailable({
              reason: "Conflict",
              message:
                current === null
                  ? `${path} was deleted since you opened it. Save again to create it.`
                  : `${path} changed on disk since you opened it (another editor or an agent). Reload it, or keep yours and save again.`,
              ...(bytes && current && { current: { path, content: bytes.toString("utf8"), version: current } }),
            });
          mkdirSync(dirname(target), { recursive: true });
          const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
          writeFileSync(temp, content);
          renameSync(temp, target);
          return { version: version(content) };
        }),

      renderStart: (projectId, { format, quality, fps }) =>
        Effect.gen(function* () {
          const p = yield* project(projectId);
          const jobId = randomBytes(8).toString("hex");
          const ext = format === "png-sequence" ? "" : `.${format}`;
          const output = join("renders", `${basename(p.path)}-${stamp()}${ext}`);
          const abort = new AbortController();
          const job: VideoRenderJob = {
            jobId,
            status: "rendering",
            stage: "open",
            done: 0,
            total: 0,
            format,
            output: null,
            error: null,
            startedAt: Date.now(),
          };
          jobs.set(jobId, { job, projectId, abort });
          publish(p, { kind: "render", job });
          let last = 0;
          render({
            projectDir: p.path,
            output: join(p.path, output),
            format,
            quality,
            fps,
            env: childEnv(),
            signal: abort.signal,
            onProgress: ({ stage, done, total }) => {
              // A message per stage, and at most four a second while capturing: progress must not flood the socket.
              const now = performance.now();
              if (stage === jobs.get(jobId)?.job.stage && done < total && now - last < 250) return;
              last = now;
              update(jobId, { stage, done, total });
            },
          }).then(
            () => update(jobId, { status: "done", output }),
            (error: unknown) =>
              update(
                jobId,
                abort.signal.aborted
                  ? { status: "cancelled" }
                  : { status: "failed", error: error instanceof Error ? error.message : String(error) },
              ),
          );
          return job;
        }),

      renderCancel: (jobId) => {
        const entry = jobs.get(jobId);
        if (!entry)
          return Effect.fail(new VideoUnavailable({ reason: "RenderNotFound", message: `No render ${jobId} in this verdandid.` }));
        return Effect.sync(() => entry.abort.abort());
      },

      feed: (projectId) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const p = yield* project(projectId);
            // Subscribe before taking the snapshot, so nothing between the two is lost.
            const subscription = yield* PubSub.subscribe(p.changes);
            return Stream.concat(Stream.succeed<VideoFeed>({ kind: "snapshot", view: view(p) }), Stream.fromSubscription(subscription));
          }),
        ),

      serve: (projectId, path, headers) => projects.get(projectId)?.handle(path, headers),
    });
  }),
);
