import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configuredAuthProviders,
  loadConfig,
  loadOwnedConfig,
} from "../src/config";

const environment = {
  DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:25434/scout_model_test",
  KEY_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64"),
  SCOUT_RUNTIME_MODE: "owned",
  SCOUT_QUEUE_BINDINGS_FILE: join(
    tmpdir(),
    "scout-auth0-synthetic-binding.json",
  ),
  AUTH0_OAUTH_CLIENT_ID: "synthetic-client",
  AUTH0_OAUTH_CLIENT_SECRET: "synthetic-client-secret",
  AUTH0_OAUTH_ISSUER: "https://identity.auth0.fixture.example/",
  AUTH0_OAUTH_REDIRECT_URI: "https://scout.fixture.example/oauth2/callback",
  BETTER_AUTH_URL: "https://scout.fixture.example",
  BETTER_AUTH_SECRET:
    "synthetic-native-session-secret-of-more-than-32-characters",
  INITIAL_ADMIN_EMAILS: "owner@fixture.example",
};

describe("protected owned Auth0 configuration", () => {
  test("supports Auth0 alone with exact protected registration and no owner/tenant defaults", () => {
    const config = loadOwnedConfig(environment);
    expect(config.auth?.auth0).toEqual({
      issuer: environment.AUTH0_OAUTH_ISSUER,
      redirectURI: environment.AUTH0_OAUTH_REDIRECT_URI,
      clientId: environment.AUTH0_OAUTH_CLIENT_ID,
      clientSecret: environment.AUTH0_OAUTH_CLIENT_SECRET,
    });
    expect(configuredAuthProviders(config.auth)).toEqual(["auth0"]);
    expect(config.scoutPlatformOwnerIds).toEqual([]);
    expect(config.scoutDelegatedDraftsEnabled).toBe(false);
    expect(config.organizationAuthUrl).toBeUndefined();
  });

  test("refuses partial client or issuer/callback registration instead of silently disabling auth", () => {
    for (const key of [
      "AUTH0_OAUTH_CLIENT_ID",
      "AUTH0_OAUTH_CLIENT_SECRET",
      "AUTH0_OAUTH_ISSUER",
      "AUTH0_OAUTH_REDIRECT_URI",
    ])
      expect(() =>
        loadOwnedConfig({ ...environment, [key]: undefined }),
      ).toThrow("AUTH0_OAUTH_");
  });

  test("pins canonical HTTPS issuer and exact legacy callback without aliases or URL credentials", () => {
    for (const issuer of [
      "http://identity.auth0.fixture.example/",
      "https://identity.auth0.fixture.example",
      "https://identity.auth0.fixture.example/path",
      "https://identity.auth0.fixture.example/?query",
      "https://identity.auth0.fixture.example/#fragment",
      "https://user:password@identity.auth0.fixture.example/",
      "https://IDENTITY.auth0.fixture.example/",
      "not-a-url",
    ])
      expect(() =>
        loadOwnedConfig({ ...environment, AUTH0_OAUTH_ISSUER: issuer }),
      ).toThrow("Auth0");
    for (const callback of [
      "http://scout.fixture.example/oauth2/callback",
      "https://scout.fixture.example/api/auth/callback/auth0",
      "https://scout.fixture.example/oauth2/callback/",
      "https://scout.fixture.example/oauth2/%63allback",
      "https://scout.fixture.example/oauth2/callback?query",
      "https://user:password@scout.fixture.example/oauth2/callback",
    ])
      expect(() =>
        loadOwnedConfig({ ...environment, AUTH0_OAUTH_REDIRECT_URI: callback }),
      ).toThrow("Auth0");
    expect(() =>
      loadOwnedConfig({
        ...environment,
        BETTER_AUTH_URL: "https://other.fixture.example",
      }),
    ).toThrow("share BETTER_AUTH_URL");
  });

  test("requires the native session secret and exact operator administrator configuration", () => {
    expect(() =>
      loadOwnedConfig({ ...environment, BETTER_AUTH_SECRET: undefined }),
    ).toThrow("BETTER_AUTH_SECRET");
    expect(() =>
      loadOwnedConfig({ ...environment, INITIAL_ADMIN_EMAILS: undefined }),
    ).toThrow("INITIAL_ADMIN_EMAILS");
  });

  test("does not activate Auth0 in the default licensed composition", () => {
    expect(() =>
      loadConfig({ ...environment, SCOUT_RUNTIME_MODE: undefined }),
    ).toThrow("SCOUT_RUNTIME_MODE=owned");
    const {
      AUTH0_OAUTH_CLIENT_ID: _id,
      AUTH0_OAUTH_CLIENT_SECRET: _secret,
      AUTH0_OAUTH_ISSUER: _issuer,
      AUTH0_OAUTH_REDIRECT_URI: _callback,
      ...withoutAuth0
    } = environment;
    const config = loadConfig({
      ...withoutAuth0,
      SCOUT_RUNTIME_MODE: undefined,
      GOOGLE_OAUTH_CLIENT_ID: "synthetic-google-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-google-secret",
      INTELLIGENCE_API_URL: "https://intelligence.fixture.example",
      INTELLIGENCE_GATEWAY_WS_URL: "wss://intelligence.fixture.example",
      INTELLIGENCE_API_KEY: "synthetic-intelligence-key",
    });
    expect(config.auth?.auth0).toBeUndefined();
    expect(configuredAuthProviders(config.auth)).toEqual(["google"]);
    expect(config.runtime.mode).toBe("intelligence");
  });
});
