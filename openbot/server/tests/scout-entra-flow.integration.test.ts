import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  constants,
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuth } from "../src/auth";
import type { OwnedDeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { accounts, sessions, users, verifications } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `scout-entra-flow-${randomUUID()}`;
const userId = `${prefix}-native-user`;
const accountId = `${prefix}-native-account`;
const email = `${prefix}@fixture.invalid`;
const tenantId = "8f2c1e40-0000-0000-0000-000000000000";
const clientId = `${prefix}-client`;
const objectId = "4e70e6f1-0000-0000-0000-000000000000";
const unprovisionedObjectId = "5f80f7a2-0000-0000-0000-000000000000";
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
const origin = "http://localhost:3001";
const redirectURI = `${origin}/api/auth/callback/microsoft`;
const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyId = `${prefix}-key`;
const codes = new Map<
  string,
  { nonce: string; challenge: string; unknown: boolean }
>();
const verificationIds: string[] = [];
const providerFetches: string[] = [];
const nativeConfig = {
  runtime: { mode: "owned", durableHistory: true },
  auth: {
    baseUrl: origin,
    secret: `${prefix}-synthetic-owned-session-secret`,
    trustedOrigins: [origin],
    initialAdminEmails: [],
    allowedEmailDomains: [],
    microsoft: {
      tenantId,
      clientId,
      clientSecret: `${prefix}-synthetic-client-secret`,
    },
  },
  keyEncryptionKey: Buffer.alloc(32, 41).toString("base64"),
} as unknown as OwnedDeploymentConfig;
let provider: ReturnType<typeof Bun.serve>;
let auth: ReturnType<typeof createAuth>;
let revokeMappingBeforeSession = false;

class CookieJar {
  private readonly values = new Map<string, string>();

  capture(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      if (separator < 0) continue;
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

function signedToken(nonce: string, unknown = false) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: clientId,
      azp: clientId,
      sub: `${prefix}-pairwise-subject`,
      tid: tenantId,
      oid: unknown ? unprovisionedObjectId : objectId,
      ver: "2.0",
      iat: now - 5,
      nbf: now - 5,
      exp: now + 300,
      nonce,
      email,
      name: "Synthetic Entra identity",
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), {
    key: signingKey.privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  }).toString("base64url");
  return `${input}.${signature}`;
}

async function nativeRequest(
  path: string,
  method = "GET",
  body?: unknown,
  cookies = new CookieJar(),
) {
  const response = await auth.handler(
    new Request(new URL(path, origin), {
      method,
      headers: {
        origin,
        cookie: cookies.header(),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  cookies.capture(response);
  return response;
}

async function begin(unknown = false) {
  const cookies = new CookieJar();
  const started = await nativeRequest(
    "/api/auth/sign-in/social",
    "POST",
    {
      provider: "microsoft",
      callbackURL: `${origin}/synthetic-signed-in`,
    },
    cookies,
  );
  expect(started.status).toBe(200);
  const body = (await started.json()) as { url: string; redirect: boolean };
  expect(body.redirect).toBe(true);
  const authorization = new URL(body.url);
  expect(authorization.origin).toBe(provider.url.origin);
  expect(authorization.pathname).toBe("/authorize");
  expect(authorization.searchParams.get("client_id")).toBe(clientId);
  expect(authorization.searchParams.get("redirect_uri")).toBe(redirectURI);
  expect(authorization.searchParams.get("response_type")).toBe("code");
  expect(authorization.searchParams.get("response_mode")).toBe("query");
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  const state = authorization.searchParams.get("state");
  const nonce = authorization.searchParams.get("nonce");
  const challenge = authorization.searchParams.get("code_challenge");
  expect(state).toMatch(/^[\w-]{32,}$/);
  expect(nonce).toMatch(/^[\w-]{32,}$/);
  expect(challenge).toMatch(/^[\w-]{43}$/);
  if (!state || !nonce || !challenge)
    throw new Error("Native Entra flow omitted state");
  verificationIds.push(state);
  const code = `${prefix}-code-${randomUUID()}`;
  codes.set(code, { nonce, challenge, unknown });
  const callback = new URL(redirectURI);
  callback.searchParams.set("state", state);
  callback.searchParams.set("code", code);
  return { cookies, callback };
}

async function finish(flow: Awaited<ReturnType<typeof begin>>) {
  return nativeRequest(
    flow.callback.toString(),
    "GET",
    undefined,
    flow.cookies,
  );
}

async function session(cookies: CookieJar) {
  return auth.api.getSession({
    headers: new Headers({ cookie: cookies.header() }),
    query: { disableCookieCache: true },
  });
}

beforeAll(async () => {
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      providerFetches.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          authorization_endpoint: `${provider.url.origin}/authorize`,
          token_endpoint: `${provider.url.origin}/token`,
          jwks_uri: `${provider.url.origin}/jwks`,
          response_types_supported: ["code"],
          response_modes_supported: ["query"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
        });
      if (url.pathname === "/jwks")
        return Response.json({
          keys: [
            {
              ...signingKey.publicKey.export({ format: "jwk" }),
              kid: keyId,
              alg: "RS256",
              use: "sig",
            },
          ],
        });
      if (url.pathname === "/token" && request.method === "POST") {
        const values = new URLSearchParams(await request.text());
        const code = values.get("code");
        const fixture = code ? codes.get(code) : undefined;
        const verifier = values.get("code_verifier");
        if (
          !fixture ||
          !verifier ||
          values.get("redirect_uri") !== redirectURI ||
          createHash("sha256").update(verifier).digest("base64url") !==
            fixture.challenge
        )
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(code ?? "");
        return Response.json({
          access_token: `${prefix}-synthetic-access-token`,
          token_type: "Bearer",
          expires_in: 300,
          id_token: signedToken(fixture.nonce, fixture.unknown),
        });
      }
      return new Response("Synthetic endpoint unavailable", { status: 404 });
    },
  });

  auth = createAuth(nativeConfig, database);
  const genericOAuth = auth.options.plugins?.find(
    (plugin) => plugin.id === "generic-oauth",
  ) as unknown as
    | { options: { config: Array<Record<string, unknown>> } }
    | undefined;
  const entra = genericOAuth?.options.config.find(
    (entry) => entry.providerId === "microsoft",
  );
  if (!entra) throw new Error("Owned Entra provider was not registered");
  // Substitute only the discovery and endpoints for this synthetic test. The production adapter's
  // tenant, issuer, code flow, nonce, account binding and Better Auth signature verification remain.
  entra.discoveryUrl = `${provider.url.origin}/.well-known/openid-configuration`;
  entra.authorizationUrl = `${provider.url.origin}/authorize`;
  entra.tokenUrl = `${provider.url.origin}/token`;

  const sessionHooks = auth.options.databaseHooks?.session?.create;
  const nativeSessionHook = sessionHooks?.before;
  if (!sessionHooks || !nativeSessionHook)
    throw new Error(
      "The native before-session hook is required for qualification",
    );
  sessionHooks.before = async (value) => {
    if (revokeMappingBeforeSession)
      await database.delete(accounts).where(eq(accounts.id, accountId));
    return nativeSessionHook(value);
  };

  await database.insert(users).values({
    id: userId,
    email,
    emailVerified: true,
    name: "Synthetic provisioned Scout user",
  });
  await database.insert(accounts).values({
    id: accountId,
    userId,
    providerId: "microsoft",
    issuer,
    accountId: objectId,
  });
  await auth.$context;
});

