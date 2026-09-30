import {
  type CommandId,
  defaultRoute,
  describeCost,
  describeQuota,
  type ProjectSummary,
  type QuotaView,
  type Route,
  type ThreadId,
  type ThreadSummary,
} from "@verdandi/contracts";
import { type FormEvent, useEffect, useState, useSyncExternalStore } from "react";
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
  useEffect(
    () =>
      connection.follow(
        (rpc, subscriptionId) => rpc.ProjectsSubscribe({ subscriptionId }),
        (feed) => sidebar.set(applyProjectsFeed(sidebar.get(), feed)),
        () => {},
      ),
    [connection, sidebar],
  );
  return (
    <div className="app">
      {lost && (
        <div role="alert" className="banner">
          Lost the connection to verdandid.{" "}
          <button type="button" onClick={() => location.reload()}>
            Reconnect
          </button>{" "}
          If verdandid restarted, run <code>verdandi open</code> again.
        </div>
      )}
      <Sidebar connection={connection} data={useStore(sidebar)} current={threadId} />
      <main className="main">
        {threadId ? (
          <ThreadPane key={threadId} connection={connection} threadId={threadId} />
        ) : (
          <p className="empty">Pick a thread on the left.</p>
        )}
      </main>
    </div>
  );
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const Sidebar = ({ connection, data, current }: { connection: Connection; data: SidebarData | undefined; current: ThreadId | null }) => {
  if (!data) return <nav aria-label="Projects and threads" className="sidebar" />;
  // Projects with the most recent activity first; `data.threads` is already in that order.
  const byProject = Map.groupBy(data.threads, (t) => t.projectId);
  const projects = data.projects.toSorted(
    (a, b) => data.threads.findIndex((t) => t.projectId === a.projectId) - data.threads.findIndex((t) => t.projectId === b.projectId),
  );
  return (
    <nav aria-label="Projects and threads" className="sidebar">
      <Quotas quotas={data.quotas} />
      <OpenFolder connection={connection} route={data.threads[0]?.route ?? defaultRoute} />
      {projects.length === 0 && (
        <p className="muted">
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
  <div role="status" className="quotas">
    {quotas.map((q) => (
      <p key={q.harness} className={q.quota.usingOverage || q.quota.status !== "allowed" ? "quota warn" : "quota"}>
        {describeQuota(q, resetTime)}
      </p>
    ))}
  </div>
);

/** Starts a thread in any folder; verdandid checks the path and resolves it, so a known folder gets a new thread, not a new project. */
const OpenFolder = ({ connection, route }: { connection: Connection; route: Route }) => {
  const [error, setError] = useState<string>();
  const open = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const projectPath = String(new FormData(form).get("path")).trim();
    if (!projectPath) return;
    const threadId = uuid<ThreadId>();
    const result = await connection.dispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId, projectPath, route });
    setError(result.ok ? undefined : result.message);
    if (!result.ok) return;
    form.reset();
    openThread(threadId);
  };
  return (
    <form className="open-folder" onSubmit={open}>
      <label htmlFor="open-folder-path">Open folder</label>
      <div>
        <input
          id="open-folder-path"
          type="text"
          name="path"
          placeholder="Full path to a project folder"
          required
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== undefined}
          aria-describedby={error ? "open-folder-error" : undefined}
        />
        <button type="submit">Open</button>
      </div>
      {error && (
        <p id="open-folder-error" role="alert" className="error">
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
  const latest = threads[0];
  // A new thread starts on the route of the project's latest one, like `verdandi chat` does per folder.
  const newThread = async () => {
    if (!latest) return;
    const threadId = uuid<ThreadId>();
    const result = await connection.dispatch({
      type: "thread.create",
      commandId: uuid<CommandId>(),
      threadId,
      projectPath: project.path,
      route: latest.route,
    });
    if (result.ok) openThread(threadId);
    else setError(result.message);
  };
  const headingId = `project-${project.projectId}`;
  return (
    <section aria-labelledby={headingId}>
      <div className="project">
        <h2 id={headingId} title={project.path}>
          {basename(project.path)}
        </h2>
        <button type="button" onClick={newThread} disabled={!latest} aria-label={`New thread in ${basename(project.path)}`}>
          New
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <ul>
        {threads.map((t) => (
          <li key={t.threadId}>
            <a href={`#thread=${t.threadId}`} aria-current={t.threadId === current ? "page" : undefined}>
              <span className="title">{t.title || "New thread"}</span>
              {t.busy && <span className="busy">working</span>}
              {describeCost(t.cost) && (
                <span
                  className="thread-cost"
                  title="Paid: metered usage. On plan: subscription usage valued at API prices, covered by your plan."
                >
                  {describeCost(t.cost)}
                </span>
              )}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
};
