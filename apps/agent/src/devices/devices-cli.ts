import type { CommandId, DeviceId, DevicesView, PairingRequest } from "@verdandi/contracts";
import { Effect } from "effect";
import { readServerFile, resolveHome } from "../home/home.ts";
import { connect } from "../rpc/client.ts";

const devicesUsage = "verdandi devices list | approve <request> | deny <request> | revoke <device>";

/** One pairing request, as the terminal chat's notice and `verdandi devices list` show it. */
export const pairingLine = (r: PairingRequest) =>
  `${r.name} from ${r.address} asks to pair, showing code ${r.code}: verdandi devices approve ${r.requestId} if the code matches, or deny ${r.requestId}`;

/** The paired devices, then the waiting requests. */
export const devicesText = (view: DevicesView) => {
  const devices = view.devices.map(
    (d) =>
      `  ${d.deviceId}  ${d.name}, paired ${d.pairedAt}, ${d.revoked ? "revoked" : d.lastSeen ? `last seen ${d.lastSeen}` : "not seen yet"}`,
  );
  return [devices.length ? `Paired devices:\n${devices.join("\n")}` : "No device is paired.", ...view.pending.map(pairingLine), ""].join(
    "\n",
  );
};

type Client = Effect.Success<ReturnType<typeof connect>>;
const said = (message: string) => Effect.succeed(`${message}\n`);

/** Each subcommand, given the id it names, and what it prints. */
const actions: Record<string, (client: Client, id: string) => Effect.Effect<string, unknown>> = {
  list: (client) => Effect.map(client.DevicesList(), devicesText),
  approve: (client, id) =>
    client.DeviceApprove({ requestId: id }).pipe(
      Effect.flatMap((d) => said(`Paired ${d.name} as device ${d.deviceId}. verdandi devices revoke ${d.deviceId} cuts it off.`)),
      Effect.catchTag("DevicesUnavailable", (e) => said(e.message)),
    ),
  deny: (client, id) =>
    client.DeviceDeny({ requestId: id }).pipe(
      Effect.andThen(said("Denied: the device was told, and can ask again.")),
      Effect.catchTag("DevicesUnavailable", (e) => said(e.message)),
    ),
  revoke: (client, id) =>
    client.CommandDispatch({ type: "device.revoke", commandId: crypto.randomUUID() as CommandId, deviceId: id as DeviceId }).pipe(
      Effect.andThen(said("Revoked: its token stopped working and its open connections closed. It has to pair again.")),
      Effect.catchTag("CommandRejected", (e) => said(e.message)),
    ),
};

/**
 * `verdandi devices`: lists paired devices and waiting pairing requests, approves or denies a request, and revokes a
 * device (ADR 0028), through the running verdandid.
 */
export const devices = async (argv: readonly string[]) => {
  const [sub = "list", id = ""] = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--home");
  const action = actions[sub];
  if (!action || (sub !== "list" && !id)) throw new Error(`Usage: ${devicesUsage}`);
  const server = readServerFile(resolveHome(argv));
  process.stdout.write(await Effect.runPromise(Effect.scoped(Effect.flatMap(connect(server), (client) => action(client, id)))));
};
