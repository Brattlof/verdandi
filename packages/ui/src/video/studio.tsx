import type {
  VideoClip,
  VideoFeed,
  VideoFormat,
  VideoManifest,
  VideoProjectId,
  VideoQuality,
  VideoRenderJob,
  VideoView,
} from "@verdandi/contracts";
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { Connection } from "../client.ts";
import { RuneText } from "../ui/runes.tsx";
import { CodeEditor } from "./editor.tsx";
import { emptyHistory, type History, record, redoStep, undoStep } from "./history.ts";
import { Inspector } from "./inspector.tsx";
import { assetMarkup, insertIntoComposition, seconds, setAttribute } from "./patch.ts";
import type { VerdandiPlayer } from "./player.ts";
import "./player.ts";
import { Timeline } from "./timeline.tsx";

/** The open project lives in the hash (`#view=video&project=<path>`), so a reload reopens it. */
const hashProject = () => new URLSearchParams(location.hash.slice(1)).get("project") ?? "";
const recentKey = "verdandi.video.recent";
const recent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(recentKey) ?? "[]");
  } catch {
    return [];
  }
};

type Open = { readonly path: string; readonly saved: string; readonly draft: string; readonly version: string };

/**
 * The video Studio (DESIGN §24): a project's preview in a sandboxed player, its timeline (drag to move or trim a clip,
 * H to hide one), its files in a code editor, and renders with their progress. Edits from anywhere (an agent, another
 * editor) reload the preview at the same time; an unsaved edit to a file that changed on disk asks which one to keep.
 */
