import { expect, test } from "bun:test";
import type { QuotaView } from "./rpc.ts";
import { describeCost, describeQuota } from "./spend.ts";

test("metered and subscription cost are shown apart, never summed", () => {
  expect(describeCost({ meteredUsd: 0.125, subscriptionUsd: 0.004 })).toBe("$0.13 paid · <$0.01 on plan");
  expect(describeCost({ meteredUsd: 0, subscriptionUsd: 0.4 })).toBe("$0.40 on plan");
  expect(describeCost({ meteredUsd: 0, subscriptionUsd: 0 })).toBe("");
});

test("a quota line says when turns run on extra usage and when a reset is already past", () => {
  const view = (quota: QuotaView["quota"]): QuotaView => ({ harness: "claude-code", quota, at: "2026-09-30T12:00:00.000Z" });
  const now = Date.parse("2026-09-30T13:00:00.000Z");
  const time = (iso: string) => iso.slice(11, 16);
  expect(
    describeQuota(
      view({
        status: "allowed_warning",
        window: "seven_day",
        utilization: 0.81,
        resetsAt: "2026-10-01T15:00:00.000Z",
        usingOverage: false,
      }),
      time,
      now,
    ),
  ).toBe("Claude Code: weekly plan nearly used up (81% used); resets 15:00");
  expect(describeQuota(view({ status: "rejected", window: "five_hour", usingOverage: true }), time, now)).toBe(
    "Claude Code: 5-hour limit reached; running on extra usage, priced as metered",
  );
  expect(describeQuota(view({ status: "rejected", resetsAt: "2026-09-30T12:30:00.000Z", usingOverage: false }), time, now)).toBe(
    "Claude Code: limit reached; turns fail until it resets; reset at 12:30, the next turn updates this",
  );
});
