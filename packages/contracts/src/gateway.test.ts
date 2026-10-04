import { expect, test } from "bun:test";
import { bindingKey, defaultIsolation, type IsolationPolicy } from "./gateway.ts";

const dm = { platform: "telegram", chatType: "dm", chatId: "42", senderId: "42" } as const;
const group = { platform: "telegram", chatType: "group", chatId: "-100", senderId: "7" } as const;
const topic = { ...group, platformThread: "5" };
const shared: IsolationPolicy = { group: "shared", platformThread: "shared" };
const apart: IsolationPolicy = { group: "per-sender", platformThread: "per-sender" };

const cases: readonly (readonly [string, Parameters<typeof bindingKey>[0], IsolationPolicy, ReturnType<typeof bindingKey>])[] = [
  ["a DM is its own conversation", dm, defaultIsolation, { key: "telegram:42", shared: false }],
  ["a DM stays its own under any policy", dm, shared, { key: "telegram:42", shared: false }],
  ["a group gives each sender their own by default", group, defaultIsolation, { key: "telegram:-100:sender:7", shared: false }],
  ["a group can share one", group, shared, { key: "telegram:-100", shared: true }],
  ["a platform thread is shared by its participants by default", topic, defaultIsolation, { key: "telegram:-100:thread:5", shared: true }],
  ["a platform thread can give each sender their own", topic, apart, { key: "telegram:-100:thread:5:sender:7", shared: false }],
  [
    "ids can't run into each other's parts",
    { ...group, chatId: "a:sender:b", senderId: "c" },
    defaultIsolation,
    { key: "telegram:a%3Asender%3Ab:sender:c", shared: false },
  ],
];

for (const [name, message, policy, expected] of cases) {
  test(name, () => {
    expect(bindingKey(message, policy)).toEqual(expected);
  });
}
