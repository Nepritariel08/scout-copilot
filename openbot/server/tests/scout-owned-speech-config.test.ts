import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readOwnedSpeechBackend } from "../src/scout/owned/speech-config";

let directory = "";
let configFile = "";
let tokenFile = "";
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "scout-speech-config-"));
  configFile = join(directory, "settings.json");
  tokenFile = join(directory, "synthetic-token");
});
afterAll(async () => {
  if (
    !resolve(directory).startsWith(
      resolve(join(tmpdir(), "scout-speech-config-")),
    )
  )
    throw new Error("Unexpected fixture cleanup path");
  await rm(directory, { recursive: true });
});
const settings = () => ({
  version: 1,
  baseUrl: "http://127.0.0.1:18083/v1",
  tokenFile,
});
beforeEach(async () => {
  await writeFile(
    tokenFile,
    "synthetic_token_for_owned_speech_only_12345678\n",
    { mode: 0o600 },
  );
  await writeFile(configFile, JSON.stringify(settings()), { mode: 0o600 });
});

test("protected speech configuration constructs only a fixed loopback backend", async () => {
  const backend = await readOwnedSpeechBackend(configFile);
  expect(typeof backend.transcribe).toBe("function");
  expect(typeof backend.synthesize).toBe("function");
  expect(JSON.stringify(backend)).not.toContain("synthetic_token");
});

test("operator configuration cannot select a remote host, arbitrary loopback port, model or relative token file", async () => {
  for (const extra of [
    { baseUrl: "https://voice.invalid/v1" },
    { baseUrl: "http://127.0.0.1:1/v1" },
    { model: "unreviewed" },
    { tokenFile: "relative" },
  ]) {
    await writeFile(configFile, JSON.stringify({ ...settings(), ...extra }));
    await expect(readOwnedSpeechBackend(configFile)).rejects.toThrow(
      "OWNED_SPEECH_CONFIG_INVALID",
    );
  }
});

test("missing or malformed speech credentials fail without disclosing their contents", async () => {
  await writeFile(
    tokenFile,
    "synthetic invalid token must never appear in an error",
  );
  try {
    await readOwnedSpeechBackend(configFile);
    throw new Error("Unexpected credential acceptance");
  } catch (error) {
    expect(String(error)).toBe("Error: OWNED_SPEECH_CONFIG_INVALID");
  }
  await expect(
    readOwnedSpeechBackend(join(directory, "missing")),
  ).rejects.toThrow("OWNED_SPEECH_CONFIG_INVALID");
});
