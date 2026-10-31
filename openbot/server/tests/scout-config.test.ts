import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

test("the queue is absent by default and an authenticated deployment can select a protected binding file", () => {
  expect(loadConfig(testEnvironment()).scoutQueueBindingsFile).toBeUndefined();
  const path = join(tmpdir(), "operator-managed-scout-bindings.json");
  expect(
    loadConfig(testEnvironment({ SCOUT_QUEUE_BINDINGS_FILE: path }))
      .scoutQueueBindingsFile,
  ).toBe(path);
});
test("a relative binding file or a shared single-user actor cannot activate the queue", () => {
  expect(() =>
    loadConfig(testEnvironment({ SCOUT_QUEUE_BINDINGS_FILE: "relative.json" })),
  ).toThrow("verified sign-in");
  expect(() =>
    loadConfig(
      testEnvironment({
        SCOUT_QUEUE_BINDINGS_FILE: join(tmpdir(), "bindings.json"),
        GOOGLE_OAUTH_CLIENT_ID: undefined,
        GOOGLE_OAUTH_CLIENT_SECRET: undefined,
        BETTER_AUTH_SECRET: undefined,
        BETTER_AUTH_URL: undefined,
        INITIAL_ADMIN_EMAILS: undefined,
        OPENBOT_SINGLE_USER: "true",
      }),
    ),
  ).toThrow("single-user mode is refused");
});
