import { homedir } from "node:os";
import { FolderPickUnavailable } from "@verdandi/contracts";
import { Effect } from "effect";
import { childEnv } from "../home/child-env.ts";

const title = "Choose a project folder";

// Windows PowerShell 5.1 runs on .NET Framework, so only the dialog's oldest properties. A topmost owner keeps it above the browser.
const windowsScript = `Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{ Description = '${title}' }
if ($dialog.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($dialog.SelectedPath) }`;

/**
 * The platform's folder dialogs, tried in order until one is installed. Each prints the chosen path; `cancelled`
 * tells a cancel from a failure when it exits non-zero (PowerShell's cancel exits 0 and prints nothing).
 */
const dialogs = (): readonly { readonly cmd: string[]; readonly cancelled: (stderr: string) => boolean }[] =>
  process.platform === "darwin"
    ? [{ cmd: ["osascript", "-e", `POSIX path of (choose folder with prompt "${title}")`], cancelled: (e) => e.includes("(-128)") }]
    : process.platform === "win32"
      ? [{ cmd: ["powershell.exe", "-NoProfile", "-STA", "-Command", windowsScript], cancelled: () => false }]
      : [
          { cmd: ["zenity", "--file-selection", "--directory", `--title=${title}`], cancelled: () => true },
          { cmd: ["kdialog", "--getexistingdirectory", homedir(), "--title", title], cancelled: () => true },
        ];

const spawn = (cmd: string[]) => {
  try {
    return Bun.spawn({ cmd, env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  } catch {
    return undefined; // not installed
  }
};

/**
 * Opens the OS folder dialog and answers with the chosen path as the dialog gives it (`resolveProjectPath` resolves it),
 * or null when the user cancels. Interrupting it, as a client that disconnects does, closes the dialog.
 */
export const pickFolder: Effect.Effect<string | null, FolderPickUnavailable> = Effect.suspend(() => {
  for (const { cmd, cancelled } of dialogs()) {
    const proc = spawn(cmd);
    if (!proc) continue;
    return Effect.acquireUseRelease(
      Effect.succeed(proc),
      (p) =>
        Effect.promise(() => Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])).pipe(
          Effect.flatMap(([code, out, err]) => {
            const path = out.replace(/\r?\n$/, "");
            if (code === 0) return Effect.succeed(path || null);
            if (cancelled(err)) return Effect.succeed(null);
            return Effect.fail(
              new FolderPickUnavailable({
                reason: "DialogFailed",
                message: `The folder dialog failed (${cmd[0]} exited ${code}: ${err.trim() || "no output"}). Type the folder's path instead.`,
              }),
            );
          }),
        ),
      (p) => Effect.sync(() => p.exitCode === null && p.kill()),
    );
  }
  return Effect.fail(
    new FolderPickUnavailable({
      reason: "NoDialog",
      message:
        process.platform === "linux"
          ? "No folder dialog found. Install zenity or kdialog, or type the folder's path."
          : `${dialogs()[0]?.cmd[0]} isn't available. Type the folder's path instead.`,
    }),
  );
});
