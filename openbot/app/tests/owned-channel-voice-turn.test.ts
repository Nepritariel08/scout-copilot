import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import type { StoredThread } from "@/lib/copilot/thread-messages";
import { createOwnedChannelVoiceTurn } from "@/lib/voice/owned-channel-turn";

const old = {
  id: "old",
  role: "assistant",
  content: "Earlier",
} satisfies Message;
const reply = {
  id: "saved-new",
  role: "assistant",
  content: "Saved reply",
} satisfies Message;
function fixture() {
  const target: { messages: Message[] } = { messages: [old] };
  let sends = 0;
  let reads = 0;
  let current = true;
  const cancelled: unknown[] = [];
  let send: () => Promise<void> = async () => {};
  let stored: StoredThread = {
    messages: [old, reply],
    unreadable: 0,
    availability: "ready",
  };
  const voice = createOwnedChannelVoiceTurn({
    threadId: "original-thread",
    isCurrent: () => current,
    assistantIds: (agent: typeof target) =>
      new Set(agent.messages.map((message) => message.id)),
    replyId: (agent) =>
      agent.messages.findLast((message) => message.role === "assistant")?.id,
    send: async (_text, hooks) => {
      if (hooks.skipIf()) return;
      hooks.onTarget(target);
      sends++;
      await send();
      target.messages.push(reply);
    },
    read: async () => {
      reads++;
      return stored;
    },
    cancel: async (agent) => {
      cancelled.push(agent);
    },
  });
  return {
    voice,
    target,
    cancelled,
    counts: () => ({ sends, reads }),
    navigate: () => {
      current = false;
    },
    setSend: (next: typeof send) => {
      send = next;
    },
    setStored: (next: StoredThread) => {
      stored = next;
    },
  };
}

test("voice sends once and returns only the new saved assistant identifiers", async () => {
  const f = fixture();
  expect(
    await f.voice.ask("Spoken request", new AbortController().signal),
  ).toEqual({ threadId: "original-thread", messageId: "saved-new" });
  expect(f.counts()).toEqual({ sends: 1, reads: 1 });
  expect(f.voice.isAsking()).toBe(false);
  await f.voice.cancel();
  expect(f.cancelled).toEqual([]);
});

for (const [name, stored] of Object.entries({
  unavailable: { messages: [], unreadable: 0, availability: "unavailable" },
  damaged: { messages: [reply], unreadable: 1, availability: "ready" },
  old: { messages: [old], unreadable: 0, availability: "ready" },
  anotherReply: {
    messages: [reply, { ...reply, id: "another-device-reply" }],
    unreadable: 0,
    availability: "ready",
  },
  tool: {
    messages: [
      {
        ...reply,
        toolCalls: [
          {
            id: "t",
            type: "function",
            function: { name: "tool", arguments: "{}" },
          },
        ],
      },
    ],
    unreadable: 0,
    availability: "ready",
  },
  empty: {
    messages: [{ ...reply, content: " " }],
    unreadable: 0,
    availability: "ready",
  },
} satisfies Record<string, StoredThread>)) {
  test(`voice pauses on ${name} saved history without replaying the model`, async () => {
    const f = fixture();
    f.setStored(stored);
    await expect(
      f.voice.ask("Speak", new AbortController().signal),
    ).rejects.toThrow("saved history");
    expect(f.counts()).toEqual({ sends: 1, reads: 1 });
  });
}

test("Stop cancels only the captured voice agent and holds the pending turn", async () => {
  const f = fixture();
  let finish = () => {};
  f.setSend(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const ask = f.voice.ask("Speak", controller.signal);
  f.navigate();
  controller.abort();
  await f.voice.cancel();
  expect(f.cancelled).toEqual([f.target]);
  expect(f.voice.isAsking()).toBe(true);
  await expect(
    f.voice.ask("Another", new AbortController().signal),
  ).rejects.toThrow();
  finish();
  await expect(ask).rejects.toThrow("stopped");
  expect(f.counts()).toEqual({ sends: 1, reads: 0 });
  expect(f.voice.isAsking()).toBe(false);
});

test("a cancelled or replaced identity never sends a voice turn", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(f.voice.ask("Speak", controller.signal)).rejects.toThrow();
  f.navigate();
  await expect(
    f.voice.ask("Speak", new AbortController().signal),
  ).rejects.toThrow();
  expect(f.counts()).toEqual({ sends: 0, reads: 0 });
});

test("an uncertain send is not retried or read back as a successful voice reply", async () => {
  const f = fixture();
  f.setSend(async () => {
    throw new Error("Transport outcome unknown");
  });
  await expect(
    f.voice.ask("Speak", new AbortController().signal),
  ).rejects.toThrow("unknown");
  expect(f.counts()).toEqual({ sends: 1, reads: 0 });
  expect(f.voice.isAsking()).toBe(false);
});
