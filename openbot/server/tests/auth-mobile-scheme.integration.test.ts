import { afterAll, afterEach, expect, test } from "bun:test";
import { createAuth } from "../src/auth";
import type { DeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The native app's scheme gets the session cookie appended to the OAuth redirect (the Expo plugin's
 * documented behaviour), and any Android app can register that scheme. So a deployment that does not
 * run the native app must not accept the scheme as a callback at all.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const config = {
  auth: {
    baseUrl: "http://127.0.0.1:3000",
    secret: "x".repeat(40),
    trustedOrigins: [],
    initialAdminEmails: [],
    allowedEmailDomains: [],
    google: { clientId: "id", clientSecret: "secret" },
  },
  keyEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
} as unknown as DeploymentConfig;
/** What the Expo plugin's after hook consults before appending the session cookie to a redirect. */
async function sendsSessionTo(auth: ReturnType<typeof createAuth>) {
  const context = (await auth.$context) as {
    isTrustedOrigin: (url: string) => boolean;
  };
  const expoLoaded = (auth.options.plugins ?? []).some(
    (plugin) => plugin.id === "expo",
  );
  return {
    expoLoaded,
    openbot: expoLoaded && context.isTrustedOrigin("openbotmobile://"),
    scout: expoLoaded && context.isTrustedOrigin("scoutmobile://"),
  };
}
afterEach(() => {
  delete process.env.EXPO_PROJECT_ID;
  delete process.env.SCOUT_NATIVE_AUTH_ENABLED;
});
afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

test("without the native app, no sign-in redirect carries a session to an app scheme", async () => {
  expect(await sendsSessionTo(createAuth(config, database))).toEqual({
    expoLoaded: false,
    openbot: false,
    scout: false,
  });
});
test("an existing Expo deployment keeps its project-ID gated OpenBot callback", async () => {
  process.env.EXPO_PROJECT_ID = "0b6c3a0e-2a5e-4a4c-9d5a-2f3b8f0c1d2e";
  expect(await sendsSessionTo(createAuth(config, database))).toEqual({
    expoLoaded: true,
    openbot: true,
    scout: false,
  });
});
test("Scout explicitly enables only its own native callback without an EAS project", async () => {
  process.env.SCOUT_NATIVE_AUTH_ENABLED = "true";
  expect(await sendsSessionTo(createAuth(config, database))).toEqual({
    expoLoaded: true,
    openbot: false,
    scout: true,
  });
});
test("Scout auth opt-in preserves an existing Expo deployment callback", async () => {
  process.env.SCOUT_NATIVE_AUTH_ENABLED = "true";
  process.env.EXPO_PROJECT_ID = "0b6c3a0e-2a5e-4a4c-9d5a-2f3b8f0c1d2e";
  expect(await sendsSessionTo(createAuth(config, database))).toEqual({
    expoLoaded: true,
    openbot: true,
    scout: true,
  });
});
test("Scout native callback opt-in requires the exact true value", async () => {
  process.env.SCOUT_NATIVE_AUTH_ENABLED = "1";
  expect(await sendsSessionTo(createAuth(config, database))).toEqual({
    expoLoaded: false,
    openbot: false,
    scout: false,
  });
});
