import { OWNED_SPEECH } from "@openbot/shared/owned-voice";
import { createTranscriptionProvider } from "../../dictation/provider";
import { speechResponseBytes } from "../../dictation/response";

export interface OwnedSpeechBackend {
  transcribe(file: File): Promise<string>;
  synthesize(text: string): Promise<Uint8Array>;
}

type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** Operator-only, loopback-only configuration. Never read provider choices from an HTTP body. */
export function createOwnedSpeechBackend(
  config: { baseUrl: string; token: string },
  transport: Transport = fetch,
): OwnedSpeechBackend {
  const url = new URL(config.baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/v1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[A-Za-z0-9_-]{32,512}$/.test(config.token)
  )
    throw new Error("OWNED_SPEECH_CONFIG_INVALID");
  const transcription = createTranscriptionProvider(
    {
      provider: "openai-compatible",
      baseUrl: url.href,
      model: OWNED_SPEECH.sttModel,
      apiKey: config.token,
    },
    transport,
  );
  return {
    transcribe: (file) =>
      transcription.transcribe(
        file,
        AbortSignal.timeout(OWNED_SPEECH.requestTimeoutMs),
      ),
    async synthesize(text) {
      if (!text.trim() || text.length > OWNED_SPEECH.maxTextCharacters)
        throw new Error("OWNED_SPEECH_INPUT_INVALID");
      const response = await transport(`${url.href}/audio/speech`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: text,
          model: OWNED_SPEECH.ttsModel,
          voice: OWNED_SPEECH.voice,
          response_format: "wav",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(OWNED_SPEECH.requestTimeoutMs),
      });
      if (
        !response.ok ||
        response.headers.get("content-type")?.split(";", 1)[0] !== "audio/wav"
      ) {
        await response.body?.cancel();
        throw new Error("OWNED_SPEECH_UNAVAILABLE");
      }
      const audio = await speechResponseBytes(
        response,
        OWNED_SPEECH.maxAudioBytes,
      );
      if (
        audio.length < 44 ||
        new TextDecoder().decode(audio.subarray(0, 4)) !== "RIFF" ||
        new TextDecoder().decode(audio.subarray(8, 12)) !== "WAVE"
      )
        throw new Error("OWNED_SPEECH_UNAVAILABLE");
      return audio;
    },
  };
}
