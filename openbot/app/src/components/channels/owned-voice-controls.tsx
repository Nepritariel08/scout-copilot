import {
  OWNED_SPEECH,
  type OwnedSpeechMessage,
} from "@openbot/shared/owned-voice";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import {
  recordingSupported,
  startRecording,
  transcribeRecording,
} from "@/lib/dictation/recording";
import { DictationSession } from "@/lib/dictation/session";
import { ownedSpeechAudio } from "@/lib/voice/owned-playback";

/** Optional owned-only strip. Mount with a native user/channel key; keep the licensed voice UI intact. */
export function OwnedVoiceControls({
  enabled,
  disabled = false,
  message,
  onTranscript,
  onBusyChange,
}: {
  enabled: boolean;
  disabled?: boolean;
  message?: OwnedSpeechMessage;
  onTranscript(text: string): void;
  onBusyChange?(busy: boolean): void;
}) {
  const callback = useRef(onTranscript);
  callback.current = onTranscript;
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const playback = useRef<
    | { controller: AbortController; audio?: HTMLAudioElement; url?: string }
    | undefined
  >(undefined);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string>();
  const [session] = useState<DictationSession>(
    () =>
      new DictationSession({
        record: async (onError) => {
          const recording = await startRecording(onError);
          timer.current = setTimeout(
            () => void session.finish("draft"),
            OWNED_SPEECH.maxRecordingSeconds * 1000,
          );
          return {
            stream: recording.stream,
            cancel() {
              clearTimeout(timer.current);
              recording.cancel();
            },
            finish() {
              clearTimeout(timer.current);
              return recording.finish();
            },
          };
        },
        transcribe: (audio, signal) => {
          if (audio.size > OWNED_SPEECH.maxUploadBytes)
            throw new Error("Recording is too large. Try a shorter message.");
          return transcribeRecording(audio, signal);
        },
        onTranscript: (text) => callback.current(text),
      }),
  );
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(() => {
    const notify = () => {
      const phase = session.getSnapshot().phase;
      busyCallback.current?.(
        phase === "requesting" ||
          phase === "recording" ||
          phase === "transcribing",
      );
    };
    const unsubscribe = session.subscribe(notify);
    notify();
    return () => {
      unsubscribe();
      busyCallback.current?.(false);
    };
  }, [session]);
  const stop = useCallback(() => {
    const current = playback.current;
    playback.current = undefined;
    current?.controller.abort();
    current?.audio?.pause();
    if (current?.url) URL.revokeObjectURL(current.url);
    setPlaying(false);
  }, []);
  useEffect(() => {
    const cancel = () => {
      clearTimeout(timer.current);
      session.cancel();
      stop();
    };
    if (!enabled || disabled) cancel();
    window.addEventListener("pagehide", cancel);
    return () => {
      window.removeEventListener("pagehide", cancel);
      cancel();
    };
  }, [enabled, disabled, session, stop]);
  const messageKey = `${message?.threadId ?? ""}:${message?.messageId ?? ""}`;
  const lastMessageKey = useRef(messageKey);
  useEffect(() => {
    if (lastMessageKey.current === messageKey) return;
    lastMessageKey.current = messageKey;
    stop();
  }, [messageKey, stop]);
  if (!enabled) return null;
  const record = () => {
    stop();
    setError(undefined);
    void session.start();
  };
  const play = async () => {
    if (!message) return;
    const ready = playback.current;
    if (ready?.audio?.src) {
      // The second tap invokes play synchronously, satisfying browsers' user-gesture rule.
      try {
        await ready.audio.play();
        if (playback.current !== ready) return;
        setError(undefined);
        setPlaying(true);
      } catch {
        if (playback.current !== ready) return;
        setError("Tap Play again to allow audio playback in your browser.");
      }
      return;
    }
    clearTimeout(timer.current);
    session.cancel();
    stop();
    setError(undefined);
    setPlaying(true);
    const current = {
      controller: new AbortController(),
      audio: new Audio(),
      url: undefined as string | undefined,
    };
    playback.current = current;
    // Allocate the element during the tap; browsers may still require another Play tap.
    try {
      const blob = await ownedSpeechAudio(message, current.controller.signal);
      if (playback.current !== current) return;
      current.url = URL.createObjectURL(blob);
      current.audio.src = current.url;
      current.audio.onended = stop;
      await current.audio.play();
    } catch (cause) {
      if (playback.current !== current) return;
      if (
        cause instanceof DOMException &&
        cause.name === "NotAllowedError" &&
        current.url
      ) {
        setPlaying(false);
        setError("Tap Play again to allow audio playback in your browser.");
        return;
      }
      stop();
      setError(
        cause instanceof Error
          ? cause.message
          : "Couldn't play this answer. Try Play again.",
      );
    }
  };
  return (
    <fieldset
      className="flex flex-wrap items-center gap-2"
      aria-label="Owned voice controls"
    >
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={
          disabled || !recordingSupported() || state.phase === "transcribing"
        }
        onClick={
          state.phase === "recording"
            ? () => void session.finish("draft")
            : record
        }
      >
        {state.phase === "recording"
          ? `Stop (${state.seconds}s)`
          : state.phase === "transcribing"
            ? "Transcribing…"
            : "Record message"}
      </Button>
      {state.phase !== "idle" && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => session.cancel()}
        >
          Cancel recording
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || !message}
        onClick={playing ? stop : () => void play()}
      >
        {playing ? "Stop playback" : "Play latest answer"}
      </Button>
      <span className="text-xs text-muted-foreground">
        Audio stays on our infrastructure. Review the transcript before Send.
      </span>
      {(error || state.error) && (
        <span role="alert" className="text-xs text-destructive">
          {error || state.error}
        </span>
      )}
    </fieldset>
  );
}
