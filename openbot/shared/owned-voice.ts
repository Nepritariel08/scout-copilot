/** Fixed owner-pilot ceilings. Speech has no authority to select or invoke a chat model. */
export const OWNED_SPEECH = {
  maxRecordingSeconds: 30,
  maxUploadBytes: 2 * 1024 * 1024,
  maxTranscriptBytes: 16_384,
  maxJsonBytes: 32_768,
  maxTextCharacters: 2_000,
  maxAudioBytes: 4_320_044,
  maxSpeechSeconds: 90,
  nativeTimeoutMs: 60_000,
  requestTimeoutMs: 70_000,
  sttModel: "Systran/faster-whisper-tiny",
  ttsModel: "kokoro-v1.0",
  voice: "af_heart",
} as const;

export type OwnedSpeechMessage = {
  threadId: string;
  messageId: string;
};