beforeEach(async () => {
  revokeMappingBeforeSession = false;
  providerFetches.length = 0;
  await database.delete(sessions).where(eq(sessions.userId, userId));
  await database
    .insert(accounts)
    .values({
      id: accountId,
      userId,
      providerId: "microsoft",
      issuer,
      accountId: objectId,
    })
    .onConflictDoUpdate({
      target: accounts.id,
      set: { userId, providerId: "microsoft", issuer, accountId: objectId },
    });
});

afterAll(async () => {
  try {
    await provider?.stop(true);
    await database.delete(users).where(eq(users.id, userId));
    if (verificationIds.length)
      await database
        .delete(verifications)
        .where(inArray(verifications.identifier, verificationIds));
  } finally {
    await database.$client.end({ timeout: 5 });
  }
});

describe("actual Better Auth owned Entra authorization-code flow", () => {
  test("creates a session only for the exact preprovisioned tenant object", async () => {
    const flow = await begin();
    const response = await finish(flow);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${origin}/synthetic-signed-in`,
    );
    expect(await session(flow.cookies)).toMatchObject({
      user: { id: userId, email, emailVerified: true },
    });
    expect(providerFetches).toContain("POST /token");
    expect(providerFetches).toContain("GET /jwks");
  });

  test("a signed unknown oid with the provisioned user's email cannot link or create a session", async () => {
    const flow = await begin(true);
    const response = await finish(flow);
    expect([302, 400, 401, 403]).toContain(response.status);
    expect(await session(flow.cookies)).toBeNull();
    expect(
      await database.select().from(sessions).where(eq(sessions.userId, userId)),
    ).toHaveLength(0);
    expect(
      await database.select().from(users).where(eq(users.email, email)),
    ).toHaveLength(1);
  });

  test("client-posted ID tokens, account-link attempts and explicit signup are refused", async () => {
    const directToken = await nativeRequest(
      "/api/auth/sign-in/social",
      "POST",
      {
        provider: "microsoft",
        callbackURL: `${origin}/synthetic-signed-in`,
        idToken: {
          token: "client-controlled-token",
          nonce: "client-controlled-nonce",
        },
      },
    );
    const link = await nativeRequest("/api/auth/sign-in/social", "POST", {
      provider: "microsoft",
      callbackURL: `${origin}/synthetic-signed-in`,
      link: true,
    });
    const signup = await nativeRequest("/api/auth/sign-in/social", "POST", {
      provider: "microsoft",
      callbackURL: `${origin}/synthetic-signed-in`,
      requestSignUp: true,
    });
    expect([400, 403]).toContain(directToken.status);
    expect([400, 403]).toContain(link.status);
    expect([400, 403]).toContain(signup.status);
    expect(providerFetches).toEqual([]);
  });

  test("mapping revocation at session creation stops an otherwise valid callback", async () => {
    revokeMappingBeforeSession = true;
    const flow = await begin();
    const response = await finish(flow);
    expect([302, 400, 401, 403]).toContain(response.status);
    expect(await session(flow.cookies)).toBeNull();
    expect(
      await database.select().from(sessions).where(eq(sessions.userId, userId)),
    ).toHaveLength(0);
  });
});
