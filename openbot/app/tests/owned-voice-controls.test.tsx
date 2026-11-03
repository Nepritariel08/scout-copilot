import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { OwnedVoiceControls } from "@/components/channels/owned-voice-controls";
import * as recording from "@/lib/dictation/recording";
import * as speech from "@/lib/voice/owned-playback";
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
const saved = {
  threadId: "thread-synthetic",
  messageId: "assistant-synthetic",
};

test("disabled owned voice exposes no microphone or playback action", () => {
  const start = spyOn(recording, "startRecording");
  restores.push(() => start.mockRestore());
  const view = render(
    <OwnedVoiceControls enabled={false} onTranscript={() => {}} />,
  );
  expect(view.queryByRole("group")).toBeNull();
  expect(start).not.toHaveBeenCalled();
});

test("stop returns a reviewable transcript; cancelling late work never inserts it", async () => {
  const supported = spyOn(recording, "recordingSupported").mockReturnValue(
    true,
  );
  const start = spyOn(recording, "startRecording").mockResolvedValue({
    finish: async () => new Blob(["synthetic"], { type: "audio/webm" }),
    cancel() {},
  });
  const first = Promise.withResolvers<string>();
  const transcribe = spyOn(recording, "transcribeRecording").mockImplementation(
    () => first.promise,
  );
  restores.push(
    () => supported.mockRestore(),
    () => start.mockRestore(),
    () => transcribe.mockRestore(),
  );
  const transcripts: string[] = [];
  const busy: boolean[] = [];
  const view = render(
    <OwnedVoiceControls
      enabled
      onBusyChange={(value) => busy.push(value)}
      onTranscript={(text) => transcripts.push(text)}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "Record message" }));
  expect(busy.at(-1)).toBe(true);
  await waitFor(() =>
    expect(view.getByRole("button", { name: /Stop \(/ })).toBeDefined(),
  );
  fireEvent.click(view.getByRole("button", { name: /Stop \(/ }));
  await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  await act(async () => {
    first.resolve("Review this synthetic transcript");
    await first.promise;
  });
  await waitFor(() =>
    expect(transcripts).toEqual(["Review this synthetic transcript"]),
  );
  const late = Promise.withResolvers<string>();
  expect(busy.at(-1)).toBe(false);
  transcribe.mockImplementation(() => late.promise);
  fireEvent.click(view.getByRole("button", { name: "Record message" }));
  await waitFor(() =>
    expect(view.getByRole("button", { name: /Stop \(/ })).toBeDefined(),
  );
  fireEvent.click(view.getByRole("button", { name: /Stop \(/ }));
  await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
  fireEvent.click(view.getByRole("button", { name: "Cancel recording" }));
  expect(busy.at(-1)).toBe(false);
  await act(async () => {
    late.resolve("Must be discarded");
    await late.promise;
  });
  expect(transcripts).toEqual(["Review this synthetic transcript"]);
});

test("playback uses saved identity; a second tap after autoplay denial reuses prepared audio", async () => {
  let plays = 0,
    pauses = 0;
  const originalAudio = globalThis.Audio;
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: class {
      src = "";
      onended: (() => void) | undefined;
      async play() {
        if (++plays === 1) throw new DOMException("gesture", "NotAllowedError");
      }
      pause() {
        pauses++;
      }
    },
  });
  const create = spyOn(URL, "createObjectURL").mockReturnValue(
    "blob:synthetic",
  );
  const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const synthesize = spyOn(speech, "ownedSpeechAudio").mockResolvedValue(
    new Blob(["synthetic"], { type: "audio/wav" }),
  );
  restores.push(
    () =>
      Object.defineProperty(globalThis, "Audio", {
        configurable: true,
        value: originalAudio,
      }),
    () => create.mockRestore(),
    () => revoke.mockRestore(),
    () => synthesize.mockRestore(),
  );
  const view = render(
    <OwnedVoiceControls enabled message={saved} onTranscript={() => {}} />,
  );
  fireEvent.click(view.getByRole("button", { name: "Play latest answer" }));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain("Tap Play again"),
  );
  expect(synthesize.mock.calls[0]?.[0]).toEqual(saved);
  fireEvent.click(view.getByRole("button", { name: "Play latest answer" }));
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Stop playback" })).toBeDefined(),
  );
  expect(synthesize).toHaveBeenCalledTimes(1);
  fireEvent(window, new Event("pagehide"));
  expect(pauses).toBe(1);
  expect(revoke).toHaveBeenCalledWith("blob:synthetic");
});
