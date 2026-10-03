import { childEnv } from "../home/child-env.ts";
import { readServerFile, resolveHome } from "../home/home.ts";

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
 * `verdandi open`: opens the web UI in the default browser. The token rides in the URL fragment,
 * which browsers never send to the server, so it stays out of server logs and `Referer` headers.
 */
export const open = async (argv: readonly string[]) => {
  const { port, token } = readServerFile(resolveHome(argv));
  const url = `http://127.0.0.1:${port}/#token=${token}`;
  if (await launch(opener(url))) console.log(`Opened Verdandi at http://127.0.0.1:${port}/`);
  else console.log(`Couldn't open a browser. Open this URL yourself; it holds your access token, so don't share it:\n${url}`);
};
