import { type CommandId, type TrustedCommands, trustFiles } from "@verdandi/contracts";
import { useCallback, useEffect, useState } from "react";
import { type Connection, uuid } from "../client.ts";

/**
 * The project commands the user let Verdandi run (verifiers and worktree setup), fetched when the projects page opens,
 * each with Revoke: Verdandi then asks again before it runs that list.
 */
export const TrustedCommandsList = ({ connection }: { connection: Connection }) => {
  const [trusted, setTrusted] = useState<readonly TrustedCommands[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    void connection.trusted().then(setTrusted);
  }, [connection]);
  useEffect(load, [load]);
  const revoke = async (t: TrustedCommands) => {
    const result = await connection.dispatch({
      type: "commands.trust.revoke",
      commandId: uuid<CommandId>(),
      threadId: t.threadId,
      hash: t.hash,
    });
    setError(result.ok ? undefined : result.message);
    load();
  };
  if (!trusted || trusted.length === 0) return null;
  return (
    <section aria-labelledby="trusted-commands" className="mt-12">
      <h2 id="trusted-commands" className="eyebrow mb-1 text-muted">
        Trusted project commands
      </h2>
      <p className="mb-4 text-xs text-muted">Verdandi runs these without asking. If a project changes one, it asks again.</p>
      {error && (
        <p role="alert" className="mb-2 text-xs text-error">
          {error}
        </p>
      )}
      <ul className="divide-y divide-line border-y border-line">
        {trusted.map((t) => (
          <li key={`${t.projectId}-${t.hash}`} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted [overflow-wrap:anywhere]">
                {t.purpose === "verifiers" ? "Verifiers" : "Worktree setup"} from <span className="font-mono">{trustFiles[t.purpose]}</span>{" "}
                in <span className="font-mono">{t.projectPath}</span>
              </p>
              <pre className="mt-1 whitespace-pre-wrap font-mono">{t.commands.join("\n")}</pre>
            </div>
            <button type="button" className="px-2 text-xs" onClick={() => void revoke(t)}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
};
