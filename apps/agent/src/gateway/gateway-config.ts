import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "@verdandi/contracts";
import { Schema } from "effect";
import { defaultAccess, type PlatformAccess } from "./access.ts";

/** A chat app's id for someone or a chat. YAML reads a bare number as a number, so both are taken. */
const Id = Schema.Union([Schema.String, Schema.Number]);

const PlatformFile = Schema.Struct({
  dm: Schema.optionalKey(Schema.Literals(["pairing", "allowlist", "disabled"])),
  allowFrom: Schema.optionalKey(Schema.Array(Id)),
  groups: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ senders: Schema.optionalKey(Schema.Array(Id)) }))),
});
/**
 * `gateway.yaml` in the Verdandi home (DESIGN §15): each chat app's access rules. No key sets an `open` mode, and none
 * sets the owner, which only the web UI or the CLI does.
 *
 * ```yaml
 * telegram:
 *   dm: pairing            # or allowlist, or disabled
 *   allowFrom: [123456789] # let in without pairing
 *   groups:                # none by default
 *     "-1001234567890": { senders: [123456789] } # leave senders out to let anyone in the group start turns
 * ```
 */
const GatewayFile = Schema.Struct({ telegram: Schema.optionalKey(PlatformFile) });

export type GatewayConfig = Partial<Record<Platform, PlatformAccess>>;

export const gatewaySettingsFile = (home: string) => join(home, "gateway.yaml");

const ids = (list: readonly (string | number)[] | undefined) => (list ?? []).map(String);

/**
 * Read when an always-on verdandid starts, never one a chat runs. A broken file stops it, naming the file and key. A
 * platform it leaves out gets the defaults: pairing in DMs, no groups.
 */
export const loadGatewayConfig = (home: string): GatewayConfig => {
  const file = gatewaySettingsFile(home);
  if (!existsSync(file)) return {};
  try {
    const data = Schema.decodeUnknownSync(GatewayFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, { onExcessProperty: "error" });
    return Object.fromEntries(
      Object.entries(data).map(([platform, p]): [string, PlatformAccess] => [
        platform,
        {
          dm: p.dm ?? defaultAccess.dm,
          allowFrom: ids(p.allowFrom),
          groups: Object.fromEntries(
            Object.entries(p.groups ?? {}).map(([chat, g]) => [chat, g.senders === undefined ? {} : { senders: ids(g.senders) }]),
          ),
        },
      ]),
    );
  } catch (e) {
    throw new Error(
      `${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file (each platform, e.g. telegram, takes dm: pairing, allowlist or disabled; allowFrom: a list of sender ids; groups: chat ids, each with an optional senders list), or delete it.`,
    );
  }
};
