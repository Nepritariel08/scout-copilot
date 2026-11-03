import {
  OWNED_SPEECH,
  type OwnedSpeechMessage,
} from "@openbot/shared/owned-voice";
import type { Recording } from "../dictation/recording";

export const OWNED_CONVERSATION = {
  maxTurns: 8,
  maxSessionMs: 600_000,
  quietTailMs: 1_000,
  minimumSpeechMs: 350,
} as const;
export type ConversationPhase =
  | "idle"
  | "starting"
  | "listening"
  | "transcribing"
  | "asking"
  | "speaking"
  | "paused";
export type ConversationState = {
  phase: ConversationPhase;
  turns: number;
  settling: boolean;
  notice?: string;
};
export interface ConversationAudio {
  /** Invoke during the Start click, before awaiting microphone permission or network work. */
  resume(): Promise<void>;
  detect(
    stream: MediaStream,
    utterance: () => void,
  ): { stop(): void; hasSpeech(): boolean };
  speak(audio: Blob, signal: AbortSignal): Promise<void>;
  close(): void;
}
type ConversationTimer = ReturnType<typeof setTimeout> | number;
export type ConversationDependencies = {
  audio(): ConversationAudio;
  record(onError: (error: Error) => void): Promise<Recording>;
  transcribe(audio: Blob, signal: AbortSignal): Promise<string>;
  ask(text: string, signal: AbortSignal): Promise<OwnedSpeechMessage>;
  speech(message: OwnedSpeechMessage, signal: AbortSignal): Promise<Blob>;
  /** Must target ONLY the model run created by this voice ask, never a normal/manual turn. */
  cancelOwnTurn(): void | Promise<void>;
  current(): boolean;
  now?(): number;
  setTimer?(work: () => void, ms: number): ConversationTimer;
  clearTimer?(timer: ConversationTimer): void;
};

/** Local utterance gate, not a semantic speech classifier. No audio or features leave the browser. */
export class OwnedUtteranceGate {
  private candidate = 0;
  private last = 0;
  private quietSince: number | undefined;
  private speech = false;
  private finished = false;
  private noise = 0.003;
  hasSpeech = () => this.speech;
  push(rms: number, crossings: number, now: number): boolean {
    if (this.finished || !Number.isFinite(rms) || !Number.isFinite(crossings))
      return false;
    const elapsed = this.last ? Math.max(0, Math.min(100, now - this.last)) : 0;
    this.last = now;
    const threshold = Math.max(0.008, this.noise * 3);
    const quiet = rms < threshold;
    const voice =
      !quiet && rms < 0.45 && crossings >= 0.015 && crossings <= 0.3;
    if (quiet && !this.speech)
      this.noise = Math.min(0.012, this.noise * 0.98 + rms * 0.02);
    if (voice) {
      this.quietSince = undefined;
      this.candidate += elapsed;
      if (this.candidate >= OWNED_CONVERSATION.minimumSpeechMs)
        this.speech = true;
    } else if (quiet) {
      this.quietSince ??= now;
      if (!this.speech && now - this.quietSince > 150) this.candidate = 0;
      if (
        this.speech &&
        now - this.quietSince >= OWNED_CONVERSATION.quietTailMs
      ) {
        this.finished = true;
        return true;
      }
    } else {
      // Broadband/clipped noise is not a quiet utterance boundary.
      this.quietSince = undefined;
      if (!this.speech) this.candidate = 0;
    }
    return false;
  }
}

const active = (phase: ConversationPhase) =>
  phase !== "idle" && phase !== "paused";
const savedMessage = (value: OwnedSpeechMessage) =>
  value &&
  typeof value === "object" &&
  Object.keys(value).sort().join(",") === "messageId,threadId" &&
  [value.threadId, value.messageId].every(
    (part) => typeof part === "string" && part.trim() && part.length <= 200,
  );

