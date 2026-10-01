import {
  type CommandId,
  describeCost,
  describeQuota,
  type ProjectSummary,
  type QuotaView,
  type ThreadId,
  type ThreadSummary,
} from "@verdandi/contracts";
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArchiveButton } from "./archive.tsx";
import { type Connection, createStore, useStore, uuid } from "./client.ts";
import { Dashboard } from "./dashboard.tsx";
import { BranchIcon, ChartIcon, CloseIcon, FolderIcon, MenuIcon, PlusIcon } from "./icons.tsx";
import { applyProjectsFeed, type Sidebar as SidebarData } from "./state.ts";
import { ThreadPane } from "./thread.tsx";

/** The open thread lives in the URL hash (`#thread=<id>`), so links, Back and reloads just work. */
const hashThread = () => new URLSearchParams(location.hash.slice(1)).get("thread") as ThreadId | null;
/** `#view=spend` opens the spend dashboard instead of a thread. */
const hashView = () => new URLSearchParams(location.hash.slice(1)).get("view");
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
  const view = useSyncExternalStore(onHashChange, hashView);
  const data = useStore(sidebar);
  const lost = useStore(connection.lost);
  // Showing archived threads asks verdandid for a feed that includes them; hiding them goes back to one that doesn't.
  const [archived, setArchived] = useState(false);
  // Below the md breakpoint the sidebar is a drawer over the page; it closes on navigation and on Escape.
  const [navOpen, setNavOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigating is the trigger, not an input.
  useEffect(() => setNavOpen(false), [threadId, view]);
  const closeNav = () => {
    setNavOpen(false);
    menuButton.current?.focus();
  };
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
    <div className="flex h-dvh">
      {/* The hash holds the open thread, so skipping moves focus rather than following a link. */}
      <button
        type="button"
        onClick={() => document.getElementById("main")?.focus()}
        className="sr-only z-50 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to main content
      </button>
      {lost && (
        <div role="alert" className="fixed inset-x-0 top-0 z-50 flex flex-wrap items-center gap-x-2 bg-error px-4 py-2 text-bg">
          Lost the connection to verdandid.
          <button type="button" className="border-bg bg-bg px-2 text-fg" onClick={() => location.reload()}>
            Reconnect
          </button>
          If verdandid restarted, run <code>verdandi open</code> again.
        </div>
      )}
      {navOpen && (
        // Clicking beside the drawer closes it; keyboard users have Escape and the Close button.
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={-1}
          className="fixed inset-0 z-30 rounded-none border-0 bg-bg/80 hover:bg-bg/80 md:hidden"
          onClick={closeNav}
        />
      )}
      <Sidebar
        connection={connection}
        data={data}
        current={view === "spend" ? null : threadId}
        spend={view === "spend"}
        archived={archived}
        onArchived={setArchived}
        open={navOpen}
        onClose={closeNav}
      />
      <main id="main" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 md:hidden">
          <button
            ref={menuButton}
            type="button"
            aria-label="Open menu"
            aria-expanded={navOpen}
            className="border-0 bg-transparent px-2"
            onClick={() => setNavOpen(true)}
          >
            <MenuIcon />
          </button>
          <Wordmark />
        </div>
        {view === "spend" ? (
          <Dashboard connection={connection} projects={data?.projects ?? []} />
        ) : threadId ? (
          <ThreadPane key={threadId} connection={connection} threadId={threadId} />
        ) : (
          <div className="grid flex-1 place-items-center p-6">
            <div className="max-w-sm text-center">
              <h1 className="font-mono text-sm font-semibold">No thread open</h1>
              <p className="mt-1 text-muted">Pick a thread from the list, or open a project folder to start one.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

const Wordmark = () => <span className="font-mono text-sm font-semibold tracking-tight">verdandi</span>;

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Marks the current page's link: a raised card with a hairline edge. */
const currentLink = "hover:bg-hover aria-[current=page]:bg-card aria-[current=page]:shadow-[inset_0_0_0_1px_var(--color-line)]";

const Sidebar = ({
  connection,
  data,
  current,
  spend,
  archived,
  onArchived,
  open,
  onClose,
}: {
  connection: Connection;
  data: SidebarData | undefined;
  current: ThreadId | null;
  /** Whether the spend dashboard is open. */
  spend: boolean;
  archived: boolean;
  onArchived: (archived: boolean) => void;
  /** Whether the drawer is open, on screens too narrow to show the sidebar beside the page. */
  open: boolean;
  onClose: () => void;
}) => {
  const nav = useRef<HTMLElement>(null);
  // Focus moves into the drawer when it opens, so keyboard users land in it.
  useEffect(() => {
    if (open) nav.current?.focus();
  }, [open]);
  return (
    <nav
      ref={nav}
      aria-label="Projects and threads"
      tabIndex={-1}
      onKeyDown={(e) => open && e.key === "Escape" && onClose()}
      className={`${open ? "fixed inset-y-0 left-0 z-40 flex shadow-2xl" : "hidden"} w-72 max-w-[85vw] shrink-0 flex-col border-r border-line bg-panel outline-none md:static md:flex md:max-w-none md:shadow-none`}
    >
      <div className="flex h-12 shrink-0 items-center justify-between px-4">
        <Wordmark />
        <button type="button" aria-label="Close menu" className="border-0 bg-transparent px-2 md:hidden" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {data && (
        <SidebarBody connection={connection} data={data} current={current} spend={spend} archived={archived} onArchived={onArchived} />
      )}
    </nav>
  );
};

const SidebarBody = ({
  connection,
  data,
  current,
  spend,
  archived,
  onArchived,
}: {
  connection: Connection;
  data: SidebarData;
  current: ThreadId | null;
  spend: boolean;
  archived: boolean;
  onArchived: (archived: boolean) => void;
}) => {
  // Projects with the most recent activity first; `data.threads` is already in that order.
  const byProject = Map.groupBy(data.threads, (t) => t.projectId);
  const projects = data.projects.toSorted(
    (a, b) => data.threads.findIndex((t) => t.projectId === a.projectId) - data.threads.findIndex((t) => t.projectId === b.projectId),
  );
  return (
    <div className="flex-1 overflow-y-auto px-2 pb-4">
      <a
        href="#view=spend"
        aria-current={spend ? "page" : undefined}
        className={`flex items-center gap-2 rounded-md px-2 py-1.5 font-medium ${currentLink}`}
      >
        <ChartIcon className="text-muted" />
        Spend dashboard
      </a>
      <Quotas quotas={data.quotas} />
      <OpenFolder connection={connection} />
      <div className="mt-5 mb-1 flex items-center justify-between gap-2 px-2">
        <h2 className="font-mono text-[11px] font-semibold tracking-wider text-muted uppercase">Projects</h2>
        <label className="text-xs text-muted">
          <input type="checkbox" checked={archived} onChange={(e) => onArchived(e.target.checked)} />
          Show archived
        </label>
      </div>
      {projects.length === 0 && (
        <p className="mx-2 text-muted">
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
    </div>
  );
};

const resetTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Each harness's subscription window, as it last reported it. A live region, so a switch to extra usage is announced. */
const Quotas = ({ quotas }: { quotas: readonly QuotaView[] }) => (
  <div role="status" className="mt-1">
    {quotas.map((q) => {
      const alert = q.quota.usingOverage || q.quota.status !== "allowed";
      return (
        <p key={q.harness} className={`flex gap-2 px-2 py-1 text-xs ${alert ? "text-error" : "text-muted"}`}>
          <span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${alert ? "bg-error" : "bg-ok"}`} />
          {describeQuota(q, resetTime)}
        </p>
      );
    })}
  </div>
);

/** Starts a thread in any folder; verdandid checks the path and resolves it, so a known folder gets a new thread, not a new project. */
const OpenFolder = ({ connection }: { connection: Connection }) => {
  const [error, setError] = useState<string>();
  const open = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const projectPath = String(data.get("path")).trim();
    if (!projectPath) return;
    const threadId = uuid<ThreadId>();
    const worktree = data.get("worktree") === "on";
    const result = await connection.dispatch({
      type: "thread.create",
      commandId: uuid<CommandId>(),
      threadId,
      projectPath,
      ...(worktree && { worktree }),
    });
    setError(result.ok ? undefined : result.message);
    if (!result.ok) return;
    form.reset();
    openThread(threadId);
  };
  return (
    <form onSubmit={open} className="mt-3 px-2">
      <label htmlFor="open-folder-path" className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
        <FolderIcon className="size-3.5" />
        Open folder
      </label>
      <div className="flex gap-1.5">
        <input
          id="open-folder-path"
          type="text"
          name="path"
          placeholder="Full path to a project folder"
          required
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 font-mono text-xs"
          aria-invalid={error !== undefined}
          aria-describedby={error ? "open-folder-error" : undefined}
        />
        <button type="submit">Open</button>
      </div>
      <label className="mt-1 flex items-center gap-1.5 text-xs text-muted">
        <input type="checkbox" name="worktree" />
        In a git worktree of its own
      </label>
      {error && (
        <p id="open-folder-error" role="alert" className="mt-1 text-xs text-error [overflow-wrap:anywhere]">
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
  const newThread = async (worktree: boolean) => {
    const threadId = uuid<ThreadId>();
    const result = await connection.dispatch({
      type: "thread.create",
      commandId: uuid<CommandId>(),
      threadId,
      projectPath: project.path,
      ...(worktree && { worktree }),
    });
    if (result.ok) openThread(threadId);
    else setError(result.message);
  };
  const headingId = `project-${project.projectId}`;
  return (
    <section aria-labelledby={headingId} className="mt-3">
      <div className="flex items-center justify-between gap-2 pl-2">
        <h3 id={headingId} title={project.path} className="truncate font-mono text-xs font-semibold">
          {basename(project.path)}
        </h3>
        <span className="flex shrink-0">
          <button
            type="button"
            className="gap-1 border-0 bg-transparent px-1.5 text-xs text-muted hover:text-fg"
            onClick={() => newThread(false)}
            aria-label={`New thread in ${basename(project.path)}`}
          >
            <PlusIcon className="size-3.5" />
            New
          </button>
          <button
            type="button"
            className="gap-1 border-0 bg-transparent px-1.5 text-xs text-muted hover:text-fg"
            onClick={() => newThread(true)}
            aria-label={`New thread in a git worktree of ${basename(project.path)}`}
            title="New thread in a git worktree of its own"
          >
            <BranchIcon className="size-3.5" />
            Worktree
          </button>
        </span>
      </div>
      {error && (
        <p role="alert" className="mx-2 text-xs text-error">
          {error}
        </p>
      )}
      <ul className="mt-0.5">
        {threads.map((t) => (
          <li key={t.threadId} className="group relative flex items-center gap-1">
            <a
              href={`#thread=${t.threadId}`}
              aria-current={t.threadId === current ? "page" : undefined}
              className={`flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 ${currentLink}`}
            >
              <span className={`truncate ${t.archived ? "text-muted" : ""}`}>{t.title || "New thread"}</span>
              {(t.busy || t.archived || describeCost(t.cost)) && (
                <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                  {t.busy && (
                    <span className="flex items-center gap-1 text-accent">
                      <span aria-hidden className="size-1.5 rounded-full bg-accent" />
                      working
                    </span>
                  )}
                  {t.archived && <span>archived</span>}
                  {describeCost(t.cost) && (
                    <span
                      className="tabular-nums"
                      title="Paid: metered usage. On plan: subscription usage valued at API prices, covered by your plan."
                    >
                      {describeCost(t.cost)}
                    </span>
                  )}
                </span>
              )}
            </a>
            {/* With a mouse, Archive shows over the row on hover or keyboard focus; on touch screens, and for Unarchive, it sits beside it. */}
            {!t.busy && (
              <ArchiveButton
                connection={connection}
                threadId={t.threadId}
                archived={t.archived}
                title={t.title || "New thread"}
                className={`shrink-0 ${t.archived ? "" : "pointer-fine:absolute pointer-fine:top-1 pointer-fine:right-1 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100"}`}
                onError={setError}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
