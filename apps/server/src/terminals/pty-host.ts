/**
 * The PTY host (DESIGN §13, ADR 0007): a child process verdandid starts on the first terminal and talks to
 * over Bun IPC, so a crash in native terminal code can't take verdandid down. It only runs shells; verdandid
 * keeps their output and owns the terminals. Run as the entry file, it serves; imported, it only lends its
 * types and `killTree`.
 */

/** verdandid to host. */
export type HostRequest =
  | { readonly type: "open"; readonly id: string; readonly cwd: string; readonly cols: number; readonly rows: number }
  | { readonly type: "write"; readonly id: string; readonly data: string }
  | { readonly type: "resize"; readonly id: string; readonly cols: number; readonly rows: number }
  | { readonly type: "close"; readonly id: string };

/** Host to verdandid. Output is UTF-8 text, one message per terminal per ~16 ms frame. */
export type HostReport =
  | { readonly type: "opened"; readonly id: string; readonly pid: number }
  | { readonly type: "failed"; readonly id: string; readonly message: string }
  | { readonly type: "output"; readonly id: string; readonly data: string }
  | { readonly type: "exit"; readonly id: string; readonly exitCode: number | null }
  | { readonly type: "closed"; readonly id: string };

const windows = process.platform === "win32";

/**
 * Kills the shell `pid` and what it started, by the PID captured at spawn, never by name. Windows: the
 * process tree. POSIX: the process group the shell leads (its PTY made it a session leader). Already gone is fine.
 */
// ponytail: misses children that left the shell's tree or group (taskkill /T after their parent exited, POSIX jobs
// in their own group that ignore SIGHUP). Upgrade: a Job Object (Windows) or killing the whole session, when it matters.
export const killTree = (pid: number) => {
  if (windows) {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
};

/** The user's shell: `$SHELL` (else `/bin/sh`) as a login shell on POSIX, PowerShell on Windows. */
const shell = () => (windows ? ["powershell.exe", "-NoLogo"] : [process.env.SHELL || "/bin/sh", "-l"]);

/** How long a shell gets to exit after a hangup before its group is killed. */
const graceMs = 1000;

const serve = async () => {
  if (windows) {
    // ADR 0007: undo an inherited "ignore Ctrl+C", so shells never start with Ctrl+C disabled.
    const { dlopen, FFIType } = await import("bun:ffi");
    dlopen("kernel32.dll", {
      SetConsoleCtrlHandler: { args: [FFIType.ptr, FFIType.bool], returns: FFIType.bool },
    }).symbols.SetConsoleCtrlHandler(null, false);
  }
  const send = (report: HostReport) => process.send?.(report);
  const shells = new Map<string, { readonly proc: Bun.Subprocess; readonly closing: Promise<void> | undefined }>();
  const terminalOf = (id: string) => shells.get(id)?.proc.terminal;

  const open = (request: Extract<HostRequest, { type: "open" }>) => {
    const decoder = new TextDecoder();
    let pending = "";
    let timer: Timer | undefined;
    // ADR 0007: output is sent once per ~16 ms frame, however many chunks the PTY delivers in it.
    const flush = () => {
      timer = undefined;
      if (pending) send({ type: "output", id: request.id, data: pending });
      pending = "";
    };
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn(shell(), {
        cwd: request.cwd,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        terminal: {
          cols: request.cols,
          rows: request.rows,
          data: (_terminal, bytes) => {
            pending += decoder.decode(bytes, { stream: true });
            timer ??= setTimeout(flush, 16);
          },
        },
      });
    } catch (e) {
      send({ type: "failed", id: request.id, message: `Could not start ${shell()[0]} in ${request.cwd}: ${(e as Error).message}` });
      return;
    }
    shells.set(request.id, { proc, closing: undefined });
    send({ type: "opened", id: request.id, pid: proc.pid });
    void proc.exited.then(() => {
      clearTimeout(timer);
      flush();
      proc.terminal?.close();
      // A shell closed on request reports `closed` instead, once it's gone.
      if (!shells.get(request.id)?.closing) {
        shells.delete(request.id);
        send({ type: "exit", id: request.id, exitCode: proc.signalCode ? null : proc.exitCode });
      }
    });
  };

  /** Hangs up the shell, which hangs up its jobs; a shell that outstays the grace period is killed with its tree. */
  const close = (id: string) => {
    const entry = shells.get(id);
    if (!entry) return Promise.resolve();
    if (entry.closing) return entry.closing;
    const { proc } = entry;
    const closing = (async () => {
      // ADR 0007: on Windows the tree is killed before the shell exits, and the PTY disposed after.
      if (windows) killTree(proc.pid);
      else {
        try {
          process.kill(proc.pid, "SIGHUP");
        } catch {}
      }
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
      if (!exited) killTree(proc.pid);
      await proc.exited;
      proc.terminal?.close();
      shells.delete(id);
    })();
    shells.set(id, { proc, closing });
    return closing;
  };

  process.on("message", (request: HostRequest) => {
    if (request.type === "open") open(request);
    else if (request.type === "write") terminalOf(request.id)?.write(request.data);
    else if (request.type === "resize") terminalOf(request.id)?.resize(request.cols, request.rows);
    else void close(request.id).then(() => send({ type: "closed", id: request.id }));
  });
  // verdandid stopped or died: no shell outlives it.
  process.on("disconnect", async () => {
    await Promise.all([...shells.keys()].map(close));
    process.exit(0);
  });
};

if (import.meta.main) await serve();
