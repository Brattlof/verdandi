import { Dialog } from "@base-ui/react/dialog";
import {
  type CommandId,
  describeCost,
  describeQuota,
  type ProjectSummary,
  type QuotaView,
  type ThreadId,
  type ThreadSummary,
  type TurnId,
} from "@verdandi/contracts";
import { type FormEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type Connection, createStore, useStore, uuid } from "./client.ts";
import { SearchPage } from "./search/search.tsx";
import { Dashboard } from "./spend/dashboard.tsx";
import { applyProjectsFeed, groupByRecency, type Sidebar as SidebarData } from "./state.ts";
import { ArchiveButton } from "./threads/archive.tsx";
import { ThreadPane } from "./threads/thread.tsx";
import { TrustedCommandsList } from "./trust/trusted.tsx";
import { Engraving, Plait, Raven } from "./ui/art.tsx";
import { BranchIcon, CloseIcon, FolderIcon, MenuIcon } from "./ui/icons.tsx";
import { Rune, RuneMark, type RuneName, RuneText } from "./ui/runes.tsx";

/** The open thread lives in the URL hash (`#thread=<id>`), so links, Back and reloads just work. */
const hashThread = () => new URLSearchParams(location.hash.slice(1)).get("thread") as ThreadId | null;
/**
 * `#view=spend` opens the spend dashboard instead of a thread, `#view=search` the search page; `#view=projects`, or no
 * thread and no view, the projects page.
 */
const hashView = () => new URLSearchParams(location.hash.slice(1)).get("view");
const onHashChange = (listener: () => void) => {
  addEventListener("hashchange", listener);
  return () => removeEventListener("hashchange", listener);
};
/** `#thread=<id>&turn=<id>` scrolls the thread to that turn: where a search result points. */
const hashTurn = () => new URLSearchParams(location.hash.slice(1)).get("turn") as TurnId | null;
export const openThread = (threadId: ThreadId) => {
  location.hash = `thread=${threadId}`;
};

/** Starts a thread in a folder, routed by the router, and opens it; the result says why not if verdandid refused. */
const startThread = async (connection: Connection, projectPath: string, worktree: boolean) => {
  const threadId = uuid<ThreadId>();
  const result = await connection.dispatch({
    type: "thread.create",
    commandId: uuid<CommandId>(),
    threadId,
    projectPath,
    ...(worktree && { worktree }),
  });
  if (result.ok) openThread(threadId);
  return result;
};

type Page = "home" | "thread" | "spend" | "search";

export const App = ({ connection }: { connection: Connection }) => {
  const [sidebar] = useState(() => createStore<SidebarData | undefined>(undefined));
  const threadId = useSyncExternalStore(onHashChange, hashThread);
  const view = useSyncExternalStore(onHashChange, hashView);
  const turn = useSyncExternalStore(onHashChange, hashTurn);
  const page: Page = view === "spend" || view === "search" ? view : threadId ? "thread" : "home";
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
      (feed) => {
        if (current) sidebar.set(applyProjectsFeed(sidebar.get(), feed, archived));
      },
      () => {},
    );
    return () => {
      current = false;
      stop();
    };
  }, [connection, sidebar, archived]);
  const currentThread = threadId ? data?.threads.find((t) => t.threadId === threadId) : undefined;
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
          {connection.endpoint.reconnectHint}
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
      <Rail page={page} />
      <Sidebar
        connection={connection}
        data={data}
        page={page}
        current={page === "thread" ? threadId : null}
        currentProject={currentThread?.projectId}
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
        {page === "spend" ? (
          <Dashboard connection={connection} projects={data?.projects ?? []} />
        ) : page === "search" ? (
          <SearchPage connection={connection} />
        ) : threadId ? (
          <ThreadPane key={threadId} connection={connection} threadId={threadId} focusTurn={turn} />
        ) : (
          <Home connection={connection} data={data} />
        )}
      </main>
    </div>
  );
};

