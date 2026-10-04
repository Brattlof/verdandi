# 0036 · Chats bind to threads, and replies go through an outbox

## Status

Accepted (issue #213, 2026-10-04). Builds on #212's access module (ADR 0025 boundary 6) and #223, which took `send_message` out of DESIGN §9.6.

## Context

The gateway binds each chat to a thread (DESIGN §15). Gateway messages are untrusted data, so a tool that sends to any channel plus an injected instruction is a way to send data out. Hermes keeps that tool away from the model, and OpenClaw replies only to the channel a message came from. A reply can also be lost, or sent twice, when the process stops mid-send. Hermes keeps a delivery ledger for that, but it keeps pending approvals in memory and loses them on restart. The owner picked Telegram as the first platform (DESIGN §23, question 5), and decided that a turn a sender other than the owner starts gets none of `workspace.yaml`'s folders (question 10).

## Decision

1. **Binding keys are one pure function** (`bindingKey` in `packages/contracts/src/gateway.ts`), golden-tested. Under an explicit `IsolationPolicy` it maps platform, chat type, chat, platform thread and sender to a key. A DM is its own conversation, a group gives each sender their own, and a platform thread is shared by its participants. A shared key's messages carry the sender's name in the user message, never the system prompt.
2. **Bindings are events.** `channel.bound` (key, platform, chat, platform thread, `confined`) and `channel.unbound` are recorded on the thread's stream. A key goes to one thread and a thread replies to one key. A new conversation is a thread in the profile's workspace. `confined` is set when someone other than the platform's owner can write in the conversation, and it marks the thread for good (`threads.confined`). The reactor then runs it with `HarnessRunInput.confined`: Claude Code leaves `workspace.yaml`'s folders out of `additionalDirectories`, and the native harness leaves them out of its file tools' reach and its prompt. Either way the agent asks before working outside the workspace.
3. **Replies go only to the binding.** The decider appends `delivery.requested` to the same decision as a bound thread's `turn.completed` (with the turn's last main-agent reply) or as any request event (with Approve and Deny buttons). Both commit in one transaction, and nothing on the model's side names a destination. A delivery id is `reply:<turn>` or `request:<request>`, so the pure decider needs no random ids.
4. **At-least-once delivery.** The gateway records `delivery.attempted`, sends, then records `delivery.reported`. At start it resumes every delivery that is requested, attempted or failed. One that was attempted but never reported is sent with a "possibly a repeat" line first. A failure waits 30 seconds, doubling, and after 3 attempts or 24 hours the delivery is `delivery.abandoned`, a `notice` on the turn. A chat that's gone (Telegram's 403 or "chat not found") is abandoned at once. A delivery for a platform this verdandid doesn't run waits for one that does.
5. **Progress stays out of the outbox.** Each turn of a bound thread gets one message that's edited in place, at most every 5 seconds. It's lost on a crash, and that's fine. Replies are split at Telegram's 4,096 characters at line ends, and a code fence a split falls in is closed and reopened.
6. **Telegram over `fetch`** (`apps/agent/src/gateway/telegram.ts`), with no SDK:
   - long polling with `getUpdates`, which an interrupt aborts;
   - inline keyboards whose callback data is the command line (`approve <request>`), offered as a typed command when it's over 64 bytes;
   - `setMyCommands` built from the slash-command registry.

   The token comes from `VERDANDI_TELEGRAM_BOT_TOKEN` or the OS keychain (`verdandi key set telegram`). It's read only by an always-on verdandid, kept out of child processes with the provider keys, and never put in an error message.

## Consequences

- An injected instruction can't send a reply anywhere but the chat the thread is bound to. Unbinding (`/unbind`, the web's Unbind, `/new`) stops replies, and the chat's next message starts a new thread.
- A reply can arrive twice after a crash, marked as such. It's never lost while the delivery's limits hold.
- An agent's question (`user-input.requested`) can only be declined from a chat app; answering it needs the terminal chat or the web UI until option buttons come.
- A chat's mode (`/ask`, `/plan`, `/build`) lives in memory and starts over as build after a restart.
- The tests are `packages/contracts/src/gateway.test.ts` (binding keys), `apps/agent/src/gateway/conversations.test.ts` (a delivery cut off between attempt and report is resent once after a restart, to the bound chat only, and buttons, confinement and `/new`), and `apps/agent/src/gateway/telegram.test.ts` (facts, splitting and the Bot API calls, on an injected `fetch`).
