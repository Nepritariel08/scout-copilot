import { expect, test } from "bun:test";
import type { OwnedSpeechMessage } from "@openbot/shared/owned-voice";
import {
  type ConversationAudio,
  OWNED_CONVERSATION,
  OwnedConversation,
  OwnedUtteranceGate,
} from "@/lib/voice/owned-conversation";

const saved = { threadId: "synthetic-thread", messageId: "synthetic-answer" };
const clip = new Blob(["synthetic"], { type: "audio/webm" });
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function fixture() {
  let now = 1_000,
    nextTimer = 0,
    current = true;
  const timers = new Map<number, { at: number; work(): void }>();
  const events: string[] = [];
  const phases: string[] = [];
  let utterance = () => {};
  let speech = false;
  let record = async () => ({
    stream: {} as MediaStream,
    finish: async () => {
      events.push("mic-finished");
      return clip;
    },
    cancel: () => {
      events.push("mic-cancelled");
    },
  });
  let transcribe = async () => "Synthetic user words";
  let ask = async (
    _text: string,
    _signal: AbortSignal,
  ): Promise<OwnedSpeechMessage> => saved;
  let output = async () => clip;
  let play = async (_audio: Blob, _signal: AbortSignal) => {};
  const audio: ConversationAudio = {
    async resume() {
      events.push("audio-resumed");
    },
    detect(_stream, end) {
      utterance = end;
      events.push("detector-started");
      return {
        stop: () => {
          events.push("detector-stopped");
        },
        hasSpeech: () => speech,
      };
    },
    speak: async (data, signal) => {
      events.push("play");
      await play(data, signal);
    },
    close: () => {
      events.push("audio-closed");
    },
  };
  const session = new OwnedConversation({
    audio: () => audio,
    record: async () => {
      events.push("record");
      return record();
    },
    transcribe: async () => {
      events.push("asr");
      return transcribe();
    },
    ask: async (text, signal) => {
      events.push("ask");
      return ask(text, signal);
    },
    speech: async (message) => {
      expect(message).toEqual(saved);
      events.push("tts");
      return output();
    },
    cancelOwnTurn: () => {
      events.push("cancel-own");
    },
    current: () => current,
    now: () => now,
    setTimer: (work, ms) => {
      const id = ++nextTimer;
      timers.set(id, { at: now + ms, work });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      timers.delete(timer as unknown as number);
    },
  });
  session.subscribe(() => phases.push(session.getSnapshot().phase));
  return {
    session,
    events,
    phases,
    emit: () => {
      speech = true;
      utterance();
    },
    voiced: (value: boolean) => {
      speech = value;
    },
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now && timers.delete(id)) timer.work();
      await flush();
    },
    current: (value: boolean) => {
      current = value;
    },
    record: (value: typeof record) => {
      record = value;
    },
    transcribe: (value: typeof transcribe) => {
      transcribe = value;
    },
    ask: (value: typeof ask) => {
      ask = value;
    },
    output: (value: typeof output) => {
      output = value;
    },
    play: (value: typeof play) => {
      play = value;
    },
  };
}

test("one complete voice cycle closes mic before exactly one ask and listens only after playback", async () => {
  const f = fixture();
  const speaking = Promise.withResolvers<void>();
  f.play(() => speaking.promise);
  f.session.start();
  expect(f.events[0]).toBe("audio-resumed");
  await flush();
  expect(f.session.getSnapshot().phase).toBe("listening");
  f.emit();
  f.emit();
  await flush();
  expect(f.session.getSnapshot().phase).toBe("speaking");
  expect(f.events.filter((x) => x === "ask")).toHaveLength(1);
  expect(f.events.indexOf("mic-finished")).toBeLessThan(
    f.events.indexOf("asr"),
  );
  expect(f.events.filter((x) => x === "record")).toHaveLength(1);
  f.emit();
  await flush();
  expect(f.events.filter((x) => x === "asr")).toHaveLength(1);
  speaking.resolve();
  await flush();
  expect(f.session.getSnapshot().phase).toBe("listening");
  expect(f.events.filter((x) => x === "record")).toHaveLength(2);
  f.session.stop();
  expect(f.events).not.toContain("cancel-own");
});

test("quiet rollovers make no ASR/model calls; unfinished thirty-second speech is discarded", async () => {
  const f = fixture();
  f.session.start();
  await flush();
  await f.advance(30_000);
  expect(f.events.filter((x) => x === "record")).toHaveLength(2);
  expect(f.events).not.toContain("asr");
  f.session.stop();
  const noisy = fixture();
  noisy.session.start();
  await flush();
  // A stuck loud utterance is represented by a detector that saw speech but never its quiet tail.
  noisy.voiced(true);
  await noisy.advance(30_000);
  expect(noisy.session.getSnapshot().phase).toBe("paused");
  expect(noisy.events).not.toContain("asr");
  expect(noisy.events).not.toContain("ask");
  noisy.session.stop();
});

