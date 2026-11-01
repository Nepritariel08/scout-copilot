import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { createAuth } from "../src/auth";
import type { AuthService } from "../src/auth/guards";
import { scoutAuth0CallbackAlias } from "../src/auth/scout-auth0-callback";
import {
  loadConfig,
  loadOwnedConfig,
  type OwnedDeploymentConfig,
} from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  sessions,
  userRoles,
  users,
  verifications,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `scout-auth0-flow-${randomUUID()}`;
const userId = `${prefix}-native-user`;
const accountId = `${prefix}-native-account`;
const email = `${prefix}@fixture.invalid`;
const newEmail = `${prefix}-new@fixture.invalid`;
const subject = `auth0|${prefix}`;
const clientId = `${prefix}-client`;
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = `${prefix}-signing-key`;

type Scenario =
  | "valid"
  | "forged-profile"
  | "missing-token"
  | "wrong-issuer"
  | "wrong-audience"
  | "wrong-signature"
  | "expired"
  | "wrong-nonce"
  | "unverified-email"
  | "unknown-subject"
  | "new-signup";
type CodeFixture = {
  scenario: Scenario;
  authorization: URL;
};
type Flow = {
  authorization: URL;
  callback: URL;
  cookies: CookieJar;
  stateCookies: string[];
};

let provider: ReturnType<typeof Bun.serve>;
let browser: ReturnType<typeof Bun.serve>;
let auth: ReturnType<typeof createAuth>;
let nativeConfig: OwnedDeploymentConfig;
let observed: AuthService;
let browserDispatch: (request: Request) => Response | Promise<Response>;
let defaultDispatch: typeof browserDispatch;
let issuer = "";
let origin = "";
let redirectURI = "";
let revoked = false;
let revokeMappingBeforeSession = false;
let mappingRevocations = 0;
let revokeChecks = 0;
let nativeCallbacks: { path: string; cookie: string | null }[] = [];
let tokenRequests: {
  code: string | null;
  redirectURI: string | null;
  verifier: string | null;
  grantType: string | null;
}[] = [];
const scenarios = new Map<string, Scenario>();
const codes = new Map<string, CodeFixture>();
const stateIds: string[] = [];
const seenNonces = new Set<string>();
const seenStates = new Set<string>();

class CookieJar {
  private readonly values = new Map<string, string>();
  capture(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      if (/;\s*max-age=0(?:;|$)/i.test(cookie)) this.values.delete(name);
      else this.values.set(name, pair.slice(separator + 1));
    }
  }
  header() {
    return [...this.values]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function signedToken(fixture: CodeFixture) {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: issuer,
    aud: clientId,
    sub: subject,
    iat: now - 5,
    exp: now + 300,
    nonce: fixture.authorization.searchParams.get("nonce"),
    email,
    email_verified: true,
    name: "Synthetic provisioned Scout user",
  };
  switch (fixture.scenario) {
    case "forged-profile":
      claims.groups = ["synthetic-administrators"];
      claims.role = "admin";
      claims.roles = ["admin"];
      claims.preferences = { syntheticOverride: "untrusted-signed-profile" };
      claims.tenantId = "synthetic-unrelated-tenant";
      break;
    case "wrong-issuer":
      claims.iss = `${issuer}other-issuer`;
      break;
    case "wrong-audience":
      claims.aud = "synthetic-unregistered-client";
      break;
    case "expired":
      claims.exp = now - 300;
      break;
    case "wrong-nonce":
      claims.nonce = "synthetic-unrelated-nonce".repeat(2);
      break;
    case "unverified-email":
      claims.email_verified = false;
      break;
    case "unknown-subject":
      claims.sub = `${subject}-unprovisioned`;
      break;
    case "new-signup":
      claims.sub = `${subject}-new`;
      claims.email = newEmail;
      break;
  }
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(input),
    fixture.scenario === "wrong-signature"
      ? wrongKey.privateKey
      : key.privateKey,
  ).toString("base64url");
  return `${input}.${signature}`;
}

