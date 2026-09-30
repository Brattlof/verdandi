import { expect, test } from "bun:test";
import { uuid } from "./client.ts";

test("makes v4 UUIDs without crypto.randomUUID, which browsers drop outside secure contexts such as http://<LAN address>", () => {
  const randomUUID = crypto.randomUUID;
  // @ts-expect-error: removed as a browser does on a page served over plain HTTP from a LAN address.
  crypto.randomUUID = undefined;
  try {
    const ids = [uuid<string>(), uuid<string>()];
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).not.toBe(ids[1]);
  } finally {
    crypto.randomUUID = randomUUID;
  }
});
