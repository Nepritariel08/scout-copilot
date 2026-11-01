import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadOwnedConfig } from "../src/config";

const environment = {
  DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:25433/scout_owned_test",
  KEY_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
  SCOUT_RUNTIME_MODE: "owned",
  OPENBOT_ORGANIZATION_AUTH_URL: "https://identity.fixture.example",
  SCOUT_QUEUE_BINDINGS_FILE: join(tmpdir(), "scout-owned-fixture-policy.json"),
  OPENBOT_HOST: "127.0.0.1",
};
describe("explicit owned runtime configuration", () => {
  test("platform owners are exact bounded native subjects and absent configuration grants none", () => {
    expect(loadOwnedConfig(environment).scoutPlatformOwnerIds).toEqual([]);
    expect(
      loadOwnedConfig({
        ...environment,
        SCOUT_PLATFORM_OWNER_IDS: " native-owner-a, native-owner-b ",
      }).scoutPlatformOwnerIds,
    ).toEqual(["native-owner-a", "native-owner-b"]);
    for (const value of [
      "x".repeat(201),
      "native-owner-a,native-owner-a",
      "native-owner\u0000a",
      Array.from({ length: 101 }, (_, index) => `subject-${index}`).join(","),
    ])
      expect(() =>
        loadOwnedConfig({ ...environment, SCOUT_PLATFORM_OWNER_IDS: value }),
      ).toThrow("SCOUT_PLATFORM_OWNER_IDS");
  });
  test("unadapted transcription and voice cannot inherit ambient provider credentials", () => {
    const config = loadOwnedConfig({
      ...environment,
      TRANSCRIPTION_PROVIDER: "unadapted-fixture",
      TRANSCRIPTION_MODEL: "unused",
      TRANSCRIPTION_API_KEY: "synthetic-unapproved-transcription-key",
      VOICE_PROVIDER: "unadapted-fixture",
      VOICE_MODEL: "unused",
      VOICE_API_KEY: "synthetic-unapproved-voice-key",
    });
    expect(config.transcription).toBeUndefined();
    expect(config.voice).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("synthetic-unapproved");
  });
  test("model policy is optional for unavailable agents and requires an absolute protected path when enabled", () => {
    expect(loadOwnedConfig(environment).scoutModelPolicyFile).toBeUndefined();
    const path = join(tmpdir(), "scout-model-policy.json");
    expect(
      loadOwnedConfig({ ...environment, SCOUT_MODEL_POLICY_FILE: path })
        .scoutModelPolicyFile,
    ).toBe(path);
    expect(() =>
      loadOwnedConfig({
        ...environment,
        SCOUT_MODEL_POLICY_FILE: "relative-policy.json",
      }),
    ).toThrow("absolute protected file path");
  });
  test("requires no vendor key, emits no fabricated Intelligence settings, and turns off licensed auto assignment", () => {
    const config = loadOwnedConfig(environment);
    expect(config.runtime).toEqual({ mode: "owned", durableHistory: true });
    expect(config.learningAutoAssign).toBe(false);
    expect(config.selfHostBanner).toBe(false);
    expect(config.singleUser).toBe(false);
  });
  test("the default licensed configuration still refuses missing Intelligence settings", () => {
    expect(() => loadConfig(environment)).toThrow("Intelligence is required");
  });
  test("a misspelled or absent explicit mode is refused", () => {
    for (const mode of [undefined, "local", "intelligenc"])
      expect(() =>
        loadOwnedConfig({ ...environment, SCOUT_RUNTIME_MODE: mode }),
      ).toThrow("SCOUT_RUNTIME_MODE=owned");
  });
  test("an anonymous single-user install cannot enable owned shared history", () => {
    expect(() =>
      loadOwnedConfig({
        ...environment,
        OPENBOT_ORGANIZATION_AUTH_URL: undefined,
        OPENBOT_SINGLE_USER: "true",
      }),
    ).toThrow("verified sign-in");
  });
  test("membership policy must be explicit and absolute", () => {
    expect(() =>
      loadOwnedConfig({ ...environment, SCOUT_QUEUE_BINDINGS_FILE: undefined }),
    ).toThrow("SCOUT_QUEUE_BINDINGS_FILE");
    expect(() =>
      loadOwnedConfig({
        ...environment,
        SCOUT_QUEUE_BINDINGS_FILE: "relative-policy.json",
      }),
    ).toThrow("absolute path");
  });
  test("incidental legacy vendor secrets do not enter the owned runtime contract", () => {
    const config = loadOwnedConfig({
      ...environment,
      INTELLIGENCE_API_URL: "https://unused.fixture.example",
      INTELLIGENCE_API_KEY: "synthetic-not-used",
    });
    expect(JSON.stringify(config.runtime)).not.toContain("synthetic-not-used");
    expect(config.runtime).not.toHaveProperty("intelligence");
  });
});
