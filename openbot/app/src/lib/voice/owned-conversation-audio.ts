import { OWNED_SPEECH } from "@openbot/shared/owned-voice";
import { recordingSupported } from "../dictation/recording";
import {
  type ConversationAudio,
  OwnedUtteranceGate,
} from "./owned-conversation";

export const ownedConversationSupported = () =>
  recordingSupported() && typeof AudioContext !== "undefined";

/** One click-resumed context; mic graphs are disconnected before any synthesized audio plays. */
export function createOwnedConversationAudio(): ConversationAudio {
  const context = new AudioContext();
  let stopDetector: (() => void) | undefined;
  let stopPlayback: (() => void) | undefined;
  return {
    async resume() {
      await context.resume();
      if (context.state !== "running")
        throw new Error("Audio playback is blocked");
    },
    detect(stream, utterance) {
      stopDetector?.();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const muted = context.createGain();
      muted.gain.value = 0;
      source.connect(analyser);
      analyser.connect(muted);
      muted.connect(context.destination);
      const data = new Float32Array(analyser.fftSize);
      const gate = new OwnedUtteranceGate(context.sampleRate);
      const timer = setInterval(() => {
        if (context.state !== "running") return;
        analyser.getFloatTimeDomainData(data);
        let squares = 0,
          crossings = 0;
        for (let i = 0; i < data.length; i++) {
          const value = data[i] ?? 0;
          squares += value * value;
          if (i && value >= 0 !== (data[i - 1] ?? 0) >= 0) crossings++;
        }
        if (
          gate.push(
            Math.sqrt(squares / data.length),
            crossings / data.length,
            performance.now(),
          )
        )
          utterance();
      }, 50);
      const stop = () => {
        clearInterval(timer);
        source.disconnect();
        analyser.disconnect();
        muted.disconnect();
        if (stopDetector === stop) stopDetector = undefined;
      };
      stopDetector = stop;
      return { stop, hasSpeech: gate.hasSpeech };
    },
    async speak(blob, signal) {
      stopDetector?.();
      if (signal.aborted || context.state !== "running")
        throw new Error("Audio playback is blocked");
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      if (
        signal.aborted ||
        context.state !== "running" ||
        buffer.duration > OWNED_SPEECH.maxSpeechSeconds ||
        !buffer.length
      )
        throw new Error("Audio playback unavailable");
      await new Promise<void>((resolve, reject) => {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        let done = false;
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          context.removeEventListener("statechange", changed);
          source.onended = null;
          try {
            source.stop();
          } catch {
            /* Already ended. */
          }
          source.disconnect();
          if (stopPlayback === abort) stopPlayback = undefined;
          if (error) reject(error);
          else resolve();
        };
        const abort = () =>
          finish(new DOMException("Playback stopped", "AbortError"));
        const changed = () => {
          if (context.state !== "running")
            finish(new Error("Audio playback was blocked"));
        };
        const timer = setTimeout(
          () => finish(new Error("Playback timed out")),
          (OWNED_SPEECH.maxSpeechSeconds + 5) * 1000,
        );
        stopPlayback = abort;
        signal.addEventListener("abort", abort, { once: true });
        context.addEventListener("statechange", changed);
        source.onended = () => finish();
        try {
          source.start();
        } catch {
          finish(new Error("Audio playback was blocked"));
        }
      });
    },
    close() {
      stopDetector?.();
      stopPlayback?.();
      void context.close().catch(() => {});
    },
  };
}
