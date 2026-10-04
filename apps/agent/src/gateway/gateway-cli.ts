import { type CommandId, type GatewayView, type PendingPairing, Platform } from "@verdandi/contracts";
import { Effect, Schema } from "effect";
import { readServerFile, resolveHome } from "../home/home.ts";
import { connect } from "../rpc/client.ts";

const gatewayUsage =
  "verdandi gateway senders | senders revoke <platform> <sender> | pair <code> [--owner] | deny <request> | owner <platform> <sender> | owner <platform> --clear";

/** One sender waiting to pair, as the terminal chat's notice and `verdandi gateway senders` show it. Never the code. */
export const senderPairingLine = (p: PendingPairing) =>
  `${p.platform} sender ${p.senderName} (${p.senderId}) asks to be let in: they got a code in their DM. Approve it with verdandi gateway pair <code>, or deny it with verdandi gateway deny ${p.requestId}`;

/** Who has access on each platform, then the waiting requests. */
export const gatewayText = (view: GatewayView) => {
  const senders = view.senders.map(
    (s) => `  ${s.platform} ${s.senderId}  ${s.name}${s.owner ? ", the owner" : ""}${s.pairedAt ? `, paired ${s.pairedAt}` : ""}`,
  );
  return [
    view.running.length
      ? `Connected: ${view.running.join(", ")}.`
      : "No chat app is connected: an always-on verdandid (verdandi start) connects them.",
    senders.length ? `Senders with access (besides gateway.yaml's allowFrom):\n${senders.join("\n")}` : "No sender is paired.",
    ...view.pending.map(senderPairingLine),
    "",
  ].join("\n");
};

type Client = Effect.Success<ReturnType<typeof connect>>;
const said = (message: string) => Effect.succeed(`${message}\n`);
const platformOf = (name: string) => {
  if (!Schema.is(Platform)(name)) throw new Error(`There's no platform ${name}; it's one of ${Platform.literals.join(", ")}.`);
  return name;
};
const dispatched = (client: Client, command: Parameters<Client["CommandDispatch"]>[0], done: string) =>
  client.CommandDispatch(command).pipe(
    Effect.andThen(said(done)),
    Effect.catchTag("CommandRejected", (e) => said(e.message)),
  );

const usage = () => {
  throw new Error(`Usage: ${gatewayUsage}`);
};

/** Each subcommand, given its words after the subcommand: what it does through the client, and what it prints. */
const actions: Record<string, (words: readonly string[], argv: readonly string[]) => (client: Client) => Effect.Effect<string, unknown>> = {
  senders: ([action = "list", platform = "", sender = ""]) => {
    if (action === "list") return (client) => Effect.map(client.GatewayList(), gatewayText);
    if (action !== "revoke" || !sender) return usage();
    const command = {
      type: "sender.revoke",
      commandId: crypto.randomUUID() as CommandId,
      platform: platformOf(platform),
      senderId: sender,
    } as const;
    return (client) => dispatched(client, command, "Revoked: their messages are ignored from now on, and they'd have to pair again.");
  },
  pair: (words, argv) => {
    // A code may be typed split, e.g. ABCD EFGH.
    const code = words.join("");
    const owner = argv.includes("--owner");
    return code
      ? (client) =>
          client.GatewayPair({ code, owner }).pipe(
            Effect.flatMap((p) => said(`Let in ${p.platform} sender ${p.senderName} (${p.senderId})${owner ? " as the owner" : ""}.`)),
            Effect.catchTag("GatewayUnavailable", (e) => said(e.message)),
          )
      : usage();
  },
  deny: ([requestId = ""]) =>
    requestId
      ? (client) =>
          dispatched(
            client,
            { type: "pairing.deny", commandId: crypto.randomUUID() as CommandId, requestId },
            "Denied: their messages stay ignored.",
          )
      : usage(),
  owner: ([platform = "", sender = ""], argv) => {
    const clear = argv.includes("--clear");
    if (!sender === !clear) return usage();
    const command = {
      type: "gateway.owner.set",
      commandId: crypto.randomUUID() as CommandId,
      platform: platformOf(platform),
      senderId: clear ? null : sender,
    } as const;
    return (client) =>
      dispatched(
        client,
        command,
        clear
          ? `${platform} has no owner now: nobody can run owner-only commands from it.`
          : `${platform} sender ${sender} is the owner: only they can approve requests and run owner-only commands from that chat app. verdandi gateway owner ${platform} --clear takes it back.`,
      );
  },
};

/**
 * `verdandi gateway`: who may reach Verdandi from chat apps (DESIGN §15), through the running verdandid. Lists senders
 * and waiting pairing requests, approves one with the code its sender got (`--owner` makes them the platform's owner),
 * denies one, revokes a sender, and sets or clears the owner.
 */
export const gateway = async (argv: readonly string[]) => {
  const [sub = "senders", ...words] = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--home");
  const action = (actions[sub] ?? usage)(words, argv);
  const server = readServerFile(resolveHome(argv));
  process.stdout.write(await Effect.runPromise(Effect.scoped(Effect.flatMap(connect(server), action))));
};