function nativeRequest(
  path: string,
  method = "GET",
  body?: unknown,
  cookies = new CookieJar(),
) {
  return fetch(new URL(path, origin), {
    method,
    redirect: "manual",
    headers: {
      origin,
      cookie: cookies.header(),
      "content-type": "application/json",
      // Neither an identity proxy nor browser-submitted user/tenant headers can establish a session.
      "x-auth-request-user": "synthetic-attacker",
      "x-tenant-id": "synthetic-attacker-tenant",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function begin(
  scenario: Scenario = "valid",
  extra: object = {},
): Promise<Flow> {
  const cookies = new CookieJar();
  const started = await nativeRequest("/api/auth/sign-in/social", "POST", {
    provider: "auth0",
    callbackURL: `${origin}/synthetic-signed-in`,
    ...extra,
  });
  expect(started.status).toBe(200);
  const stateCookies = started.headers.getSetCookie();
  cookies.capture(started);
  const body = (await started.json()) as { url: string; redirect: boolean };
  expect(body.redirect).toBe(true);
  const authorization = new URL(body.url);
  expect(authorization.origin).toBe(new URL(issuer).origin);
  expect(authorization.pathname).toBe("/authorize");
  expect(authorization.searchParams.get("redirect_uri")).toBe(redirectURI);
  expect(authorization.searchParams.get("client_id")).toBe(clientId);
  expect(authorization.searchParams.get("response_type")).toBe("code");
  expect(authorization.searchParams.get("response_mode")).toBe("query");
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("code_challenge")).toMatch(
    /^[\w-]{43}$/,
  );
  expect(authorization.searchParams.get("scope")?.split(" ")).toEqual(
    expect.arrayContaining(["openid", "profile", "email"]),
  );
  const state = authorization.searchParams.get("state");
  const nonce = authorization.searchParams.get("nonce");
  expect(state).toMatch(/^[\w-]{32,}$/);
  expect(nonce).toMatch(/^[\w-]{32,}$/);
  if (!state || !nonce) throw new Error("Native flow omitted state or nonce");
  expect(seenStates.has(state)).toBe(false);
  expect(seenNonces.has(nonce)).toBe(false);
  seenStates.add(state);
  seenNonces.add(nonce);
  stateIds.push(state);
  scenarios.set(state, scenario);
  const redirected = await fetch(authorization, { redirect: "manual" });
  expect(redirected.status).toBe(302);
  const callback = new URL(redirected.headers.get("location") ?? "", origin);
  expect(callback.origin).toBe(origin);
  expect(callback.pathname).toBe("/oauth2/callback");
  expect(callback.searchParams.get("state")).toBe(state);
  return { authorization, callback, cookies, stateCookies };
}

async function finish(
  flow: Flow,
  callback = flow.callback,
  cookies = flow.cookies,
) {
  const response = await nativeRequest(
    callback.toString(),
    "GET",
    undefined,
    cookies,
  );
  cookies.capture(response);
  return response;
}

async function nativeSession(cookies: CookieJar) {
  const response = await nativeRequest(
    "/api/auth/get-session",
    "GET",
    undefined,
    cookies,
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function assertDenied(flow: Flow, response: Response) {
  expect([302, 303, 400, 401, 403]).toContain(response.status);
  const location = response.headers.get("location");
  if (location)
    expect(new URL(location, origin).pathname).not.toBe("/synthetic-signed-in");
  expect(await nativeSession(flow.cookies)).toBeNull();
  expect(
    await database.select().from(sessions).where(eq(sessions.userId, userId)),
  ).toHaveLength(0);
  expect(
    await database
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.email, [email, newEmail])),
  ).toEqual([{ id: userId }]);
}

beforeAll(async () => {
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}authorize`,
          token_endpoint: `${issuer}token`,
          userinfo_endpoint: `${issuer}userinfo`,
          jwks_uri: `${issuer}jwks`,
          response_types_supported: ["code"],
          response_modes_supported: ["query"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        });
      if (url.pathname === "/jwks")
        return Response.json({
          keys: [
            {
              ...key.publicKey.export({ format: "jwk" }),
              kid,
              alg: "RS256",
              use: "sig",
            },
          ],
        });
      if (url.pathname === "/authorize" && request.method === "GET") {
        const state = url.searchParams.get("state");
        const scenario = state ? scenarios.get(state) : undefined;
        if (!scenario)
          return new Response("Synthetic state unknown", { status: 400 });
        const code = `${prefix}-code-${randomUUID()}`;
        codes.set(code, { scenario, authorization: url });
        const callback = new URL(redirectURI);
        callback.searchParams.set("state", state ?? "");
        callback.searchParams.set("code", code);
        return Response.redirect(callback, 302);
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const values = new URLSearchParams(await request.text());
        const code = values.get("code");
        const fixture = code ? codes.get(code) : undefined;
        const verifier = values.get("code_verifier");
        tokenRequests.push({
          code,
          verifier,
          redirectURI: values.get("redirect_uri"),
          grantType: values.get("grant_type"),
        });
        if (
          !fixture ||
          !verifier ||
          values.get("redirect_uri") !== redirectURI ||
          createHash("sha256").update(verifier).digest("base64url") !==
            fixture.authorization.searchParams.get("code_challenge")
        )
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(code ?? "");
        return Response.json({
          access_token: `synthetic-access-${randomUUID()}`,
          token_type: "Bearer",
          expires_in: 300,
          ...(fixture.scenario === "missing-token"
            ? {}
            : { id_token: signedToken(fixture) }),
        });
      }
      return new Response("Synthetic endpoint unavailable", { status: 404 });
    },
  });
  issuer = `${provider.url.origin}/`;
  const app = new Hono();
  defaultDispatch = (request) => app.fetch(request);
  browserDispatch = defaultDispatch;
  browser = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => browserDispatch(request),
  });
  origin = browser.url.origin;
  redirectURI = `${origin}/oauth2/callback`;
  // Only this synthetic issuer uses HTTP loopback. Production loader HTTPS pinning has separate tests.
  nativeConfig = {
    runtime: { mode: "owned", durableHistory: true },
    auth: {
      baseUrl: origin,
      secret: `${prefix}-synthetic-native-session-secret`,
      trustedOrigins: [origin],
      initialAdminEmails: [],
      allowedEmailDomains: [],
      auth0: {
        issuer,
        redirectURI,
        clientId,
        clientSecret: `${prefix}-synthetic-secret`,
      },
    },
    keyEncryptionKey: Buffer.alloc(32, 37).toString("base64"),
  } as unknown as OwnedDeploymentConfig;
  auth = createAuth(nativeConfig, database, async (value) => {
    expect(value).toBe(email);
    revokeChecks++;
    return revoked;
  });
  const sessionHooks = auth.options.databaseHooks?.session?.create;
  const nativeSessionHook = sessionHooks?.before;
  if (!sessionHooks || !nativeSessionHook)
    throw new Error(
      "The native before-session hook is required for qualification",
    );
  // Inject only revocation timing; the production hook still performs every admission check.
  sessionHooks.before = async (session) => {
    if (revokeMappingBeforeSession) {
      await database.delete(accounts).where(eq(accounts.id, accountId));
      mappingRevocations++;
    }
    return nativeSessionHook(session);
  };
  observed = {
    api: auth.api,
    handler: (request) => {
      if (new URL(request.url).pathname === "/api/auth/callback/auth0")
        nativeCallbacks.push({
          path: new URL(request.url).pathname,
          cookie: request.headers.get("cookie"),
        });
      return auth.handler(request);
    },
  };
  app.use("*", scoutAuth0CallbackAlias(observed));
  app.all("/api/auth/*", (context) => auth.handler(context.req.raw));
  await database
    .insert(users)
    .values({ id: userId, email, emailVerified: true });
  await database.insert(userRoles).values({ userId, role: "user" });
  await auth.$context;
});

beforeEach(async () => {
  revoked = false;
  revokeMappingBeforeSession = false;
  mappingRevocations = 0;
  revokeChecks = 0;
  nativeCallbacks = [];
  tokenRequests = [];
  browserDispatch = defaultDispatch;
  await database.delete(sessions).where(eq(sessions.userId, userId));
  await database
    .update(users)
    .set({ emailVerified: true })
    .where(eq(users.id, userId));
  await database
    .insert(accounts)
    .values({
      id: accountId,
      userId,
      providerId: "auth0",
      issuer,
      accountId: subject,
    })
    .onConflictDoUpdate({
      target: accounts.id,
      set: { userId, providerId: "auth0", issuer, accountId: subject },
    });
});

afterAll(async () => {
  try {
    await browser?.stop(true);
    await provider?.stop(true);
    await database.delete(users).where(inArray(users.email, [email, newEmail]));
    if (stateIds.length)
      await database
        .delete(verifications)
        .where(inArray(verifications.identifier, stateIds));
  } finally {
    await database.$client.close();
  }
});

describe("actual BetterAuth Auth0 authorization-code flow", () => {
  test("signed local OIDC login returns through the legacy callback and creates the exact preprovisioned native session", async () => {
    const flow = await begin();
    expect(
      flow.stateCookies.some((cookie) =>
        /(?:oauth_state|\.state)=/.test(cookie),
      ),
    ).toBe(true);
    expect(flow.stateCookies.every((cookie) => /HttpOnly/i.test(cookie))).toBe(
      true,
    );
    expect(
      flow.stateCookies.every((cookie) => /SameSite=Lax/i.test(cookie)),
    ).toBe(true);
    const response = await finish(flow);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${origin}/synthetic-signed-in`,
    );
    expect(
      response.headers
        .getSetCookie()
        .some((cookie) => /session_token=/.test(cookie)),
    ).toBe(true);
    expect(await nativeSession(flow.cookies)).toMatchObject({
      user: { id: userId, email, emailVerified: true },
    });
    expect(
      await auth.api.getSession({
        headers: new Headers({ cookie: flow.cookies.header() }),
        query: { disableCookieCache: true },
      }),
    ).toMatchObject({ user: { id: userId, email } });
    expect(nativeCallbacks).toHaveLength(1);
    expect(nativeCallbacks[0]?.path).toBe("/api/auth/callback/auth0");
    expect(nativeCallbacks[0]?.cookie).toContain("state=");
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toMatchObject({
      redirectURI,
      grantType: "authorization_code",
    });
    expect(tokenRequests[0]?.verifier).toMatch(/^[\w-]{43,128}$/);
    expect(revokeChecks).toBeGreaterThan(0);
    expect(
      await database
        .select({ userId: sessions.userId })
        .from(sessions)
        .where(eq(sessions.userId, userId)),
    ).toEqual([{ userId }]);
  });

  test("valid signed profile extras cannot replace native groups, preferences or role grants", async () => {
    const snapshot = () =>
      database
        .select({ groups: users.groups, preferences: users.preferences })
        .from(users)
        .where(eq(users.id, userId));
    const original = await snapshot();
    expect(original).toEqual([{ groups: [], preferences: {} }]);
    const flow = await begin("forged-profile");
    const response = await finish(flow);
    expect(response.headers.get("location")).toBe(
      `${origin}/synthetic-signed-in`,
    );
    expect(await nativeSession(flow.cookies)).toMatchObject({
      user: { id: userId, email, groups: [], preferences: {} },
    });
    expect(await snapshot()).toEqual(original);
    expect(
      await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, userId)),
    ).toEqual([{ role: "user" }]);
  });

  test("a fresh verified signed claim updates an existing unverified native user before session admission", async () => {
    await database
      .update(users)
      .set({ emailVerified: false })
      .where(eq(users.id, userId));
    const flow = await begin();
    const response = await finish(flow);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${origin}/synthetic-signed-in`,
    );
    expect(await nativeSession(flow.cookies)).toMatchObject({
      user: { id: userId, email, emailVerified: true },
    });
    expect(
      await database
        .select({ verified: users.emailVerified })
        .from(users)
        .where(eq(users.id, userId)),
    ).toEqual([{ verified: true }]);
    expect(tokenRequests).toHaveLength(1);
  });

  test("production app composition exposes Auth0 and mounts only the owned callback behind raw namespace admission", async () => {
    const environment = testEnvironment({
      DATABASE_URL: testDatabaseUrl(),
      KEY_ENCRYPTION_KEY: nativeConfig.keyEncryptionKey,
      SCOUT_RUNTIME_MODE: "owned",
      DEPLOYMENT_ID: "scout-auth0-test",
      SCOUT_MEMBERSHIPS_FILE: `${process.cwd()}/synthetic-unused-auth0-binding.json`,
      BETTER_AUTH_URL: origin,
      OPENBOT_HOST: "127.0.0.1",
    });
    const config = { ...loadOwnedConfig(environment), auth: nativeConfig.auth };
    let tenantChecks = 0;
    const composed = (appConfig: Parameters<typeof createApp>[0]) => {
      const args: Parameters<typeof createApp> = [
        appConfig,
        observed,
        { rolesForUser: async () => ["user"] },
      ];
      args[34] = {
        scoutOwned: {
          requireTenant: async (context) => {
            tenantChecks++;
            return context.json({ code: "SYNTHETIC_TENANT_REQUIRED" }, 403);
          },
        },
      };
      return createApp(...args);
    };
    const owned = composed(config);
    browserDispatch = (request) => owned.fetch(request);
    const capabilities = await nativeRequest("/api/capabilities");
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({
      mode: "owned",
      authProviders: ["auth0"],
    });
    const flow = await begin();
    const response = await finish(flow);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${origin}/synthetic-signed-in`,
    );
    expect(await nativeSession(flow.cookies)).toMatchObject({
      user: { id: userId, email },
    });
    expect(nativeCallbacks).toHaveLength(1);
    expect(tenantChecks).toBe(0);
    const directNative = await nativeRequest(
      "/api/auth/callback/auth0?code=synthetic-without-state",
    );
    expect(directNative.status).toBe(302);
    expect(directNative.headers.get("location")).toContain("state_not_found");
    const callbackCount = nativeCallbacks.length;
    for (const path of [
      "/%6fauth2/callback",
      "/o%61uth2/callback",
      "/%61pi/capabilities",
      "/%61pi/auth/callback/auth0",
    ])
      expect((await nativeRequest(path)).status).toBe(503);
    expect((await nativeRequest("/oauth2/%63allback")).status).toBe(404);
    expect(nativeCallbacks).toHaveLength(callbackCount);
    expect(tokenRequests).toHaveLength(1);
    expect(
      (await nativeRequest("/api/me", "GET", undefined, flow.cookies)).status,
    ).toBe(403);
    expect(tenantChecks).toBe(1);

    const noAuth0 = composed({
      ...config,
      auth: nativeConfig.auth
        ? { ...nativeConfig.auth, auth0: undefined }
        : undefined,
    });
    const licensed = composed(
      loadConfig(
        testEnvironment({
          BETTER_AUTH_URL: origin,
          KEY_ENCRYPTION_KEY: nativeConfig.keyEncryptionKey,
        }),
      ),
    );
    for (const app of [noAuth0, licensed]) {
      const unmounted = await app.fetch(
        new Request(`${origin}/oauth2/callback?state=synthetic&code=synthetic`),
      );
      expect(unmounted.status).toBe(404);
      expect(unmounted.headers.getSetCookie()).toEqual([]);
    }
    expect(nativeCallbacks).toHaveLength(callbackCount);
  });

  for (const variation of [
    "missing-state",
    "bad-state",
    "missing-cookie",
    "tampered-cookie",
  ] as const)
    test(`${variation} refuses before code exchange`, async () => {
      const flow = await begin();
      const callback = new URL(flow.callback);
      let cookies = flow.cookies;
      if (variation === "missing-state") callback.searchParams.delete("state");
      if (variation === "bad-state")
        callback.searchParams.set("state", "synthetic-unrelated-state");
      if (variation === "missing-cookie") cookies = new CookieJar();
      if (variation === "tampered-cookie") {
        cookies = new CookieJar();
        cookies.capture(
          new Response(null, {
            headers: {
              "set-cookie":
                "better-auth.state=synthetic-tampered; Path=/; HttpOnly",
            },
          }),
        );
      }
      await assertDenied(flow, await finish(flow, callback, cookies));
      expect(tokenRequests).toHaveLength(0);
    });

  for (const scenario of [
    "missing-token",
    "wrong-issuer",
    "wrong-audience",
    "wrong-signature",
    "expired",
    "wrong-nonce",
    "unverified-email",
  ] as const)
    test(`${scenario} cannot create a native session from a signed code response`, async () => {
      expect(
        await database
          .select({ verified: users.emailVerified })
          .from(users)
          .where(eq(users.id, userId)),
      ).toEqual([{ verified: true }]);
      const flow = await begin(scenario);
      await assertDenied(flow, await finish(flow));
      expect(tokenRequests).toHaveLength(1);
      expect(revokeChecks).toBe(0);
    });

  test("a valid signed but unknown subject cannot implicitly link an existing verified email", async () => {
    const flow = await begin("unknown-subject");
    await assertDenied(flow, await finish(flow));
    expect(
      await database
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.userId, userId)),
    ).toEqual([{ id: accountId }]);
  });

  test("explicit sign-up does not provision an unregistered Auth0 subject or email", async () => {
    const flow = await begin("new-signup", { requestSignUp: true });
    await assertDenied(flow, await finish(flow));
    expect(
      await database
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.accountId, `${subject}-new`)),
    ).toHaveLength(0);
  });

  test("a browser-submitted valid ID token cannot replace the native state/PKCE flow", async () => {
    const token = signedToken({
      scenario: "valid",
      authorization: new URL(`${issuer}authorize?nonce=${"s".repeat(32)}`),
    });
    const response = await nativeRequest("/api/auth/sign-in/social", "POST", {
      provider: "auth0",
      callbackURL: `${origin}/synthetic-signed-in`,
      idToken: { token, nonce: "s".repeat(32) },
    });
    expect(response.status).toBe(403);
    expect(await nativeSession(new CookieJar())).toBeNull();
    expect(tokenRequests).toHaveLength(0);
    expect(nativeCallbacks).toHaveLength(0);
  });

  test("removed operator account mapping refuses while the verified native email still exists", async () => {
    const flow = await begin();
    await database.delete(accounts).where(eq(accounts.id, accountId));
    await assertDenied(flow, await finish(flow));
    expect(tokenRequests).toHaveLength(1);
    expect(revokeChecks).toBe(0);
  });

  for (const provisionedIssuer of [
    null,
    "https://synthetic-other-issuer.fixture.invalid/",
  ])
    test(`a provisioned account with ${provisionedIssuer === null ? "no issuer" : "another issuer"} cannot match the signed identity`, async () => {
      await database
        .update(accounts)
        .set({ issuer: provisionedIssuer })
        .where(eq(accounts.id, accountId));
      const flow = await begin();
      await assertDenied(flow, await finish(flow));
      expect(tokenRequests).toHaveLength(1);
      expect(revokeChecks).toBe(0);
    });

  test("mapping revocation after signed profile admission is rechecked immediately before native session creation", async () => {
    const flow = await begin();
    revokeMappingBeforeSession = true;
    await assertDenied(flow, await finish(flow));
    expect(mappingRevocations).toBe(1);
    expect(revokeChecks).toBe(0);
    expect(tokenRequests).toHaveLength(1);
    expect(
      await database
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, accountId)),
    ).toHaveLength(0);
  });

  test("native removal after login starts refuses before a session is inserted", async () => {
    const flow = await begin();
    revoked = true;
    await assertDenied(flow, await finish(flow));
    expect(revokeChecks).toBe(1);
    expect(
      await database
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.issuer, issuer))),
    ).toEqual([{ id: accountId }]);
  });

  test("a consumed callback cannot exchange its code or create another session", async () => {
    const flow = await begin();
    expect((await finish(flow)).headers.get("location")).toBe(
      `${origin}/synthetic-signed-in`,
    );
    const replay = await finish(flow);
    expect(replay.headers.get("location")).toContain("error=");
    expect(tokenRequests).toHaveLength(1);
    expect(
      await database
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, userId)),
    ).toHaveLength(1);
  });
});