/** The mark, the name, and the name in runes beneath it. `rail`: the rail beside it already shows the mark, on wider screens. */
const Wordmark = ({ rail = false }: { rail?: boolean }) => (
  <span className="flex items-center gap-2">
    <RuneMark className={`size-7 ${rail ? "md:hidden" : ""}`} />
    <span className="flex flex-col gap-1">
      <span className="font-serif text-xl leading-none font-semibold tracking-tight">Verdandi</span>
      <RuneText className="h-2 text-rune" />
    </span>
  </span>
);

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** The current page's link or button: the pale sky surface, as in the sidebar reference. */
const currentItem = "hover:bg-hover aria-[current=page]:bg-user aria-[current=page]:font-medium";

/** Rail links: a rune over its name; the current page on the sky surface. */
const railItem = `flex h-14 w-14 flex-col items-center justify-center gap-1.5 rounded-md border-0 bg-transparent p-0 text-muted hover:text-fg aria-[current=page]:text-accent ${currentItem}`;

/** A rail entry's rune and name; the rune's own name and meaning show on hover. */
const RailLabel = ({ rune, label }: { rune: RuneName; label: string }) => (
  <>
    <Rune name={rune} className="size-5" />
    <span className="text-[10px] leading-none font-semibold tracking-[0.08em] uppercase">{label}</span>
  </>
);

/**
 * The narrow column of pages beside the threads sidebar, on screens wide enough for both.
 */
const Rail = ({ page }: { page: Page }) => (
  <nav aria-label="Main" className="hidden w-[72px] shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-3 md:flex">
    <RuneMark className="mb-4 size-8" />
    <a href="#view=projects" title="Projects (ingwaz: the hearth)" aria-current={page === "home" ? "page" : undefined} className={railItem}>
      <RailLabel rune="ingwaz" label="Projects" />
    </a>
    <a
      href="#view=search"
      aria-label="Search past sessions"
      title="Search past sessions (kenaz: the torch)"
      aria-current={page === "search" ? "page" : undefined}
      className={railItem}
    >
      <RailLabel rune="kenaz" label="Search" />
    </a>
    <a
      href="#view=spend"
      aria-label="Spend dashboard"
      title="Spend dashboard (fehu: wealth)"
      aria-current={page === "spend" ? "page" : undefined}
      className={railItem}
    >
      <RailLabel rune="fehu" label="Spend" />
    </a>
  </nav>
);

const Sidebar = ({
  connection,
  data,
  page,
  current,
  currentProject,
  archived,
  onArchived,
  open,
  onClose,
}: {
  connection: Connection;
  data: SidebarData | undefined;
  page: Page;
  current: ThreadId | null;
  /** The open thread's project, marked in New thread's list. */
  currentProject: ThreadSummary["projectId"] | undefined;
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
      aria-label="Threads"
      tabIndex={-1}
      // A dialog opened from the sidebar renders outside it, but React still bubbles its keys here.
      onKeyDown={(e) => open && e.key === "Escape" && nav.current?.contains(e.target as Node) && onClose()}
      className={`${open ? "fixed inset-y-0 left-0 z-40 flex shadow-2xl" : "hidden"} w-72 max-w-[85vw] shrink-0 flex-col border-r border-line bg-panel outline-none md:static md:flex md:w-64 md:max-w-none md:shadow-none`}
    >
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 pr-2 pl-4">
        <Wordmark rail />
        <button type="button" aria-label="Close menu" className={`${ghostIcon} md:hidden`} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="px-2">
        <NewThread connection={connection} data={data} current={currentProject} />
        {/* Below md the rail is hidden, so the drawer carries its pages. */}
        {pages.map((p) => (
          <a
            key={p.page}
            href={`#view=${p.view}`}
            aria-current={page === p.page ? "page" : undefined}
            className={`${row} ${currentItem} md:hidden`}
          >
            <Rune name={p.rune} className="text-muted" />
            {p.label}
          </a>
        ))}
      </div>
      <div className="mt-2 flex-1 overflow-y-auto px-2 pb-3">
        {data && <ThreadList connection={connection} data={data} current={current} />}
      </div>
      <footer className="px-4 pb-2">
        <Plait surface="stroke-panel" className="mb-1 text-line-strong" />
        {data && <Quotas quotas={data.quotas} />}
        <label className="flex items-center py-1 text-xs text-muted">
          <input type="checkbox" checked={archived} onChange={(e) => onArchived(e.target.checked)} />
          Show archived threads
        </label>
      </footer>
    </nav>
  );
};

