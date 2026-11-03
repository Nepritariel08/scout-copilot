import { isAbsolute } from "node:path";
import { z } from "zod";
import { readProtectedModelFile } from "../owned-model/policy";
import { createOwnedSpeechBackend } from "../owned-voice/backend";

const settings = z.strictObject({
  version: z.literal(1),
  baseUrl: z.literal("http://127.0.0.1:18083/v1"),
  tokenFile: z.string().min(1).max(1000).refine(isAbsolute),
});

/** Startup-only operator configuration. Nothing from a browser chooses speech credentials or routes. */
export async function readOwnedSpeechBackend(path: string) {
  try {
    const config = settings.parse(
      JSON.parse(await readProtectedModelFile(path, 4096)),
    );
    const token = (await readProtectedModelFile(config.tokenFile, 1024)).trim();
    return createOwnedSpeechBackend({ baseUrl: config.baseUrl, token });
  } catch {
    throw new Error("OWNED_SPEECH_CONFIG_INVALID");
  }
}
