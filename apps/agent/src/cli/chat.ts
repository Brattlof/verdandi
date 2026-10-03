import { writeFileSync } from "node:fs";
import type { CommandId, ProjectsFeed, ThreadId } from "@verdandi/contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { flag, resolveHome } from "../home/home.ts";
import { cliThreadsFile, defaultFolder, readCliThreads } from "../home/workspace.ts";
import { serverFor } from "../main.ts";
import { connect } from "../rpc/client.ts";
import { Client, type Io, openSession, type SessionSetup, uuid } from "./chat-session.ts";
import { budgetFromFlags, picksRoute, routeFromFlags } from "./route-flags.ts";
import { threadList } from "./thread-list.ts";

/** Prints every thread from the projects feed's snapshot, archived ones only with `archived`, then ends the feed (ADR 0008). */
const list = async (runtime: ManagedRuntime.ManagedRuntime<Client, never>, client: Client["Service"], archived: boolean) => {
  const subscriptionId = crypto.randomUUID();
  const snapshot = Promise.withResolvers<Extract<ProjectsFeed, { kind: "snapshot" }>>();
  const feed = runtime.runPromise(
    client
      .ProjectsSubscribe({ subscriptionId, archived })
      .pipe(Stream.runForEach((f: ProjectsFeed) => Effect.sync(() => f.kind === "snapshot" && snapshot.resolve(f)))),
  );
  const noSnapshot = new Error("The projects feed ended before its snapshot arrived. Restart verdandid and try again.");
  feed.then(() => snapshot.reject(noSnapshot), snapshot.reject);
  const { projects, threads, quotas } = await snapshot.promise;
  await runtime.runPromise(client.Unsubscribe({ subscriptionId }));
  await feed;
  process.stdout.write(threadList(projects, threads, quotas));
};

/** The line chat: reads lines from stdin and writes to stdout, for pipes, scripts and `--plain`. */
const plainChat = async (setup: SessionSetup, notes: readonly string[], done: () => Promise<void>) => {
  const io: Io = {
    write: (text) => process.stdout.write(text),
    prompt: (mode) => process.stdout.write(mode === "build" ? "> " : `${mode}> `),
    suspend: (run) => run(),
  };
  const session = await openSession(setup, io, notes);
  process.on("SIGINT", () => {
    if (session.interrupt()) void done().finally(() => process.exit(130));
  });
  for await (const line of console) if (await session.input(line)) break;
  await session.close();
  await done();
};

/**
 * `verdandi` (or `verdandi chat`): chat with the thread for the current folder when it's a project, else the
 * workspace's (`defaultFolder`), or the one `--thread` names. In a terminal it opens the terminal UI (`src/tui`); with
 * `--plain`, or when stdin or stdout isn't a terminal, the line chat. Without a running verdandid it runs one in this
 * process until you quit.
 */
export const chat = async (argv: readonly string[]) => {
  const home = resolveHome(argv);
  const route = routeFromFlags(argv); // also rejects bad flags before connecting
  const budget = budgetFromFlags(argv);
  if (argv.includes("--auto") && picksRoute(argv)) {
    throw new Error("--auto lets the router pick each task's route, so leave out --harness, --model and --effort.");
  }
  const picked = flag(argv, "--thread") as ThreadId | undefined;
  const folder = picked ? undefined : defaultFolder(home, process.cwd(), argv);

  const served = await serverFor(home, argv);
  const notes = served.stop
    ? [
        "[verdandid runs in this chat and stops when you quit; `verdandi web` opens the web UI meanwhile, `verdandi start` keeps one running]\n",
        ...served.status.map((line) => `[${line}]\n`),
      ]
    : [];
  const runtime = ManagedRuntime.make(Layer.effect(Client)(connect(served.server)));
  const done = async () => {
    await runtime.dispose();
    await served.stop?.();
  };
  const client = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Client;
    }),
  );
  if (argv.includes("--list")) {
    await list(runtime, client, argv.includes("--archived"));
    return done();
  }
  // Archiving hides a thread from the lists without deleting anything; unarchiving brings it back.
  const archive = flag(argv, "--archive") as ThreadId | undefined;
  const unarchive = flag(argv, "--unarchive") as ThreadId | undefined;
  const put = archive ?? unarchive;
  if (put) {
    const type = archive ? "thread.archive" : "thread.unarchive";
    const said = archive
      ? `Archived thread ${put}. \`verdandi chat --unarchive ${put}\` brings it back; \`verdandi chat --list --archived\` lists it.\n`
      : `Unarchived thread ${put}: it takes turns again.\n`;
    process.stdout.write(
      await runtime.runPromise(
        client.CommandDispatch({ type, commandId: uuid<CommandId>(), threadId: put }).pipe(
          Effect.as(said),
          Effect.catchTag("CommandRejected", (e) => Effect.succeed(`${e.message}\n`)),
        ),
      ),
    );
    return done();
  }
  const threads = readCliThreads(home);
  // --worktree starts a new thread in a worktree of its own; with --thread, it recreates that thread's worktree.
  const worktree = argv.includes("--worktree");
  let threadId = picked ?? (worktree || !folder ? undefined : (threads[folder] as ThreadId | undefined));
  if (!threadId) {
    threadId = uuid<ThreadId>();
    await runtime.runPromise(
      client.CommandDispatch({
        type: "thread.create",
        commandId: uuid<CommandId>(),
        threadId,
        projectPath: folder ?? process.cwd(),
        ...(picksRoute(argv) ? { route } : {}),
        ...(worktree && { worktree }),
      }),
    );
    if (folder) writeFileSync(cliThreadsFile(home), JSON.stringify({ ...threads, [folder]: threadId }, null, 2));
  }

  const setup: SessionSetup = { runtime, client, threadId, home, argv, picked, worktree, budget };
  if (argv.includes("--plain") || !process.stdin.isTTY || !process.stdout.isTTY) return plainChat(setup, notes, done);
  // Loaded only here, so the line chat and headless commands never load OpenTUI's native engine.
  const { terminalUi } = await import("../tui/tui.tsx");
  return terminalUi(setup, notes, done);
};