/** Exactly one listen→ASR→ask→saved-answer playback chain. Failures never replay a turn. */
export class OwnedConversation {
  private state: ConversationState = {
    phase: "idle",
    turns: 0,
    settling: false,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private controller?: AbortController;
  private audio?: ConversationAudio;
  private recording?: Recording;
  private detector?: ReturnType<ConversationAudio["detect"]>;
  private clipTimer?: ConversationTimer;
  private sessionTimer?: ConversationTimer;
  private pendingAsk: number | undefined;
  private cancelledAsk: number | undefined;
  private started = 0;
  constructor(private readonly deps: ConversationDependencies) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(phase: ConversationPhase, notice?: string) {
    this.state = {
      phase,
      turns: this.state.turns,
      settling: this.pendingAsk !== undefined,
      ...(notice ? { notice } : {}),
    };
    for (const listener of this.listeners) listener();
  }
  private timer(work: () => void, ms: number) {
    return (this.deps.setTimer ?? setTimeout)(work, ms);
  }
  private clear(timer: ConversationTimer | undefined) {
    if (timer !== undefined) (this.deps.clearTimer ?? clearTimeout)(timer);
  }
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private current(generation: number) {
    if (generation !== this.generation || this.controller?.signal.aborted)
      return false;
    if (
      !this.deps.current() ||
      this.now() - this.started >= OWNED_CONVERSATION.maxSessionMs
    ) {
      this.pause(
        "Voice paused because its conversation or session limit changed.",
      );
      return false;
    }
    return true;
  }
  private releaseMicrophone() {
    this.clear(this.clipTimer);
    this.clipTimer = undefined;
    this.detector?.stop();
    this.detector = undefined;
    this.recording?.cancel();
    this.recording = undefined;
  }
  private end(phase: "idle" | "paused", notice?: string) {
    this.generation++;
    this.clear(this.sessionTimer);
    this.sessionTimer = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.releaseMicrophone();
    this.audio?.close();
    this.audio = undefined;
    if (
      this.pendingAsk !== undefined &&
      this.cancelledAsk !== this.pendingAsk
    ) {
      this.cancelledAsk = this.pendingAsk;
      try {
        void Promise.resolve(this.deps.cancelOwnTurn()).catch(() => {});
      } catch {
        /* The outcome remains unknown; never retry. */
      }
    }
    this.update(phase, notice);
  }
  stop = () => this.end("idle");
  pause = (
    notice = "Voice paused. Review the conversation before starting again.",
  ) => this.end("paused", notice);
  start = () => {
    if (active(this.state.phase)) return;
    if (this.pendingAsk !== undefined) {
      this.update(
        "paused",
        "The previous voice turn is still settling. No turn was retried.",
      );
      return;
    }
    if (!this.deps.current()) {
      this.pause("Voice is unavailable in the current conversation.");
      return;
    }
    this.end("idle");
    const generation = ++this.generation;
    this.started = this.now();
    this.state = { phase: "starting", turns: 0, settling: false };
    this.controller = new AbortController();
    this.update("starting");
    this.sessionTimer = this.timer(
      () =>
        this.pause(
          "The ten-minute voice session ended. Start a new session when ready.",
        ),
      OWNED_CONVERSATION.maxSessionMs,
    );
    try {
      this.audio = this.deps.audio();
      // Called synchronously from the Start gesture, never after ASR/model/TTS I/O.
      const resumed = this.audio.resume();
      void resumed
        .then(() => this.listen(generation))
        .catch(() => {
          if (generation === this.generation)
            this.pause(
              "Audio could not start. Check browser permission and start again.",
            );
        });
    } catch {
      this.pause(
        "This browser cannot start continuous voice. Use the microphone button instead.",
      );
    }
  };
  private async listen(generation: number): Promise<void> {
    if (!this.current(generation)) {
      if (generation === this.generation) this.pause();
      return;
    }
    this.update("starting");
    try {
      const recording = await this.deps.record(() => {
        if (generation === this.generation)
          this.pause("The microphone stopped. Nothing was retried.");
      });
      if (!this.current(generation)) {
        recording.cancel();
        if (generation === this.generation) this.pause();
        return;
      }
      this.recording = recording;
      if (!recording.stream || !this.audio)
        throw new Error("Microphone stream unavailable");
      this.update("listening");
      this.detector = this.audio.detect(recording.stream, () => {
        void this.utterance(generation);
      });
      this.clipTimer = this.timer(() => {
        if (!this.current(generation) || this.state.phase !== "listening")
          return;
        if (this.detector?.hasSpeech()) {
          this.pause(
            "No complete utterance within thirty seconds. That recording was discarded.",
          );
          return;
        }
        this.releaseMicrophone();
        // Quiet/noisy recordings are discarded locally, without ASR or model calls.
        void this.listen(generation);
      }, OWNED_SPEECH.maxRecordingSeconds * 1000);
    } catch {
      if (generation === this.generation)
        this.pause(
          "Microphone access failed. Check permission before starting again.",
        );
    }
  }
  private async utterance(generation: number) {
    if (
      !this.current(generation) ||
      this.state.phase !== "listening" ||
      !this.recording
    )
      return;
    this.update("transcribing");
    this.clear(this.clipTimer);
    this.clipTimer = undefined;
    this.detector?.stop();
    this.detector = undefined;
    const recording = this.recording;
    const signal = this.controller?.signal;
    if (!signal) return;
    try {
      const clip = await recording.finish();
      if (this.recording === recording) this.recording = undefined;
      if (!this.current(generation)) return;
      if (!clip.size || clip.size > OWNED_SPEECH.maxUploadBytes)
        throw new Error("Recording exceeds the speech bounds");
      const text = (await this.deps.transcribe(clip, signal)).trim();
      if (!this.current(generation)) return;
      if (
        !text ||
        new TextEncoder().encode(text).length > OWNED_SPEECH.maxTranscriptBytes
      )
        throw new Error("No bounded transcript");
      this.state = { ...this.state, turns: this.state.turns + 1 };
      this.pendingAsk = generation;
      this.update("asking");
      let saved: OwnedSpeechMessage;
      try {
        saved = await this.deps.ask(text, signal);
      } finally {
        if (this.pendingAsk === generation) this.pendingAsk = undefined;
        if (generation !== this.generation)
          this.update(this.state.phase, this.state.notice);
      }
      if (!this.current(generation)) return;
      if (!savedMessage(saved))
        throw new Error("Reply has no exact saved identity");
      this.update("speaking");
      const audio = await this.deps.speech(
        { threadId: saved.threadId, messageId: saved.messageId },
        signal,
      );
      if (!this.current(generation) || !this.audio) return;
      await this.audio.speak(audio, signal);
      if (!this.current(generation)) return;
      if (this.state.turns >= OWNED_CONVERSATION.maxTurns) {
        this.pause(
          "The eight-turn voice session ended. Start a new session when ready.",
        );
        return;
      }
      await this.listen(generation);
    } catch {
      if (generation === this.generation)
        this.pause(
          "Voice paused after an incomplete step. Review the conversation; nothing was retried.",
        );
    }
  }
}
