import type { CommandId, DeviceId, DevicesView, PairingRequest, PairMessage } from "@verdandi/contracts";
import { useEffect, useState } from "react";
import { type Connection, uuid } from "../client.ts";
import { RuneMark, RuneText } from "../ui/runes.tsx";

/** The code a device shows, split in two so it's read back without losing a digit. */
const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * Paired devices and pairing requests, kept current from `DevicesSubscribe` (ADR 0028). One feed for the page, which
 * the banner and the Devices page both read.
 */
export const useDevices = (connection: Connection) => {
  const [view, setView] = useState<DevicesView>();
  useEffect(
    () =>
      connection.follow(
        (rpc, subscriptionId) => rpc.DevicesSubscribe({ subscriptionId }),
        setView,
        () => {},
      ),
    [connection],
  );
  return view;
};

/** A waiting pairing request: its device, address and code, and Approve or Deny. */
const RequestRow = ({ connection, request }: { connection: Connection; request: PairingRequest }) => {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const answer = async (approve: boolean) => {
    setSending(true);
    const result = await connection.answerPairing(request.requestId, approve);
    setSending(false);
    if (!result.ok) setError(result.message);
  };
  return (
    <li className="border border-line border-l-2 border-l-warn bg-card px-4 py-3">
      <p className="font-medium">
        {request.name} <span className="text-muted">from {request.address}</span>
      </p>
      <p className="mt-1">
        Code <span className="font-mono text-lg tracking-widest">{spaced(request.code)}</span>
      </p>
      <p className="text-xs text-muted">
        Approve only if the device shows this code. Asked {when(request.at)}; {request.userAgent}
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
        <button type="button" className="border-go bg-go text-on-go hover:bg-go-hover" disabled={sending} onClick={() => answer(true)}>
          Approve
        </button>
      </div>
    </li>
  );
};

/** Shown on every page but Devices while a device asks to pair, so the owner sees it wherever they are. */
export const PairingBanner = ({ view }: { view: DevicesView | undefined }) => {
  const first = view?.pending[0];
  if (!first) return null;
  const more = (view?.pending.length ?? 1) - 1;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-2 border-b border-line bg-user px-4 py-2 text-sm">
      {first.name} from {first.address} asks to pair, showing code <span className="font-mono">{spaced(first.code)}</span>
      {more > 0 && ` (and ${more} more)`}.<a href="#view=devices">Review it on Devices</a>
    </div>
  );
};

