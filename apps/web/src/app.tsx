import {
  type CommandId,
  describeCost,
  describeQuota,
  type ProjectSummary,
  type QuotaView,
  type ThreadId,
  type ThreadSummary,
} from "@verdandi/contracts";
import { type FormEvent, useEffect, useState, useSyncExternalStore } from "react";
import { ArchiveButton } from "./archive.tsx";
import { type Connection, createStore, useStore, uuid } from "./client.ts";
import { applyProjectsFeed, type Sidebar as SidebarData } from "./state.ts";
import { ThreadPane } from "./thread.tsx";

/** The open thread lives in the URL hash (`#thread=<id>`), so links, Back and reloads just work. */
const hashThread = () => new URLSearchParams(location.hash.slice(1)).get("thread") as ThreadId | null;
const onHashChange = (listener: () => void) => {
  addEventListener("hashchange", listener);
  return () => removeEventListener("hashchange", listener);
};
export const openThread = (threadId: ThreadId) => {
  location.hash = `thread=${threadId}`;
};

export const App = ({ connection }: { connection: Connection }) => {
  const [sidebar] = useState(() => createStore<SidebarData | undefined>(undefined));
  const threadId = useSyncExternalStore(onHashChange, hashThread);
  const lost = useStore(connection.lost);
  // Showing archived threads asks verdandid for a feed that includes them; hiding them goes back to one that doesn't.
  const [archived, setArchived] = useState(false);
  useEffect(() => {
    // A message the previous feed sends after this one started must not be folded in with the new setting.
    let current = true;
    const stop = connection.follow(
      (rpc, subscriptionId) => rpc.ProjectsSubscribe({ subscriptionId, archived }),
      (feed) => current && sidebar.set(applyProjectsFeed(sidebar.get(), feed, archived)),
      () => {},
    );
    return () => {
      current = false;
      stop();
    };
  }, [connection, sidebar, archived]);
  return (
    <div className="grid h-screen grid-cols-[260px_1fr]">
      {lost && (
        <div role="alert" className="fixed inset-x-0 top-0 z-10 bg-error px-4 py-2 text-bg">
          Lost the connection to verdandid.{" "}
          <button type="button" className="mx-1" onClick={() => location.reload()}>
            Reconnect
          </button>{" "}
          If verdandid restarted, run <code>verdandi open</code> again.
        </div>
      )}
      <Sidebar connection={connection} data={useStore(sidebar)} current={threadId} archived={archived} onArchived={setArchived} />
      <main className="flex min-h-0 min-w-0 flex-col">
        {threadId ? (
          <ThreadPane key={threadId} connection={connection} threadId={threadId} />
        ) : (
          <p className="p-6 text-muted">Pick a thread on the left.</p>
        )}
      </main>
    </div>
  );
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const Sidebar = ({
  connection,
  data,
  current,
  archived,
  onArchived,
}: {
  connection: Connection;
  data: SidebarData | undefined;
  current: ThreadId | null;
  archived: boolean;
  onArchived: (archived: boolean) => void;
}) => {
  if (!data) return <nav aria-label="Projects and threads" className="overflow-y-auto border-r border-line bg-panel p-2" />;
  // Projects with the most recent activity first; `data.threads` is already in that order.
  const byProject = Map.groupBy(data.threads, (t) => t.projectId);
  const projects = data.projects.toSorted(
    (a, b) => data.threads.findIndex((t) => t.projectId === a.projectId) - data.threads.findIndex((t) => t.projectId === b.projectId),
  );
  return (
    <nav aria-label="Projects and threads" className="overflow-y-auto border-r border-line bg-panel p-2">
      <Quotas quotas={data.quotas} />
      <OpenFolder connection={connection} />
      <label className="mx-1 mt-2 block text-xs text-muted">
        <input type="checkbox" checked={archived} onChange={(e) => onArchived(e.target.checked)} />
        Show archived threads
      </label>
      {projects.length === 0 && (
        <p className="m-1 text-muted">
          No threads yet. Open a project folder above, or run <code>verdandi chat</code> in one.
        </p>
      )}
      {projects.map((project) => (
        <Project
          key={project.projectId}
          connection={connection}
          project={project}
          threads={byProject.get(project.projectId) ?? []}
          current={current}
        />
      ))}
    </nav>
  );
};

const resetTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Each harness's subscription window, as it last reported it. A live region, so a switch to extra usage is announced. */
const Quotas = ({ quotas }: { quotas: readonly QuotaView[] }) => (
  <div role="status">
    {quotas.map((q) => (
      <p
        key={q.harness}
        className={`mx-1 mb-2 text-xs ${q.quota.usingOverage || q.quota.status !== "allowed" ? "text-error" : "text-muted"}`}
      >
        {describeQuota(q, resetTime)}
      </p>
    ))}
  </div>
);

/** Starts a thread in any folder; verdandid checks the path and resolves it, so a known folder gets a new thread, not a new project. */
const OpenFolder = ({ connection }: { connection: Connection }) => {
  const [error, setError] = useState<string>();
  const open = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const projectPath = String(new FormData(form).get("path")).trim();
    if (!projectPath) return;
    const threadId = uuid<ThreadId>();
    const result = await connection.dispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId, projectPath });
    setError(result.ok ? undefined : result.message);
    if (!result.ok) return;
    form.reset();
    openThread(threadId);
  };
  return (
    <form onSubmit={open}>
      <label htmlFor="open-folder-path" className="mx-1 mb-1 block text-xs text-muted">
        Open folder
      </label>
      <div className="flex gap-1">
        <input
          id="open-folder-path"
          type="text"
          name="path"
          placeholder="Full path to a project folder"
          required
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1"
          aria-invalid={error !== undefined}
          aria-describedby={error ? "open-folder-error" : undefined}
        />
        <button type="submit">Open</button>
      </div>
      {error && (
        <p id="open-folder-error" role="alert" className="m-1 text-error [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </form>
  );
};

const Project = ({
  connection,
  project,
  threads,
  current,
}: {
  connection: Connection;
  project: ProjectSummary;
  threads: readonly ThreadSummary[];
  current: ThreadId | null;
}) => {
  const [error, setError] = useState<string>();
  // Without a route, the router picks one for each task of the new thread.
  const newThread = async () => {
    const threadId = uuid<ThreadId>();
    const result = await connection.dispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId, projectPath: project.path });
    if (result.ok) openThread(threadId);
    else setError(result.message);
  };
  const headingId = `project-${project.projectId}`;
  return (
    <section aria-labelledby={headingId}>
      <div className="mt-3 flex items-center justify-between">
        <h2 id={headingId} title={project.path} className="mx-1 truncate text-xs font-bold uppercase tracking-[0.04em] text-muted">
          {basename(project.path)}
        </h2>
        <button type="button" className="px-2 py-0 text-xs" onClick={newThread} aria-label={`New thread in ${basename(project.path)}`}>
          New
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <ul className="my-1">
        {threads.map((t) => (
          <li key={t.threadId} className="group relative flex items-start gap-1">
            <a
              href={`#thread=${t.threadId}`}
              aria-current={t.threadId === current ? "page" : undefined}
              className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2 rounded px-2 py-1 hover:bg-line aria-[current=page]:bg-user"
            >
              <span className={`flex-1 truncate ${t.archived ? "text-muted" : ""}`}>{t.title || "New thread"}</span>
              {t.busy && <span className="text-xs text-accent">working</span>}
              {t.archived && <span className="text-xs text-muted">archived</span>}
              {describeCost(t.cost) && (
                <span
                  className="basis-full text-xs text-muted"
                  title="Paid: metered usage. On plan: subscription usage valued at API prices, covered by your plan."
                >
                  {describeCost(t.cost)}
                </span>
              )}
            </a>
            {/* Shown on hover or keyboard focus, except Unarchive, which an archived thread always shows. */}
            {!t.busy && (
              <ArchiveButton
                connection={connection}
                threadId={t.threadId}
                archived={t.archived}
                title={t.title || "New thread"}
                className={t.archived ? "mt-1" : "absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}
                onError={setError}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
