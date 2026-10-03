import { networkInterfaces } from "node:os";
import { childEnv } from "../home/child-env.ts";
import { flag, resolveHome } from "../home/home.ts";
import { serverFor } from "../main.ts";

/** The platform's own way to open a URL in the default browser. Windows skips `start`: cmd would parse the URL. */
const opener = (url: string) =>
  process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["rundll32", "url.dll,FileProtocolHandler", url]
      : ["xdg-open", url];

const launch = async (command: string[]) => {
  try {
    return (await Bun.spawn(command, { env: childEnv(), stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false; // the opener isn't installed
  }
};

/**
 * `verdandi web`: serves the web UI until Ctrl+C and opens it in the default browser (not with `--no-open`). The agent
 * never serves it (ADR 0026): `apps/web` is loaded only here, on demand. It relays to the profile's running verdandid,
 * or runs one in this process meanwhile. The page's token rides in the URL fragment, which browsers never send to a
 * server, so it stays out of logs and `Referer` headers. `--host` also opens it to the local network or tailnet.
 */
export const web = async (argv: readonly string[]) => {
  const home = resolveHome(argv);
  const host = flag(argv, "--host");
  const port = flag(argv, "--port");
  const { hostProblem, isLocalAddress, startLanGate } = await import("@verdandi/web/lan-gate");
  const problem = host === undefined ? undefined : hostProblem(host);
  if (problem) throw new Error(problem);
  const lan = host !== undefined && host !== "127.0.0.1" && host !== "::1";
  const { serveWeb } = await import("@verdandi/web/serve");
  const served = await serverFor(home, argv);
  // With a LAN gate, --port is the gate's, the one other devices use, and the web server takes any free loopback port.
  const ui = serveWeb(served.server, port === undefined || lan ? 0 : Number(port));
  const gate = lan && host ? startLanGate(host, port === undefined ? 0 : Number(port), ui.port, ui.gateSecret) : undefined;
  const url = `http://127.0.0.1:${ui.port}/#token=${ui.token}`;
  console.log(
    `Verdandi's web UI at http://127.0.0.1:${ui.port}/ (home: ${home}); Ctrl+C stops it${served.stop ? ", and the verdandid it runs" : ""}.`,
  );
  for (const line of served.status) console.log(line);
  if (gate) {
    const addresses =
      host === "0.0.0.0" || host === "::"
        ? Object.values(networkInterfaces())
            .flat()
            .flatMap((a) => (a && a.family === "IPv4" && !a.internal && isLocalAddress(a.address) ? [a.address] : []))
        : [host ?? ""];
    console.log(
      `Also open on your local network at ${addresses.map((a) => `http://${a}:${gate.port}/`).join(", ") || `port ${gate.port}`}; requests from outside it are refused.`,
    );
    console.log(
      "Another device pairs when it opens that address: approve it, if its code matches, in the web UI's Devices page, the terminal chat, or with verdandi devices approve <id>.",
    );
  }
  if (!argv.includes("--no-open") && !(await launch(opener(url))))
    console.log(`Couldn't open a browser. Open this URL yourself; it holds the page's access token, so don't share it:\n${url}`);

  const stop = async () => {
    gate?.stop(true);
    ui.stop();
    await served.stop?.();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
};