const pages = [
  { page: "home", view: "projects", rune: "ingwaz", label: "Projects" },
  { page: "search", view: "search", rune: "kenaz", label: "Search past sessions" },
  { page: "spend", view: "spend", rune: "fehu", label: "Spend dashboard" },
] as const satisfies readonly { page: Page; view: string; rune: RuneName; label: string }[];

const row = "flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5";
const ghostIcon = "size-9 border-0 bg-transparent p-0 text-muted hover:text-fg";

/** Picks a project, or any folder, in a dialog and starts a thread there. */
const NewThread = ({
  connection,
  data,
  current,
}: {
  connection: Connection;
  data: SidebarData | undefined;
  current: ProjectSummary["projectId"] | undefined;
}) => {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  // Opening the new thread, from a project or Open folder, closes the dialog.
  useEffect(() => onHashChange(() => setOpen(false)), []);
  const start = async (project: Pick<ProjectSummary, "path">, worktree: boolean) => {
    const result = await startThread(connection, project.path, worktree);
    setError(result.ok ? undefined : result.message);
  };
  // The workspace has its own entry above the projects.
  const projects = byActivity(data).filter((p) => p.path !== data?.workspace);
  const workspace = data?.workspace;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(undefined);
      }}
    >
      <Dialog.Trigger className={`${row} w-full justify-start border-0 bg-transparent font-normal hover:bg-hover`}>
        <Rune name="berkano" className="text-muted" />
        New thread
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-bg/80" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[85dvh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-panel shadow-2xl outline-none">
          <div className="flex items-center justify-between gap-2 py-3 pr-2 pl-5">
            <Dialog.Title className="font-serif text-2xl font-semibold">New thread</Dialog.Title>
            <Dialog.Close aria-label="Close" className={ghostIcon}>
              <CloseIcon />
            </Dialog.Close>
          </div>
          <div className="overflow-y-auto px-5 pb-5">
            {workspace && (
              <button
                type="button"
                title={workspace}
                className={`${row} -mx-2 mb-4 w-[calc(100%+1rem)] justify-start border-0 bg-transparent font-normal hover:bg-hover`}
                onClick={() => start({ path: workspace }, false)}
              >
                <Rune name="berkano" className="shrink-0 text-muted" />
                <span className="shrink-0">Workspace</span>
                <span className="min-w-0 flex-1 truncate text-right text-xs text-muted">no project: chat, chores and your files</span>
              </button>
            )}
            {projects.length > 0 && (
              <section aria-labelledby="new-thread-projects">
                <h3 id="new-thread-projects" className="eyebrow mb-1 text-muted">
                  In a project
                </h3>
                <ul className="-mx-2">
                  {projects.map((p) => {
                    const name = basename(p.path);
                    return (
                      <li key={p.projectId} className="flex items-center gap-1">
                        <button
                          type="button"
                          title={p.path}
                          className={`${row} min-w-0 flex-1 justify-start border-0 bg-transparent font-normal hover:bg-hover`}
                          onClick={() => start(p, false)}
                        >
                          <FolderIcon className="shrink-0 text-muted" />
                          <span className="max-w-[60%] shrink-0 truncate">{name}</span>
                          {p.projectId === current && <span className="shrink-0 text-xs text-muted">current</span>}
                          <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted">{p.path}</span>
                        </button>
                        <button
                          type="button"
                          aria-label={`New thread in a git worktree of ${name}`}
                          title="In a git worktree of its own"
                          className={ghostIcon}
                          onClick={() => start(p, true)}
                        >
                          <BranchIcon className="mx-auto" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {error && (
              <p role="alert" className="mt-1 text-xs text-error [overflow-wrap:anywhere]">
                {error}
              </p>
            )}
            <OpenFolder connection={connection} className={projects.length > 0 ? "mt-5" : ""} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

/** Threads by recency, as in the sidebar reference: each with its title, project, and whether it's working. */
const ThreadList = ({ connection, data, current }: { connection: Connection; data: SidebarData; current: ThreadId | null }) => {
  const [error, setError] = useState<string>();
  const names = new Map(data.projects.map((p) => [p.projectId, basename(p.path)]));
  if (data.threads.length === 0)
    return (
      <p className="mx-2 mt-2 text-xs text-muted">
        No threads spun yet. Start one with New thread, open a project folder from <a href="#view=projects">Projects</a>, or run{" "}
        <code>verdandi</code> in a terminal.
      </p>
    );
  return (
    <>
      {error && (
        <p role="alert" className="mx-2 text-xs text-error">
          {error}
        </p>
      )}
      {groupByRecency(data.threads, new Date()).map((group) => (
        <section key={group.label} aria-label={group.label} className="mt-3 first:mt-1">
          <h2 className="px-2 pb-1 text-xs font-medium text-muted">{group.label}</h2>
          <ul>
            {group.threads.map((t) => (
              <ThreadRow
                key={t.threadId}
                connection={connection}
                thread={t}
                project={names.get(t.projectId) ?? ""}
                current={t.threadId === current}
                onError={setError}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
};

const ThreadRow = ({
  connection,
  thread: t,
  project,
  current,
  onError,
}: {
  connection: Connection;
  thread: ThreadSummary;
  project: string;
  current: boolean;
  onError: (message: string | undefined) => void;
}) => (
  <li className="group relative flex items-center gap-1">
    <a
      href={`#thread=${t.threadId}`}
      aria-current={current ? "page" : undefined}
      className={`flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 ${currentItem}`}
    >
      <span className={`flex items-center gap-1.5 ${t.archived ? "text-muted" : ""}`}>
        {/* A slot for every row, so titles line up whether or not their thread is working. */}
        <span className={`size-1.5 shrink-0 rounded-full ${t.busy ? "bg-accent" : ""}`}>
          {t.busy && <span className="sr-only">Working: </span>}
        </span>
        <span className="truncate">{t.title || "New thread"}</span>
      </span>
      <span className="flex min-w-0 items-center gap-x-1.5 pl-3 text-xs text-muted">
        <span className="truncate">{project}</span>
        {t.archived && <span className="shrink-0">· archived</span>}
        {describeCost(t.cost) && (
          <span
            className="shrink-0 tabular-nums"
            title="Paid: metered usage. On plan: subscription usage valued at API prices, covered by your plan."
          >
            · {describeCost(t.cost)}
          </span>
        )}
      </span>
    </a>
    {/* With a mouse, Archive shows over the row on hover or keyboard focus; on touch screens, and for Unarchive, it sits beside it. */}
    {!t.busy && (
      <ArchiveButton
        connection={connection}
        threadId={t.threadId}
        archived={t.archived}
        title={t.title || "New thread"}
        className={`shrink-0 ${t.archived ? "" : "pointer-fine:absolute pointer-fine:top-1.5 pointer-fine:right-1 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100"}`}
        onError={onError}
      />
    )}
  </li>
);

const resetTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Each harness's subscription window, as it last reported it. A live region, so a switch to extra usage is announced. */
const Quotas = ({ quotas }: { quotas: readonly QuotaView[] }) => (
  <div role="status">
    {quotas.map((q) => {
      const alert = q.quota.usingOverage || q.quota.status !== "allowed";
      return (
        <p key={q.harness} className={`flex gap-2 py-1 text-xs ${alert ? "text-error" : "text-muted"}`}>
          <span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${alert ? "bg-error" : "bg-ok"}`} />
          {describeQuota(q, resetTime)}
        </p>
      );
    })}
  </div>
);

/** Projects with the most recent activity first; `data.threads` is already in that order, and a project without one goes last. */
const byActivity = (data: SidebarData | undefined) => {
  const rank = new Map<ProjectSummary["projectId"], number>();
  for (const [i, t] of (data?.threads ?? []).entries()) if (!rank.has(t.projectId)) rank.set(t.projectId, i);
  return (data?.projects ?? []).toSorted((a, b) => (rank.get(a.projectId) ?? Infinity) - (rank.get(b.projectId) ?? Infinity));
};

/** The projects page: open any folder to start a thread, or start one in a project you've worked in. */
const Home = ({ connection, data }: { connection: Connection; data: SidebarData | undefined }) => {
  const threads = Map.groupBy(data?.threads ?? [], (t) => t.projectId);
  const projects = byActivity(data);
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-5 py-10 sm:px-8 sm:py-14">
        <div className="grid items-start gap-10 lg:grid-cols-[1fr_340px]">
          <div>
            <p className="flex items-center gap-3 text-rune">
              <RuneText className="h-3.5" />
              <span className="eyebrow text-muted">Verðandi · what is becoming</span>
            </p>
            <h1 className="mt-4 font-serif text-5xl leading-[0.95] font-bold tracking-tight uppercase sm:text-7xl">Projects</h1>
            <p className="mt-5 max-w-lg font-serif text-xl leading-snug">
              Beneath Yggdrasil three norns spin the threads of fate: Urðr what was, Verðandi what is becoming, Skuld what shall be.
            </p>
            <p className="mt-3 max-w-lg text-muted">
              Open a folder to begin a thread. Each task goes to the harness, model and effort that finish it for the least.
            </p>
            <OpenFolder connection={connection} />
          </div>
          <Engraving className="mx-auto w-full max-w-[220px] lg:max-w-[340px]" />
        </div>
        {projects.length > 0 && (
          <section aria-labelledby="your-projects" className="mt-12">
            <Plait className="mb-8 text-rune" />
            <h2 id="your-projects" className="eyebrow mb-4 text-muted">
              Your projects
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p, i) => (
                <ProjectCard
                  key={p.projectId}
                  connection={connection}
                  project={p}
                  threads={threads.get(p.projectId) ?? []}
                  lead={i === 0}
                />
              ))}
            </ul>
          </section>
        )}
        <TrustedCommandsList connection={connection} />
        <p className="mt-16 border-t border-line pt-3 text-xs text-muted">
          Engraving by Ludwig Burger, 1882, in the public domain. Raven and longship by Lorc and Delapouite from{" "}
          <a href="https://game-icons.net" target="_blank" rel="noreferrer" className="underline underline-offset-2">
            game-icons.net
          </a>
          ,{" "}
          <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noreferrer" className="underline underline-offset-2">
            CC BY 3.0
          </a>
          .
        </p>
      </div>
    </div>
  );
};

/**
 * Starts a thread in any folder, typed or chosen with Browse; verdandid checks the path and resolves it, so a known folder
 * gets a new thread, not a new project.
 */
const OpenFolder = ({ connection, className = "mt-8 max-w-2xl" }: { connection: Connection; className?: string }) => {
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false);
  // The OS folder dialog opens on verdandid's machine, so it's only offered when that's the one showing the page.
  const { sameMachine } = connection.endpoint;
  const start = async (form: HTMLFormElement, projectPath: string) => {
    const result = await startThread(connection, projectPath, new FormData(form).get("worktree") === "on");
    setError(result.ok ? undefined : result.message);
    if (result.ok) form.reset();
  };
  const open = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const projectPath = String(new FormData(event.currentTarget).get("path")).trim();
    if (projectPath) void start(event.currentTarget, projectPath);
  };
  const browse = async (form: HTMLFormElement | null) => {
    if (!form) return;
    setPicking(true);
    const picked = await connection.pickFolder();
    setPicking(false);
    if (!picked.ok) setError(picked.message);
    else if (picked.path !== null) await start(form, picked.path);
  };
  return (
    <form onSubmit={open} className={className}>
      <label htmlFor="open-folder-path" className="eyebrow mb-2 block text-muted">
        Open folder
      </label>
      <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-card p-1.5 pl-3 focus-within:border-accent focus-within:shadow-[0_0_0_1px_var(--color-accent)]">
        <FolderIcon className="text-muted" />
        <input
          id="open-folder-path"
          type="text"
          name="path"
          placeholder={sameMachine ? "Full path to a project folder, or Browse" : "Full path to a project folder"}
          required
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 border-0 bg-transparent px-1 font-mono text-[13px] outline-none focus-visible:outline-none"
          aria-invalid={error !== undefined}
          aria-describedby={error ? "open-folder-error" : undefined}
        />
        {sameMachine ? (
          // Enter in the path still submits the form: a form with one text field submits without a submit button.
          <button type="button" onClick={(e) => void browse(e.currentTarget.form)} disabled={picking} className="min-h-8 px-4">
            Browse…
          </button>
        ) : (
          <button type="submit" className="min-h-8 px-4">
            Open
          </button>
        )}
      </div>
      <label className="mt-2 flex items-center text-xs text-muted">
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

const activity = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/**
 * One project: how many threads it has, in a large figure, and the ways to start another. The most recently
 * active project leads, on the sky surface.
 */
const ProjectCard = ({
  connection,
  project,
  threads,
  lead,
}: {
  connection: Connection;
  project: ProjectSummary;
  threads: readonly ThreadSummary[];
  lead: boolean;
}) => {
  const [error, setError] = useState<string>();
  // Without a route, the router picks one for each task of the new thread.
  const newThread = async (worktree: boolean) => {
    const result = await startThread(connection, project.path, worktree);
    if (!result.ok) setError(result.message);
  };
  const name = basename(project.path);
  const last = threads[0]?.lastActivityAt;
  return (
    <li className={`relative flex flex-col border border-line p-5 ${lead ? "bg-user" : "bg-card"}`}>
      {/* As on the Norse reference, a raven alights on the leading card. */}
      {lead && <Raven className="absolute -top-9 right-5 size-16 text-fg" />}
      <p aria-hidden className="font-serif text-5xl leading-none font-semibold tabular-nums">
        {threads.length}
      </p>
      <h3 className="mt-4 font-serif text-2xl leading-tight font-semibold [overflow-wrap:anywhere]">
        {name}
        <span className="sr-only">
          , {threads.length} {threads.length === 1 ? "thread" : "threads"}
        </span>
      </h3>
      <p title={project.path} className="mt-1 truncate font-mono text-xs text-muted">
        {project.path}
      </p>
      {last && <p className="mt-1 text-xs text-muted">Last active {activity(last)}</p>}
      {error && (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
      <span className="mt-auto flex flex-wrap gap-x-5 gap-y-1 pt-5">
        <Action onClick={() => newThread(false)} label={`New thread in ${name}`}>
          <Rune name="berkano" className="size-3.5" />
          New thread
        </Action>
        <Action onClick={() => newThread(true)} label={`New thread in a git worktree of ${name}`}>
          <BranchIcon className="size-3.5" />
          Worktree
        </Action>
      </span>
    </li>
  );
};

const Action = ({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) => (
  <button type="button" className="caps-link" aria-label={label} title={label} onClick={onClick}>
    {children}
  </button>
);
