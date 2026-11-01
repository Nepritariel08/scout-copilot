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