describe("legacy callback alias transport boundary", () => {
  test("only the exact GET path forwards native query/cookies/headers and preserves every native response header", async () => {
    let received: Request | undefined;
    const app = new Hono();
    const responseHeaders = new Headers({
      location: "http://127.0.0.1/synthetic-next",
    });
    responseHeaders.append(
      "set-cookie",
      "synthetic-session=first; Path=/; HttpOnly",
    );
    responseHeaders.append("set-cookie", "synthetic-state=; Path=/; Max-Age=0");
    const service: AuthService = {
      api: { getSession: async () => null },
      handler: (request) => {
        received = request;
        return new Response(null, { status: 302, headers: responseHeaders });
      },
    };
    app.use("*", scoutAuth0CallbackAlias(service));
    const response = await app.fetch(
      new Request(
        "http://127.0.0.1/oauth2/callback?state=synthetic-state&code=synthetic-code",
        {
          headers: {
            cookie: "synthetic-state=fixture",
            "x-synthetic-header": "fixture",
          },
        },
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      responseHeaders.get("location"),
    );
    expect(response.headers.getSetCookie()).toEqual(
      responseHeaders.getSetCookie(),
    );
    expect(received?.url).toBe(
      "http://127.0.0.1/api/auth/callback/auth0?state=synthetic-state&code=synthetic-code",
    );
    expect(received?.headers.get("cookie")).toBe("synthetic-state=fixture");
    expect(received?.headers.get("x-synthetic-header")).toBe("fixture");
    for (const path of [
      "/oauth2",
      "/oauth2/callback/",
      "/oauth2//callback",
      "//oauth2/callback",
      "/OAUTH2/callback",
      "/oauth2/%63allback",
      "/%6fauth2/callback",
      "/oauth2/future",
    ])
      for (const method of ["GET", "POST"])
        expect(
          (await app.fetch(new Request(`http://127.0.0.1${path}`, { method })))
            .status,
        ).toBe(404);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
      expect(
        (
          await app.fetch(
            new Request("http://127.0.0.1/oauth2/callback", { method }),
          )
        ).status,
      ).toBe(404);
    expect(received?.url).toBe(
      "http://127.0.0.1/api/auth/callback/auth0?state=synthetic-state&code=synthetic-code",
    );
  });

  test("an unavailable native auth service cannot turn a callback into a session", async () => {
    const app = new Hono();
    app.use("*", scoutAuth0CallbackAlias(undefined));
    const response = await app.fetch(
      new Request(
        "http://127.0.0.1/oauth2/callback?state=synthetic&code=synthetic",
      ),
    );
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
