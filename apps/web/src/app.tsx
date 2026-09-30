import type { CommandId, ProjectSummary, ThreadId, ThreadSummary } from "@verdandi/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
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
      {projects.length === 0 && (
        <p className="muted">
          No threads yet. Start one with <code>verdandi chat</code> in a project folder.
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
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
};