test("local gate ignores silence/broadband noise and requires sustained speech plus quiet tail", () => {
  for (const [rms, crossings] of [
    [0.001, 0.1],
    [0.1, 0.5],
    [0.6, 0.1],
    [0.05, 0.005],
  ]) {
    const gate = new OwnedUtteranceGate();
    for (let now = 1000; now <= 31_000; now += 50)
      expect(gate.push(rms ?? 0, crossings ?? 0, now)).toBe(false);
    expect(gate.hasSpeech()).toBe(false);
  }
  const gate = new OwnedUtteranceGate();
  for (let now = 1000; now <= 1500; now += 50)
    expect(gate.push(0.04, 0.1, now)).toBe(false);
  expect(gate.hasSpeech()).toBe(true);
  for (let now = 1550; now < 2550; now += 50)
    expect(gate.push(0.001, 0.1, now)).toBe(false);
  expect(gate.push(0.001, 0.1, 2550)).toBe(true);
  expect(gate.push(0.001, 0.1, 2600)).toBe(false);
});

test("stop during microphone permission cancels its late stream", async () => {
  const f = fixture();
  const permission =
    Promise.withResolvers<
      Awaited<ReturnType<Parameters<typeof f.record>[0]>>
    >();
  f.record(() => permission.promise);
  f.session.start();
  await flush();
  f.session.stop();
  permission.resolve({
    stream: {} as MediaStream,
    finish: async () => clip,
    cancel: () => {
      f.events.push("late-mic-cancelled");
    },
  });
  await flush();
  expect(f.events).toContain("late-mic-cancelled");
  expect(f.events).not.toContain("asr");
});

test("late ASR after stop cannot ask or resume listening", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<string>();
  f.transcribe(() => pending.promise);
  f.session.start();
  await flush();
  f.emit();
  await flush();
  expect(f.session.getSnapshot().phase).toBe("transcribing");
  f.session.stop();
  pending.resolve("Must not be sent");
  await flush();
  expect(f.events).not.toContain("ask");
  expect(f.session.getSnapshot().phase).toBe("idle");
});

test("stopped unknown ask is cancelled only once, stays settling and is never replayed", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<OwnedSpeechMessage>();
  f.ask(() => pending.promise);
  f.session.start();
  await flush();
  f.emit();
  await flush();
  expect(f.session.getSnapshot().phase).toBe("asking");
  f.session.stop();
  f.session.stop();
  f.session.start();
  expect(f.events.filter((x) => x === "cancel-own")).toHaveLength(1);
  expect(f.session.getSnapshot().settling).toBe(true);
  pending.resolve(saved);
  await flush();
  expect(f.events).not.toContain("tts");
  expect(f.events.filter((x) => x === "ask")).toHaveLength(1);
  expect(f.session.getSnapshot().settling).toBe(false);
});

test("late TTS and playback rejection pause without recording again or retrying model", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<Blob>();
  f.output(() => pending.promise);
  f.session.start();
  await flush();
  f.emit();
  await flush();
  f.session.stop();
  pending.resolve(clip);
  await flush();
  expect(f.events).not.toContain("play");
  expect(f.events.filter((x) => x === "record")).toHaveLength(1);
  const blocked = fixture();
  blocked.play(async () => {
    throw new DOMException("blocked", "NotAllowedError");
  });
  blocked.session.start();
  await flush();
  blocked.emit();
  await flush();
  expect(blocked.session.getSnapshot().phase).toBe("paused");
  expect(blocked.events.filter((x) => x === "ask")).toHaveLength(1);
  expect(blocked.events.filter((x) => x === "record")).toHaveLength(1);
});

test("stop during audible playback closes audio and cannot restart listening on a late end", async () => {
  const f = fixture();
  const playing = Promise.withResolvers<void>();
  f.play(() => playing.promise);
  f.session.start();
  await flush();
  f.emit();
  await flush();
  expect(f.events).toContain("play");
  f.session.stop();
  playing.resolve();
  await flush();
  expect(f.events).toContain("audio-closed");
  expect(f.events.filter((x) => x === "record")).toHaveLength(1);
  expect(f.events).not.toContain("cancel-own");
});

test("unknown/unsaved reply and network failures never retry or synthesize client text", async () => {
  for (const result of [
    () => Promise.reject(new Error("unknown")),
    async () =>
      ({
        text: "not saved",
        url: "https://external.invalid",
      }) as unknown as OwnedSpeechMessage,
  ]) {
    const f = fixture();
    f.ask(result);
    f.session.start();
    await flush();
    f.emit();
    await flush();
    expect(f.session.getSnapshot().phase).toBe("paused");
    expect(f.events.filter((x) => x === "ask")).toHaveLength(1);
    expect(f.events).not.toContain("tts");
  }
});

test("native/channel transition and maximum session end close resources without new calls", async () => {
  const f = fixture();
  f.session.start();
  await flush();
  f.current(false);
  f.emit();
  await flush();
  expect(f.events).not.toContain("asr");
  expect(f.events).toContain("audio-closed");
  const time = fixture();
  time.session.start();
  await flush();
  await time.advance(OWNED_CONVERSATION.maxSessionMs);
  expect(time.session.getSnapshot().phase).toBe("paused");
  expect(time.events).not.toContain("ask");
});

test("eight completed voice turns end the session, with no ninth microphone or model call", async () => {
  const f = fixture();
  f.session.start();
  await flush();
  for (let turn = 0; turn < 8; turn++) {
    f.emit();
    await flush();
  }
  expect(f.events.filter((x) => x === "ask")).toHaveLength(8);
  expect(f.events.filter((x) => x === "record")).toHaveLength(8);
  expect(f.session.getSnapshot().phase).toBe("paused");
  expect(f.session.getSnapshot().turns).toBe(8);
});
