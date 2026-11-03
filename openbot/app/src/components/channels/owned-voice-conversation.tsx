import type { OwnedSpeechMessage } from "@openbot/shared/owned-voice";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { startRecording, transcribeRecording } from "@/lib/dictation/recording";
import { OwnedConversation } from "@/lib/voice/owned-conversation";
import {
  createOwnedConversationAudio,
  ownedConversationSupported,
} from "@/lib/voice/owned-conversation-audio";
import { ownedSpeechAudio } from "@/lib/voice/owned-playback";

export type OwnedVoiceConversationProps = {
  enabled: boolean;
  blocked?: boolean;
  /** Verified native user + channel identity; also use this as the React key. */
  identityKey: string;
  ask(text: string, signal: AbortSignal): Promise<OwnedSpeechMessage>;
  cancelOwnTurn(): void | Promise<void>;
  onBusyChange?(busy: boolean): void;
};

/** Owned-only continuous turn taking. It grants no tool, source, device or business authority. */
export function OwnedVoiceConversation(props: OwnedVoiceConversationProps) {
  const current = useRef(props);
  current.current = props;
  const session = useMemo(() => {
    const owner = props.identityKey;
    const cancelOwnTurn = props.cancelOwnTurn;
    return new OwnedConversation({
      audio: createOwnedConversationAudio,
      record: startRecording,
      transcribe: transcribeRecording,
      speech: ownedSpeechAudio,
      current: () =>
        current.current.identityKey === owner &&
        current.current.enabled &&
        !current.current.blocked,
      ask: (text, signal) => {
        if (current.current.identityKey !== owner || signal.aborted)
          throw new DOMException("Conversation changed", "AbortError");
        return current.current.ask(text, signal);
      },
      // Preserve the old identity's exact cancellation callback across a channel transition.
      cancelOwnTurn,
    });
  }, [props.identityKey, props.cancelOwnTurn]);
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(() => {
    const notify = () => {
      const value = session.getSnapshot();
      current.current.onBusyChange?.(
        (value.phase !== "idle" && value.phase !== "paused") || value.settling,
      );
    };
    const unsubscribe = session.subscribe(notify);
    notify();
    return () => {
      unsubscribe();
      session.stop();
      current.current.onBusyChange?.(false);
    };
  }, [session]);
  useEffect(() => {
    if (!props.enabled || props.blocked)
      session.pause(
        "Voice paused because this conversation is unavailable or busy.",
      );
  }, [props.enabled, props.blocked, session]);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden")
        session.pause("Voice paused while the page is hidden.");
    };
    const hide = () => session.pause("Voice paused when the page closed.");
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", hide);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", hide);
    };
  }, [session]);
  if (!props.enabled) return null;
  const active = state.phase !== "idle" && state.phase !== "paused";
  return (
    <fieldset
      aria-label="Continuous voice conversation"
      className="flex flex-wrap items-center gap-2"
    >
      <Button
        type="button"
        size="sm"
        disabled={
          props.blocked ||
          active ||
          state.settling ||
          !ownedConversationSupported()
        }
        onClick={() => session.start()}
      >
        Start hands-free voice
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => session.stop()}
      >
        Stop voice
      </Button>
      <span role="status" className="text-xs">
        {state.phase === "listening"
          ? "Listening — pause briefly when finished."
          : state.phase === "asking"
            ? "Waiting for Scout's saved answer…"
            : state.phase === "speaking"
              ? "Speaking — microphone off."
              : state.phase === "transcribing"
                ? "Transcribing — microphone off."
                : state.phase === "starting"
                  ? "Starting microphone…"
                  : (state.notice ?? "Voice is off.")}{" "}
        ({state.turns}/8 turns)
      </span>
      <span className="text-xs text-muted-foreground">
        Audio stays on our infrastructure. Ends after 8 turns or 10 minutes.
        Business actions still need their normal review.
      </span>
    </fieldset>
  );
}
