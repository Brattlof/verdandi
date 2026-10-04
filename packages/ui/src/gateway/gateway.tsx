import type { CommandId, GatewayView, PendingPairing } from "@verdandi/contracts";
import { useEffect, useState } from "react";
import { type Connection, uuid } from "../client.ts";

const when = (iso: string) => new Date(iso).toLocaleString();

/** Chat senders waiting to pair and who has access (DESIGN §15), kept current from `GatewaySubscribe`. */
export const useGateway = (connection: Connection) => {
  const [view, setView] = useState<GatewayView>();
  useEffect(
    () =>
      connection.follow(
        (rpc, subscriptionId) => rpc.GatewaySubscribe({ subscriptionId }),
        setView,
        () => {},
      ),
    [connection],
  );
  return view;
};

/** The requests still waiting: one whose hour ran out drops out of the view only when something else changes it. */
export const waitingPairings = (view: GatewayView | undefined) => view?.pending.filter((p) => Date.parse(p.expiresAt) > Date.now()) ?? [];

/**
 * A sender asking to be let in: their platform, name and id, when they asked, and Approve, Approve as owner (naming the
 * owner it replaces) or Deny.
 */
const PairingRow = ({ connection, pairing, owner }: { connection: Connection; pairing: PendingPairing; owner: string | undefined }) => {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const answer = async (approve: boolean, owner = false) => {
    setSending(true);
    const commandId = uuid<CommandId>();
    const result = await connection.dispatch(
      approve
        ? { type: "pairing.approve", commandId, requestId: pairing.requestId, owner }
        : { type: "pairing.deny", commandId, requestId: pairing.requestId },
    );
    setSending(false);
    if (!result.ok) setError(result.message);
  };
  return (
    <li className="border border-line border-l-2 border-l-warn bg-card px-4 py-3">
      <p className="font-medium">
        {pairing.senderName}{" "}
        <span className="text-muted">
          on {pairing.platform}, id {pairing.senderId}
        </span>
      </p>
      <p className="text-xs text-muted">
        Asked {when(pairing.at)}; the code they got works until {when(pairing.expiresAt)}. Approve only someone you know.
      </p>
      {error && (
        <p role="alert" className="mt-1 text-xs text-error">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={sending} onClick={() => answer(false)}>
          Deny
        </button>
        <button type="button" disabled={sending} onClick={() => answer(true, true)}>
          {owner ? `Approve as owner, replacing ${owner}` : "Approve as owner"}
        </button>
        <button type="button" className="border-go bg-go text-on-go hover:bg-go-hover" disabled={sending} onClick={() => answer(true)}>
          Approve
        </button>
      </div>
    </li>
  );
};

/** The Devices page's chat apps: senders asking to be let in, and who has access, each with Revoke. */
export const ChatSenders = ({ connection, view }: { connection: Connection; view: GatewayView | undefined }) => {
  const [error, setError] = useState<string>();
  const answer = async (command: Parameters<Connection["dispatch"]>[0]) => {
    const result = await connection.dispatch(command);
    setError(result.ok ? undefined : result.message);
  };
  const owners = new Map(view?.senders.filter((s) => s.owner).map((s) => [s.platform, s.name]));
  const pending = waitingPairings(view);
  return (
    <section aria-labelledby="chat-senders" className="mt-10">
      <h2 id="chat-senders" className="eyebrow mb-2 text-muted">
        Chat apps
      </h2>
      <p className="mb-3 text-sm text-muted">
        {view?.running.length
          ? `Connected: ${view.running.join(", ")}.`
          : "No chat app is connected: an always-on verdandid (verdandi start) connects the ones in gateway.yaml."}{" "}
        A sender Verdandi doesn't know gets a code in their DM and waits here. The owner alone approves requests and runs owner-only
        commands from a chat.
      </p>
      {pending.length ? (
        <ul className="mb-4 flex flex-col gap-2">
          {pending.map((p) => (
            <PairingRow key={p.requestId} connection={connection} pairing={p} owner={owners.get(p.platform)} />
          ))}
        </ul>
      ) : null}
      {error && (
        <p role="alert" className="mb-2 text-xs text-error">
          {error}
        </p>
      )}
      {view?.senders.length ? (
        <ul className="divide-y divide-line">
          {view.senders.map((s) => (
            <li key={`${s.platform}:${s.senderId}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{s.name}</span>
                {s.owner && <span className="ml-2 text-xs text-muted">owner</span>}
                <span className="block text-xs text-muted">
                  {s.platform}, id {s.senderId}
                  {s.pairedAt && ` · paired ${when(s.pairedAt)}`}
                </span>
              </span>
              <button
                type="button"
                onClick={() =>
                  answer({
                    type: "gateway.owner.set",
                    commandId: uuid<CommandId>(),
                    platform: s.platform,
                    senderId: s.owner ? null : s.senderId,
                  })
                }
              >
                {s.owner ? "Stop being owner" : "Make owner"}
              </button>
              <button
                type="button"
                onClick={() => answer({ type: "sender.revoke", commandId: uuid<CommandId>(), platform: s.platform, senderId: s.senderId })}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">No chat sender is paired. gateway.yaml's allowFrom lets senders in without pairing.</p>
      )}
    </section>
  );
};
