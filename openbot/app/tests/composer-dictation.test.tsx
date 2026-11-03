import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { deploymentKeys } from "@/lib/deployment/queries";
import * as recording from "@/lib/dictation/recording";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

for (const compact of [false, true]) {
  test(`owned ${compact ? "compact" : "default"} chat stays text-only while optional voice is deferred`, async () => {
    queryClient.setQueryData(deploymentKeys.capabilities(), {
      mode: "owned",
      transcription: true,
      speechPlayback: true,
      voice: false,
    });
    const supported = spyOn(recording, "recordingSupported").mockReturnValue(
      true,
    );
    const start = spyOn(recording, "startRecording");
    const sent: string[] = [];
    try {
      const view = render(
        <Composer
          compact={compact}
          glass
          initialValue="Core chat still works"
          onSubmit={(draft) => {
            sent.push(draft.text);
          }}
        />,
      );
      expect(
        view.queryByRole("button", {
          name: /Speak a message|Dictate a message|Record message|Play latest answer/,
        }),
      ).toBeNull();
      expect(view.queryByText(/Audio stays on our infrastructure/)).toBeNull();
      fireEvent.submit(view.container.querySelector("form")!);
      await waitFor(() => expect(sent).toEqual(["Core chat still works"]));
      expect(start).not.toHaveBeenCalled();
    } finally {
      cleanup();
      supported.mockRestore();
      start.mockRestore();
    }
  });

  test(`owned ${compact ? "compact" : "default"} speech preserves the draft and waits for explicit Send`, async () => {
    queryClient.setQueryData(deploymentKeys.capabilities(), {
      mode: "owned",
      transcription: true,
      speechPlayback: true,
      voice: false,
    });
    const supported = spyOn(recording, "recordingSupported").mockReturnValue(
      true,
    );
    const start = spyOn(recording, "startRecording").mockResolvedValue({
      finish: async () => new Blob(["synthetic"], { type: "audio/webm" }),
      cancel() {},
    });
    const result = Promise.withResolvers<string>();
    const transcribe = spyOn(
      recording,
      "transcribeRecording",
    ).mockImplementation(() => result.promise);
    const sent: string[] = [];
    try {
      const view = render(
        <Composer
          compact={compact}
          initialValue="Existing draft"
          ownedSpeech={{ scopeKey: "native-owner:channel", disabled: false }}
          onSubmit={(draft) => {
            sent.push(draft.text);
          }}
        />,
      );
      expect(
        view.queryByRole("button", { name: "Dictate a message" }),
      ).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "Record message" }));
      await waitFor(() =>
        expect(view.getByRole("button", { name: /Stop \(/ })).toBeTruthy(),
      );
      const form = view.container.querySelector("form");
      if (!form) throw new Error("Missing composer form");
      expect(
        view
          .getByRole("button", { name: "Send message" })
          .hasAttribute("disabled"),
      ).toBe(true);
      fireEvent.submit(form);
      expect(sent).toEqual([]);
      fireEvent.click(view.getByRole("button", { name: /Stop \(/ }));
      await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
      fireEvent.submit(form);
      expect(sent).toEqual([]);
      await act(async () => {
        result.resolve("reviewed words");
        await result.promise;
      });
      await waitFor(() =>
        expect(view.getByRole("textbox", { name: "Message" }).textContent).toBe(
          "Existing draft reviewed words",
        ),
      );
      expect(sent).toEqual([]);
      fireEvent.submit(form);
      await waitFor(() =>
        expect(sent).toEqual(["Existing draft reviewed words"]),
      );
    } finally {
      cleanup();
      supported.mockRestore();
      start.mockRestore();
      transcribe.mockRestore();
    }
  });
}

