import {
  OWNED_SPEECH,
  type OwnedSpeechMessage,
} from "@openbot/shared/owned-voice";

/** Same-origin fixed route: no client text, model, provider, URL, or implicit chat retry. */
export async function ownedSpeechAudio(
  input: OwnedSpeechMessage,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch("/api/audio/speech", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", "x-openbot-dictation": "1" },
    body: JSON.stringify(input),
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(OWNED_SPEECH.requestTimeoutMs + 10_000),
    ]),
  });
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";", 1)[0] !== "audio/wav"
  ) {
    await response.body?.cancel();
    throw new Error(
      response.status === 429
        ? "Speech is busy. Try again shortly."
        : "This saved answer cannot be played right now.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The speech response was empty.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > OWNED_SPEECH.maxAudioBytes)
        throw new Error("Speech exceeded the playback limit.");
      chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: "audio/wav" });
}
