import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { OwnedVoiceConversation } from "@/components/channels/owned-voice-conversation";
import * as recording from "@/lib/dictation/recording";
import * as audio from "@/lib/voice/owned-conversation-audio";
import { settleReactWork } from "./settle-react-work";

const restores: (() => void)[] = [];
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  for (const restore of restores.splice(0)) restore();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
function media() {
  let closed = 0,
    cancelled = 0,
    resumes = 0;
  const supported = spyOn(audio, "ownedConversationSupported").mockReturnValue(
    true,
  );
  const create = spyOn(
    audio,
    "createOwnedConversationAudio",
  ).mockImplementation(() => ({
    async resume() {
      resumes++;
    },
    detect() {
      return { stop() {}, hasSpeech: () => false };
    },
    async speak() {},
    close() {
      closed++;
    },
  }));
  const record = spyOn(recording, "startRecording").mockResolvedValue({
    stream: {} as MediaStream,
    finish: async () => new Blob(["synthetic"]),
    cancel() {
      cancelled++;
    },
  });
  restores.push(
    () => supported.mockRestore(),
    () => create.mockRestore(),
    () => record.mockRestore(),
  );
  return {
    create,
    record,
    closed: () => closed,
    cancelled: () => cancelled,
    resumes: () => resumes,
  };
}

test("continuous voice never starts on mount and exposes a persistent Stop control", async () => {
  const f = media();
  const busy: boolean[] = [];
  const view = render(
    <OwnedVoiceConversation
      enabled
      identityKey="synthetic-owner:one"
      ask={async () => ({ threadId: "t", messageId: "m" })}
      cancelOwnTurn={() => {}}
      onBusyChange={(value) => busy.push(value)}
    />,
  );
  expect(f.create).not.toHaveBeenCalled();
  expect(f.record).not.toHaveBeenCalled();
  expect(view.getByRole("button", { name: "Stop voice" })).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "Start hands-free voice" }));
  expect(f.resumes()).toBe(1);
  expect(busy.at(-1)).toBe(true);
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toContain("Listening"),
  );
  fireEvent.click(view.getByRole("button", { name: "Stop voice" }));
  expect(f.cancelled()).toBe(1);
  expect(f.closed()).toBe(1);
  expect(busy.at(-1)).toBe(false);
});

test("pagehide and identity transition stop recording without asking or automatically restarting", async () => {
  const f = media();
  let asks = 0;
  const ask = async () => {
    asks++;
    return { threadId: "t", messageId: "m" };
  };
  const cancel = () => {};
  const view = render(
    <OwnedVoiceConversation
      enabled
      identityKey="synthetic-owner:one"
      ask={ask}
      cancelOwnTurn={cancel}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "Start hands-free voice" }));
  await waitFor(() => expect(f.record).toHaveBeenCalledTimes(1));
  fireEvent(window, new Event("pagehide"));
  expect(f.cancelled()).toBe(1);
  expect(f.closed()).toBe(1);
  fireEvent.click(view.getByRole("button", { name: "Start hands-free voice" }));
  await waitFor(() => expect(f.record).toHaveBeenCalledTimes(2));
  view.rerender(
    <OwnedVoiceConversation
      enabled
      identityKey="synthetic-owner:two"
      ask={ask}
      cancelOwnTurn={cancel}
    />,
  );
  await waitFor(() => expect(f.cancelled()).toBe(2));
  expect(f.record).toHaveBeenCalledTimes(2);
  expect(asks).toBe(0);
});

test("hidden/blocked conversation pauses and does not reopen the microphone when unblocked", async () => {
  const f = media();
  const ask = async () => ({ threadId: "t", messageId: "m" });
  const cancel = () => {};
  const view = render(
    <OwnedVoiceConversation
      enabled
      identityKey="synthetic-owner:one"
      ask={ask}
      cancelOwnTurn={cancel}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "Start hands-free voice" }));
  await waitFor(() => expect(f.record).toHaveBeenCalledTimes(1));
  view.rerender(
    <OwnedVoiceConversation
      enabled
      blocked
      identityKey="synthetic-owner:one"
      ask={ask}
      cancelOwnTurn={cancel}
    />,
  );
  await waitFor(() => expect(f.cancelled()).toBe(1));
  view.rerender(
    <OwnedVoiceConversation
      enabled
      identityKey="synthetic-owner:one"
      ask={ask}
      cancelOwnTurn={cancel}
    />,
  );
  expect(f.record).toHaveBeenCalledTimes(1);
});