test("an owned native-user/channel change discards late transcription", async () => {
  const supported = spyOn(recording, "recordingSupported").mockReturnValue(
    true,
  );
  const start = spyOn(recording, "startRecording").mockResolvedValue({
    finish: async () => new Blob(["synthetic"], { type: "audio/webm" }),
    cancel() {},
  });
  const result = Promise.withResolvers<string>();
  const transcribe = spyOn(recording, "transcribeRecording").mockImplementation(
    () => result.promise,
  );
  try {
    const view = render(
      <Composer
        initialValue="Keep this draft"
        ownedSpeech={{ scopeKey: "owner-a:channel-a", disabled: false }}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Record message" }));
    await waitFor(() =>
      expect(view.getByRole("button", { name: /Stop \(/ })).toBeTruthy(),
    );
    fireEvent.click(view.getByRole("button", { name: /Stop \(/ }));
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    view.rerender(
      <Composer
        initialValue="Keep this draft"
        ownedSpeech={{ scopeKey: "owner-b:channel-b", disabled: true }}
      />,
    );
    await act(async () => {
      result.resolve("Discard these late words");
      await result.promise;
    });
    expect(view.getByRole("textbox", { name: "Message" }).textContent).toBe(
      "Keep this draft",
    );
  } finally {
    cleanup();
    supported.mockRestore();
    start.mockRestore();
    transcribe.mockRestore();
  }
});

for (const variant of ["compact", "default"] as const) {
  for (const action of [
    "stop",
    "send",
    "retry-send",
    "failed-send",
    "cancel",
  ] as const) {
    test(`${variant} dictation: ${action} preserves the draft and follows the selected action`, async () => {
      queryClient.setQueryData(deploymentKeys.capabilities(), {
        generativeUi: true,
        transcription: true,
      });
      const audio = new Blob(["recording"], { type: "audio/webm" });
      const supported = spyOn(recording, "recordingSupported").mockReturnValue(
        true,
      );
      const start = spyOn(recording, "startRecording").mockResolvedValue({
        finish: async () => audio,
        cancel() {},
      });
      const result = Promise.withResolvers<string>();
      let attempts = 0;
      const transcribe = spyOn(
        recording,
        "transcribeRecording",
      ).mockImplementation(() => {
        if (action === "retry-send" && attempts++ === 0)
          return Promise.reject(new Error("Please retry transcription"));
        return result.promise;
      });
      const sent: string[] = [];
      try {
        const view = render(
          <Composer
            compact={variant === "compact"}
            initialValue="Existing draft"
            onSubmit={(draft) => {
              sent.push(draft.text);
              if (action === "failed-send")
                throw new Error("Agent unavailable");
            }}
          />,
        );
        fireEvent.click(
          view.getByRole("button", { name: "Dictate a message" }),
        );
        await waitFor(() => expect(view.getByText("Listening")).toBeDefined());
        expect(view.queryByRole("textbox", { name: "Message" })).toBeNull();
        expect(
          view.queryByRole("button", { name: "Dictate a message" }),
        ).toBeNull();
        expect(
          view.getByRole("img", { name: "Live audio waveform" }),
        ).toBeDefined();
        const form = view.container.querySelector("form");
        if (!form) throw new Error("Missing composer form");
        fireEvent.submit(form);
        expect(sent).toEqual([]);
        if (action === "cancel") {
          fireEvent.click(
            view.getByRole("button", { name: "Cancel dictation" }),
          );
          await waitFor(() =>
            expect(
              view.getByRole("textbox", { name: "Message" }).textContent,
            ).toBe("Existing draft"),
          );
          expect(transcribe).not.toHaveBeenCalled();
          expect(sent).toEqual([]);
          return;
        }
        fireEvent.click(
          view.getByRole("button", {
            name:
              action === "stop" ? "Stop and transcribe" : "Transcribe and send",
          }),
        );
        await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
        if (action === "retry-send") {
          await waitFor(() =>
            expect(view.getByRole("alert").textContent).toContain(
              "Please retry",
            ),
          );
          expect(sent).toEqual([]);
          fireEvent.click(view.getByRole("button", { name: "Retry" }));
          await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
        }
        fireEvent.submit(form);
        expect(sent).toEqual([]);
        await act(async () => {
          result.resolve("dictated words");
          await result.promise;
        });
        if (action === "stop" || action === "failed-send") {
          await waitFor(() =>
            expect(
              view.getByRole("textbox", { name: "Message" }).textContent,
            ).toContain("Existing draft dictated words"),
          );
        }
        if (action === "stop") {
          expect(sent).toEqual([]);
          fireEvent.submit(form);
        }
        await waitFor(() =>
          expect(sent).toEqual(["Existing draft dictated words"]),
        );
      } finally {
        cleanup();
        supported.mockRestore();
        start.mockRestore();
        transcribe.mockRestore();
      }
    });
  }
}
