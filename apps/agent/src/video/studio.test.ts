import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VideoFeed, VideoProjectId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { initProject } from "@verdandi/video";
import { Effect, ManagedRuntime, Stream } from "effect";
import { connect } from "../rpc/client.ts";
import { ServerInfo, ServerLayer } from "../rpc/server.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const start = async () => {
  const home = makeTempHome();
  const runtime = ManagedRuntime.make(ServerLayer(home, { fake: makeFakeHarness() }));
  cleanups.push(() => removeTempHome(home));
  cleanups.push(() => runtime.dispose());
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  const dir = join(makeTempHome(), "film");
  initProject(dir);
  return { info, dir };
};

const step = <A, E>(label: string, e: Effect.Effect<A, E>) =>
  e.pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die(`step timed out: ${label}`) }));

test("the Studio opens a project, reads and writes its files with versions, and refuses a stale write", async () => {
  const { info, dir } = await start();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* connect(info);
        const view = yield* client.VideoOpen({ path: dir });
        expect(view.files).toEqual(["AGENTS.md", "index.html"]);
        expect((yield* client.VideoOpen({ path: dir })).projectId).toBe(view.projectId);

        const file = yield* client.VideoFileRead({ projectId: view.projectId, path: "index.html" });
        const { version } = yield* client.VideoFileWrite({
          projectId: view.projectId,
          path: "index.html",
          content: `${file.content}\n`,
          expectedVersion: file.version,
        });
        expect(version).not.toBe(file.version);
        const stale = yield* Effect.flip(
          client.VideoFileWrite({ projectId: view.projectId, path: "index.html", content: "lost", expectedVersion: file.version }),
        );
        expect(stale).toMatchObject({ reason: "Conflict", current: { version } });

        const outside = yield* Effect.flip(client.VideoFileRead({ projectId: view.projectId, path: "../secrets.txt" }));
        expect(outside).toMatchObject({ reason: "InvalidPath" });
        const media = yield* Effect.flip(
          client.VideoFileWrite({ projectId: view.projectId, path: "assets/x.mp4", content: "", expectedVersion: null }),
        );
        expect(media).toMatchObject({ reason: "InvalidPath" });
      }),
    ),
  );
});

test("the preview is served sandboxed with the runtime, and the feed reports outside edits", async () => {
  const { info, dir } = await start();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* connect(info);
        const { projectId } = yield* client.VideoOpen({ path: dir });
        const page = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${info.port}/video/${projectId}/index.html`, { headers: { "sec-fetch-dest": "iframe" } }),
        );
        expect(page.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
        expect(yield* Effect.promise(() => page.text())).toContain("window.__vd");
        const missing = yield* Effect.promise(() => fetch(`http://127.0.0.1:${info.port}/video/${"0".repeat(64)}/index.html`));
        expect(missing.status).toBe(404);

        const feed = client.VideoSubscribe({ projectId: projectId as VideoProjectId, subscriptionId: crypto.randomUUID() });
        const messages = yield* step(
          "snapshot, then the outside edit",
          feed.pipe(
            Stream.tap((m: VideoFeed) =>
              Effect.sync(() => m.kind === "snapshot" && writeFileSync(join(dir, "compositions", "intro.html"), "<template></template>")),
            ),
            Stream.takeUntil((m: VideoFeed) => m.kind === "changed" && m.paths.includes("compositions/intro.html")),
            Stream.runCollect,
          ),
        );
        const last = messages.at(-1);
        expect(last?.kind === "changed" && last.files).toContain("compositions/intro.html");
      }),
    ),
  );
});