export const StudioPage = ({ connection }: { connection: Connection }) => {
  const [path, setPath] = useState(hashProject);
  const [view, setView] = useState<VideoView>();
  const [error, setError] = useState<string>();
  const open = useCallback(
    async (target: string) => {
      setError(undefined);
      const result = await connection.video((rpc) => rpc.VideoOpen({ path: target }));
      if (!result.ok) return setError(result.message);
      setView(result.value);
      localStorage.setItem(recentKey, JSON.stringify([result.value.path, ...recent().filter((p) => p !== result.value.path)].slice(0, 8)));
      history.replaceState(null, "", `#${new URLSearchParams({ view: "video", project: result.value.path })}`);
    },
    [connection],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: reopen the project from the hash once, on arrival.
  useEffect(() => {
    if (path) void open(path);
  }, []);

  if (!view)
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1040px] px-5 py-10 sm:px-8 sm:py-14">
          <header className="mb-6">
            <p className="flex items-center gap-3 text-rune">
              <RuneText runes={["dagaz"]} className="h-4" />
              <span className="eyebrow text-muted">Dagaz · daylight</span>
            </p>
            <h1 className="mt-3 font-serif text-5xl leading-[0.95] font-bold tracking-tight uppercase sm:text-6xl">Video</h1>
          </header>
          <form
            className="flex max-w-2xl flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void open(path);
            }}
          >
            <label htmlFor="video-project" className="eyebrow text-muted">
              Open a video project
            </label>
            <div className="flex gap-2">
              <input
                id="video-project"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/path/to/project (made with verdandi video init)"
                className="flex-1"
                spellCheck={false}
                aria-describedby="video-project-error"
              />
              {connection.endpoint.sameMachine && (
                <button
                  type="button"
                  onClick={async () => {
                    const picked = await connection.pickFolder();
                    if (picked.ok && picked.path) void open(picked.path);
                    else if (!picked.ok) setError(picked.message);
                  }}
                >
                  Browse
                </button>
              )}
              <button type="submit" className="bg-go text-on-go hover:bg-go-hover">
                Open
              </button>
            </div>
            <p id="video-project-error" role="alert" className="text-error empty:hidden">
              {error}
            </p>
          </form>
          {recent().length > 0 && (
            <section className="mt-8 max-w-2xl">
              <h2 className="eyebrow mb-2 text-muted">Recent</h2>
              <ul className="-mx-3">
                {recent().map((p) => (
                  <li key={p}>
                    <button
                      type="button"
                      className="w-full truncate border-0 bg-transparent px-3 py-2 text-left hover:bg-hover"
                      onClick={() => void open(p)}
                    >
                      {p}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    );
  return (
    <Studio
      key={view.projectId}
      connection={connection}
      initial={view}
      onClose={() => {
        setView(undefined);
        history.replaceState(null, "", "#view=video");
      }}
    />
  );
};

const Studio = ({ connection, initial, onClose }: { connection: Connection; initial: VideoView; onClose: () => void }) => {
  const projectId = initial.projectId as VideoProjectId;
  const [files, setFiles] = useState(initial.files);
  const [assets, setAssets] = useState(initial.assets);
  const [selected, setSelected] = useState<string>();
  const [jobs, setJobs] = useState<ReadonlyMap<string, VideoRenderJob>>(new Map(initial.renders.map((j) => [j.jobId, j])));
  const [manifest, setManifest] = useState<VideoManifest>();
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [file, setFile] = useState<Open>();
  const [conflict, setConflict] = useState<{ readonly content: string; readonly version: string }>();
  const [notice, setNotice] = useState<string>();
  const player = useRef<VerdandiPlayer>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  // ponytail: history lives in this page and ends with it; keep it server-side if edits must survive a reload.
  const [history, setHistory] = useState<History>(emptyHistory);
  const historyRef = useRef(history);
  historyRef.current = history;

  /** Writes `after` over `before` (at `version`), remembering it for undo; false when it didn't write. */
  const write = useCallback(
    async (path: string, before: string, after: string, version: string | null, label: string) => {
      const result = await connection.video((rpc) => rpc.VideoFileWrite({ projectId, path, content: after, expectedVersion: version }));
      if (!result.ok) {
        if (!(result.reason === "Conflict" && path === fileRef.current?.path)) setNotice(result.message);
        return result;
      }
      setHistory((h) => record(h, { label, path, before, after }));
      return result;
    },
    [connection, projectId],
  );

  /** Undoes (or redoes) the latest edit, unless the file changed since: then it says so and leaves it. */
  const step = useCallback(
    async (direction: "undo" | "redo") => {
      const found = direction === "undo" ? undoStep(historyRef.current) : redoStep(historyRef.current);
      if (!found) return;
      const { edit, next } = found;
      const [expected, target] = direction === "undo" ? [edit.after, edit.before] : [edit.before, edit.after];
      const now = await connection.video((rpc) => rpc.VideoFileRead({ projectId, path: edit.path }));
      if (!now.ok) return setNotice(now.message);
      if (now.value.content !== expected)
        return setNotice(
          `${edit.path} changed since "${edit.label}", so ${direction === "undo" ? "undoing" : "redoing"} it would lose that change.`,
        );
      const result = await connection.video((rpc) =>
        rpc.VideoFileWrite({ projectId, path: edit.path, content: target, expectedVersion: now.value.version }),
      );
      if (!result.ok) return setNotice(result.message);
      setHistory(next);
    },
    [connection, projectId],
  );

  const read = useCallback(
    async (p: string) => {
      const result = await connection.video((rpc) => rpc.VideoFileRead({ projectId, path: p }));
      if (!result.ok) return setNotice(result.message);
      setConflict(undefined);
      setFile({ path: p, saved: result.value.content, draft: result.value.content, version: result.value.version });
    },
    [connection, projectId],
  );

  useEffect(() => {
    void read(initial.files.includes("index.html") ? "index.html" : (initial.files[0] ?? "index.html"));
  }, [read, initial.files]);

  useEffect(
    () =>
      connection.follow(
        (rpc, subscriptionId) => rpc.VideoSubscribe({ projectId, subscriptionId }),
        async (message: VideoFeed) => {
          if (message.kind === "snapshot") {
            setFiles(message.view.files);
            setAssets(message.view.assets);
            setJobs(new Map(message.view.renders.map((j) => [j.jobId, j])));
          } else if (message.kind === "render") setJobs((m) => new Map(m).set(message.job.jobId, message.job));
          else {
            setFiles(message.files);
            setAssets(message.assets);
            const changed = message.paths.filter((p) => !p.startsWith("renders/"));
            if (!changed.length) return;
            player.current?.load(player.current.currentTime);
            const open = fileRef.current;
            if (!open || !changed.includes(open.path)) return;
            const result = await connection.video((rpc) => rpc.VideoFileRead({ projectId, path: open.path }));
            if (!result.ok || result.value.version === open.version) return;
            // Our own save already holds this version; anything else is someone else's edit.
            if (open.draft === open.saved)
              setFile({ ...open, saved: result.value.content, draft: result.value.content, version: result.value.version });
            else setConflict({ content: result.value.content, version: result.value.version });
          }
        },
        (message) => setNotice(message),
      ),
    [connection, projectId],
  );

  const save = useCallback(async () => {
    const open = fileRef.current;
    if (!open || open.draft === open.saved) return;
    const result = await write(open.path, open.saved, open.draft, open.version, `Edit ${open.path}`);
    if (result.ok) {
      setFile({ ...open, saved: open.draft, version: result.value.version });
      setConflict(undefined);
    } else if (result.reason === "Conflict" && result.current)
      setConflict({ content: result.current.content, version: result.current.version });
    else setNotice(result.message);
  }, [write]);

  /** Writes one attribute of the clip with `clip.id`, in whichever HTML file declares it. */
  const patchClip = useCallback(
    async (clip: VideoClip, name: string, value: string | null, label: string) => {
      if (!clip.id) return;
      for (const p of files.filter((f) => f.endsWith(".html"))) {
        const result = await connection.video((rpc) => rpc.VideoFileRead({ projectId, path: p }));
        if (!result.ok) continue;
        const next = setAttribute(result.value.content, clip.id, name, value);
        if (next === undefined) continue;
        await write(p, result.value.content, next, result.value.version, label);
        return;
      }
      setNotice(`No HTML file in the project has an element with id="${clip.id}".`);
    },
    [connection, files, projectId, write],
  );

  // Mod+Z and Mod+Shift+Z outside the code editor, which keeps its own undo for unsaved typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        !(e.metaKey || e.ctrlKey) ||
        e.key.toLowerCase() !== "z" ||
        (e.target as Element | null)?.closest?.(".cm-editor, input, select, textarea")
      )
        return;
      e.preventDefault();
      void step(e.shiftKey ? "redo" : "undo");
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [step]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-2">
        <button type="button" onClick={onClose}>
          Close
        </button>
        <span className="min-w-0 flex-1 truncate font-medium" title={initial.path}>
          {initial.path}
        </span>
        <button
          type="button"
          onClick={() => void step("undo")}
          disabled={!history.undo.length}
          title={history.undo.at(-1) ? `Undo ${history.undo.at(-1)?.label} (⌘Z)` : "Nothing to undo"}
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => void step("redo")}
          disabled={!history.redo.length}
          title={history.redo.at(-1) ? `Redo ${history.redo.at(-1)?.label} (⌘⇧Z)` : "Nothing to redo"}
        >
          Redo
        </button>
        <RenderControls connection={connection} projectId={projectId} onError={setNotice} />
      </header>
      {notice && (
        <p role="alert" className="flex items-center gap-2 border-b border-line bg-card px-4 py-2 text-error">
          <span className="flex-1">{notice}</span>
          <button type="button" className="border-0 bg-transparent" onClick={() => setNotice(undefined)}>
            Dismiss
          </button>
        </p>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <section aria-label="Preview and timeline" className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
          {createElement("verdandi-player", {
            ref: player,
            src: `${connection.endpoint.base}/video/${projectId}/index.html`,
            className: "mx-auto rounded-md",
            // The composition's own shape once known, at most 60% of the window high: a portrait video isn't letterboxed.
            style: (() => {
              const [w, h] = manifest ? [manifest.width, manifest.height] : [16, 9];
              return { aspectRatio: `${w} / ${h}`, width: `min(100%, calc(60vh * ${w} / ${h}))` };
            })(),
          })}
          <PlayerEvents
            player={player}
            onReady={setManifest}
            onTime={(t, p) => {
              setTime(t);
              setPlaying(p);
            }}
          />
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => (playing ? player.current?.pause() : player.current?.play())} disabled={!manifest}>
              {playing ? "Pause" : "Play"}
            </button>
            <button type="button" onClick={() => player.current?.seek(0)} disabled={!manifest}>
              Start
            </button>
          </div>
          {manifest ? (
            <Timeline
              manifest={manifest}
              time={time}
              onSeek={(t) => player.current?.seek(t)}
              onMove={(clip, start) => void patchClip(clip, "data-start", seconds(start), `Move ${clip.id}`)}
              onTrim={(clip, d) => void patchClip(clip, "data-duration", seconds(d), `Trim ${clip.id}`)}
              selected={selected}
              onSelect={(clip) => setSelected(clip.id)}
              onToggleHidden={(clip) =>
                void patchClip(clip, "data-hidden", clip.hidden ? null : "", `${clip.hidden ? "Show" : "Hide"} ${clip.id}`)
              }
            />
          ) : (
            <p role="status" className="text-muted">
              Loading the composition…
            </p>
          )}
          {manifest &&
            (() => {
              const clip = manifest.clips.find((c) => c.id && c.id === selected);
              return clip ? (
                <Inspector clip={clip} manifest={manifest} onChange={(name, value, label) => void patchClip(clip, name, value, label)} />
              ) : null;
            })()}
          {manifest && (
            <Assets
              assets={assets}
              onError={setNotice}
              onUpload={async (file) => {
                const data = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
                  reader.onerror = () => reject(reader.error);
                  reader.readAsDataURL(file);
                });
                const result = await connection.video((rpc) => rpc.VideoAssetUpload({ projectId, name: file.name, data }));
                if (!result.ok) setNotice(result.message);
              }}
              onInsert={async (asset) => {
                const page = await connection.video((rpc) => rpc.VideoFileRead({ projectId, path: "index.html" }));
                if (!page.ok) return setNotice(page.message);
                const taken = new Set(manifest.clips.flatMap((c) => c.id ?? []));
                const track = Math.max(-1, ...manifest.clips.map((c) => c.track)) + 1;
                const { id, markup } = assetMarkup(asset, time, track, taken);
                const next = insertIntoComposition(page.value.content, manifest.id, markup);
                if (!next) return setNotice(`index.html has no element with data-composition-id="${manifest.id}" to put ${asset} in.`);
                await write("index.html", page.value.content, next, page.value.version, `Insert ${id}`);
              }}
            />
          )}
          <Renders
            jobs={[...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)}
            base={`${connection.endpoint.base}/video/${projectId}`}
            connection={connection}
          />
        </section>
        <section aria-label="Files" className="flex min-h-[50vh] flex-col border-t border-line lg:border-t-0 lg:border-l">
          <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
            <label htmlFor="video-file" className="sr-only">
              File
            </label>
            <select id="video-file" value={file?.path ?? ""} onChange={(e) => void read(e.target.value)} className="min-w-0 flex-1">
              {files.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
            <button type="button" onClick={() => void save()} disabled={!file || file.draft === file.saved}>
              {file && file.draft !== file.saved ? "Save" : "Saved"}
            </button>
          </div>
          {conflict && file && (
            <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-line bg-card px-3 py-2 text-warn">
              <span className="flex-1">{file.path} changed on disk while you were editing it.</span>
              <button
                type="button"
                onClick={() => {
                  setFile({ path: file.path, saved: conflict.content, draft: conflict.content, version: conflict.version });
                  setConflict(undefined);
                }}
              >
                Use theirs
              </button>
              <button
                type="button"
                onClick={() => {
                  // Saving next writes over theirs, on purpose.
                  setFile({ ...file, version: conflict.version });
                  setConflict(undefined);
                }}
              >
                Keep mine
              </button>
            </div>
          )}
          {file && (
            <div className="min-h-0 flex-1">
              <CodeEditor
                path={file.path}
                doc={file.draft}
                onChange={(draft) => setFile((f) => f && { ...f, draft })}
                onSave={() => void save()}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

/** Bridges the player element's DOM events into React. */
const PlayerEvents = ({
  player,
  onReady,
  onTime,
}: {
  player: React.RefObject<VerdandiPlayer | null>;
  onReady: (m: VideoManifest) => void;
  onTime: (t: number, playing: boolean) => void;
}) => {
  const handlers = useRef({ onReady, onTime });
  handlers.current = { onReady, onTime };
  useEffect(() => {
    const el = player.current;
    if (!el) return;
    const ready = (e: Event) => handlers.current.onReady((e as CustomEvent<VideoManifest>).detail);
    const time = (e: Event) => {
      const { time: t, playing } = (e as CustomEvent<{ time: number; playing: boolean }>).detail;
      handlers.current.onTime(t, playing);
    };
    const ended = () => handlers.current.onTime(el.currentTime, false);
    el.addEventListener("ready", ready);
    el.addEventListener("timeupdate", time);
    el.addEventListener("ended", ended);
    return () => {
      el.removeEventListener("ready", ready);
      el.removeEventListener("timeupdate", time);
      el.removeEventListener("ended", ended);
    };
  }, [player]);
  return null;
};

const formats: readonly VideoFormat[] = ["mp4", "webm", "mov", "gif", "png-sequence"];
const qualities: readonly VideoQuality[] = ["draft", "standard", "high"];

const RenderControls = ({
  connection,
  projectId,
  onError,
}: {
  connection: Connection;
  projectId: VideoProjectId;
  onError: (m: string) => void;
}) => {
  const [format, setFormat] = useState<VideoFormat>(() => (localStorage.getItem("verdandi.video.format") as VideoFormat | null) ?? "mp4");
  const [quality, setQuality] = useState<VideoQuality>("standard");
  const [fps, setFps] = useState(30);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        localStorage.setItem("verdandi.video.format", format);
        const result = await connection.video((rpc) => rpc.VideoRenderStart({ projectId, format, quality, fps }));
        if (!result.ok) onError(result.message);
      }}
    >
      <label className="sr-only" htmlFor="render-format">
        Format
      </label>
      <select id="render-format" value={format} onChange={(e) => setFormat(e.target.value as VideoFormat)}>
        {formats.map((f) => (
          <option key={f}>{f}</option>
        ))}
      </select>
      <label className="sr-only" htmlFor="render-quality">
        Quality
      </label>
      <select id="render-quality" value={quality} onChange={(e) => setQuality(e.target.value as VideoQuality)}>
        {qualities.map((q) => (
          <option key={q}>{q}</option>
        ))}
      </select>
      <label className="sr-only" htmlFor="render-fps">
        Frames per second
      </label>
      <select id="render-fps" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
        {[24, 30, 60].map((n) => (
          <option key={n} value={n}>
            {n} fps
          </option>
        ))}
      </select>
      <button type="submit" className="bg-go text-on-go hover:bg-go-hover">
        Render
      </button>
    </form>
  );
};

const stageLabel: Record<string, string> = {
  open: "Opening",
  extract: "Decoding videos",
  audio: "Mixing audio",
  capture: "Capturing",
  encode: "Encoding",
};

const Renders = ({ jobs, base, connection }: { jobs: readonly VideoRenderJob[]; base: string; connection: Connection }) =>
  jobs.length === 0 ? null : (
    <section aria-label="Renders">
      <h2 className="eyebrow mb-1 text-muted">Renders</h2>
      <ul className="flex flex-col gap-1">
        {jobs.map((j) => (
          <li key={j.jobId} className="flex items-center gap-3 rounded-md border border-line bg-card px-3 py-2">
            <span className="w-20 shrink-0 text-muted">{j.format}</span>
            {j.status === "rendering" ? (
              <>
                <span className="w-32 shrink-0" role="status">
                  {stageLabel[j.stage] ?? j.stage}
                  {j.stage === "capture" && ` ${j.done}/${j.total}`}
                </span>
                {/* Determinate only: an indeterminate bar animates forever and says nothing true. */}
                {j.stage === "capture" ? (
                  <progress
                    className="h-2 flex-1"
                    max={j.total || 1}
                    value={j.done}
                    aria-label={`${j.done} of ${j.total} frames captured`}
                  />
                ) : (
                  <span className="flex-1" />
                )}
                <button type="button" onClick={() => void connection.video((rpc) => rpc.VideoRenderCancel({ jobId: j.jobId }))}>
                  Cancel
                </button>
              </>
            ) : j.status === "done" && j.output ? (
              <a className="min-w-0 flex-1 truncate" href={`${base}/${j.output.replaceAll("\\", "/")}`} target="_blank" rel="noreferrer">
                {j.output}
              </a>
            ) : (
              <span className={`min-w-0 flex-1 ${j.status === "failed" ? "text-error" : "text-muted"}`}>
                {j.status === "failed" ? j.error : "Cancelled"}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );

/** Over this, a file goes into assets/ by hand (a message carries at most this much). */
const uploadLimit = 14 * 1024 * 1024;

/** The project's media, uploaded into assets/ and put on a new track at the playhead with Insert. */
const Assets = ({
  assets,
  onUpload,
  onInsert,
  onError,
}: {
  assets: readonly string[];
  onError: (message: string) => void;
  onUpload: (file: File) => Promise<void>;
  onInsert: (asset: string) => Promise<void>;
}) => {
  const [busy, setBusy] = useState<string>();
  return (
    <section aria-label="Assets">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="eyebrow flex-1 text-muted">Assets</h2>
        <label className="cursor-pointer rounded-md border border-line px-2 py-1 text-xs hover:bg-hover">
          {busy ? `Uploading ${busy}…` : "Upload"}
          <input
            type="file"
            className="sr-only"
            accept="video/*,audio/*,image/*"
            multiple
            disabled={!!busy}
            onChange={async (e) => {
              const list = [...(e.target.files ?? [])];
              e.target.value = "";
              for (const file of list) {
                if (file.size > uploadLimit) {
                  onError(`${file.name} is over 14 MB: copy it into the project's assets/ folder instead; it shows up here.`);
                  continue;
                }
                setBusy(file.name);
                await onUpload(file);
              }
              setBusy(undefined);
            }}
          />
        </label>
      </div>
      {assets.length === 0 ? (
        <p className="text-xs text-muted">No media in assets/ yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {assets.map((a) => (
            <li key={a} className="flex items-center gap-2 rounded-md border border-line bg-card px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate">{a.replace(/^assets\//, "")}</span>
              <button type="button" className="text-xs" onClick={() => void onInsert(a)} title="Put it on a new track at the playhead">
                Insert
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