/** The Devices page: requests to approve or deny, and each paired device with when it was last seen and Revoke. */
export const DevicesPage = ({ connection, view }: { connection: Connection; view: DevicesView | undefined }) => {
  const [error, setError] = useState<string>();
  const revoke = async (deviceId: DeviceId) => {
    const result = await connection.dispatch({ type: "device.revoke", commandId: uuid<CommandId>(), deviceId });
    setError(result.ok ? undefined : result.message);
  };
  const active = view?.devices.filter((d) => !d.revoked) ?? [];
  const revoked = view?.devices.filter((d) => d.revoked) ?? [];
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[860px] px-5 py-10 sm:px-8 sm:py-14">
        <header className="mb-6">
          <p className="flex items-center gap-3 text-rune">
            <RuneText runes={["ehwaz"]} className="h-4" />
            <span className="eyebrow text-muted">Ehwaz · the horse, and the trust between horse and rider</span>
          </p>
          <h1 className="mt-3 font-serif text-5xl leading-[0.95] font-bold tracking-tight uppercase sm:text-6xl">Devices</h1>
          <p className="mt-3 max-w-2xl text-muted">
            A device other than this machine's own browser pairs before it gets in: it shows a code, you approve it here, in the terminal
            chat, or with <span className="font-mono">verdandi devices approve</span>. Revoking a device closes its connections at once.
          </p>
        </header>
        <section aria-labelledby="pairing-requests" className="mb-8">
          <h2 id="pairing-requests" className="eyebrow mb-2 text-muted">
            Asking to pair
          </h2>
          {view?.pending.length ? (
            <ul className="flex flex-col gap-2">
              {view.pending.map((r) => (
                <RequestRow key={r.requestId} connection={connection} request={r} />
              ))}
            </ul>
          ) : (
            <p className="text-muted">No device is asking.</p>
          )}
        </section>
        <section aria-labelledby="paired-devices">
          <h2 id="paired-devices" className="eyebrow mb-2 text-muted">
            Paired
          </h2>
          {error && (
            <p role="alert" className="mb-2 text-xs text-error">
              {error}
            </p>
          )}
          {active.length === 0 && <p className="text-muted">No device is paired.</p>}
          <ul className="divide-y divide-line">
            {active.map((d) => (
              <li key={d.deviceId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{d.name}</span>
                  <span className="block text-xs text-muted">
                    Paired {when(d.pairedAt)} · {d.lastSeen ? `last seen ${when(d.lastSeen)}` : "not seen yet"}
                  </span>
                </span>
                <button type="button" onClick={() => revoke(d.deviceId)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
          {revoked.length > 0 && (
            <details className="mt-4 text-sm text-muted">
              <summary>Revoked ({revoked.length})</summary>
              <ul className="mt-1">
                {revoked.map((d) => (
                  <li key={d.deviceId}>
                    {d.name}, paired {when(d.pairedAt)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </div>
    </div>
  );
};

type PairState =
  | { readonly kind: "asking" }
  | { readonly kind: "pending"; readonly requestId: string; readonly code: string }
  | { readonly kind: "refused"; readonly message: string };

/**
 * What a device without access sees: it asks to pair over `/pair` on `base`, shows the code to read to the owner, and
 * calls `onPaired` with its device token once approved. Refused, or cut off, it says why and can ask again.
 */
export const Pairing = ({ base, onPaired }: { base: string; onPaired: (token: string) => void }) => {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PairState>({ kind: "asking" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: each attempt opens a new request.
  useEffect(() => {
    setState({ kind: "asking" });
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}/pair`);
    let done = false;
    socket.onmessage = (e) => {
      const message = JSON.parse(String(e.data)) as PairMessage;
      if (message.kind === "pending") return setState(message);
      done = true;
      if (message.kind === "approved") onPaired(message.token);
      else setState(message);
    };
    socket.onclose = () => {
      if (!done) setState({ kind: "refused", message: "Lost the connection before the owner answered." });
    };
    return () => {
      done = true;
      socket.close();
    };
  }, [base, attempt]);
  return (
    <div className="grid h-dvh place-items-center p-6">
      <div className="max-w-md border border-line bg-card px-6 py-5">
        <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold">
          <RuneMark className="size-7" />
          Pair this device
        </h1>
        <div aria-live="polite">
          {state.kind === "asking" && <p className="mt-2 text-muted">Asking Verdandi…</p>}
          {state.kind === "pending" && (
            <>
              <p className="mt-2">Verdandi lets this device in once its owner approves it. The request shows this code:</p>
              <p className="my-3 text-center font-mono text-4xl tracking-widest">{spaced(state.code)}</p>
              <p className="text-sm text-muted">
                Approve it where Verdandi is already open: the web UI's Devices page, the terminal chat, or{" "}
                <span className="font-mono [overflow-wrap:anywhere]">verdandi devices approve {state.requestId}</span>. Keep this page open
                meanwhile.
              </p>
            </>
          )}
          {state.kind === "refused" && (
            <>
              <p role="alert" className="mt-2 text-error">
                {state.message}
              </p>
              <button type="button" className="mt-3" onClick={() => setAttempt((n) => n + 1)}>
                Ask again
              </button>
            </>
          )}
        </div>
        <p className="mt-4 text-xs text-muted">
          On the machine running Verdandi, <span className="font-mono">verdandi web</span> opens a page that needs no pairing.
        </p>
      </div>
    </div>
  );
};
