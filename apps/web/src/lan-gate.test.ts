import { expect, test } from "bun:test";
import { hostProblem, isLocalAddress } from "./lan-gate.ts";

test("only loopback, private and tailnet addresses count as the local network", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.8",
    "172.16.0.1",
    "172.31.255.1",
    "192.168.1.20",
    "169.254.3.4",
    "100.64.0.1",
    "100.127.255.254",
    "::1",
    "fd12::1",
    "fd7a:115c:a1e0::1",
    "fe80::1",
    "::ffff:192.168.1.20",
    "::ffff:100.101.102.103",
  ])
    expect([ip, isLocalAddress(ip)]).toEqual([ip, true]);
  for (const ip of [
    "8.8.8.8",
    "172.32.0.1",
    "172.15.0.1",
    "192.169.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "2001:db8::1",
    "::ffff:8.8.8.8",
    "localhost",
    "",
  ])
    expect([ip, isLocalAddress(ip)]).toEqual([ip, false]);
});

test("--host takes every interface or a local or tailnet address, and refuses a public one naming the fix", () => {
  expect(hostProblem("0.0.0.0")).toBeUndefined();
  expect(hostProblem("::")).toBeUndefined();
  expect(hostProblem("192.168.1.20")).toBeUndefined();
  expect(hostProblem("100.101.102.103")).toBeUndefined();
  expect(hostProblem("203.0.113.9")).toContain("is a public address");
  expect(hostProblem("my-pc")).toContain("takes an IP address");
});
