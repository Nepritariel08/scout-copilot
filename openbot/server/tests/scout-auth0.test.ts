import { describe, expect, test } from "bun:test";
import { constants, generateKeyPairSync, sign } from "node:crypto";
import {
  admittedScoutAuth0Claims,
  createScoutAuth0Adapter,
} from "../src/auth/scout-auth0";
import type { ScoutAuth0Config } from "../src/config";

const config: ScoutAuth0Config = {
  issuer: "https://identity.auth0.fixture.example/",
  clientId: "synthetic-scout-auth0-client",
  clientSecret: "synthetic-client-secret",
  redirectURI: "https://scout.fixture.example/oauth2/callback",
};
const now = 1_800_000_000_000;
const state = {
  codeVerifier: "synthetic-native-pkce-verifier-".repeat(4),
  idTokenNonce: "synthetic-server-generated-native-nonce",
  expiresAt: now + 600_000,
  serverContext: {
    scoutAuth0: {
      issuer: config.issuer,
      clientId: config.clientId,
      redirectURI: config.redirectURI,
    },
  },
};
const claims = {
  iss: config.issuer,
  aud: config.clientId,
  sub: "auth0|synthetic-owner-subject",
  exp: now / 1000 + 300,
  email: "owner@fixture.example",
  email_verified: true as const,
  nonce: state.idTokenNonce,
};
// Signed solely with this process's synthetic key. Native signature/JWKS verification is qualified
// by the actual OIDC callback integration; these cases test the additional admission predicate.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
function token(values: Record<string, unknown> = claims, algorithm = "RS256") {
  const body = [
    { alg: algorithm, typ: "JWT", kid: "synthetic-unit-key" },
    values,
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  return `${body}.${sign("sha256", Buffer.from(body), {
    key: privateKey,
    padding:
      algorithm === "PS256"
        ? constants.RSA_PKCS1_PSS_PADDING
        : constants.RSA_PKCS1_PADDING,
    ...(algorithm === "PS256"
      ? { saltLength: constants.RSA_PSS_SALTLEN_DIGEST }
      : {}),
  }).toString("base64url")}`;
}

describe("owned Auth0 admission after native cryptographic validation", () => {
  test("admits the exact configured issuer/client and fresh verified subject for RS256/PS256", () => {
    for (const algorithm of ["RS256", "PS256"])
      expect(
        admittedScoutAuth0Claims(token(claims, algorithm), config, state, now),
      ).toEqual(claims);
  });

  test("refuses missing, malformed and symmetric/unsecured ID tokens", () => {
    for (const value of [
      undefined,
      "",
      "opaque-access-token",
      "a.b.c",
      "e30.e30.",
      token(claims, "HS256"),
      token(claims, "none"),
      token(claims, "ES256"),
    ])
      expect(admittedScoutAuth0Claims(value, config, state, now)).toBeNull();
  });

  test("requires fresh exact standard identity claims and freshly verified provider email", () => {
    for (const replacement of [
      { iss: "https://other.auth0.fixture.example/" },
      { iss: config.issuer.slice(0, -1) },
      { aud: "other-client" },
      { aud: [config.clientId, "another-client"] },
      { azp: "another-client" },
      { sub: "" },
      { sub: "auth0|owner\u0000" },
      { sub: "auth0|owner subject" },
      { sub: "x".repeat(256) },
      { exp: undefined },
      { exp: now / 1000 },
      { exp: "future" },
      { email: "" },
      { email: "owner" },
      { email: " owner@fixture.example" },
      { email_verified: false },
      { email_verified: "true" },
      { email_verified: undefined },
      { nonce: "different-native-nonce" },
      { nonce: undefined },
    ])
      expect(
        admittedScoutAuth0Claims(
          token({ ...claims, ...replacement }),
          config,
          state,
          now,
        ),
      ).toBeNull();
  });

  test("requires native state, protected server marker, PKCE and exact native nonce", () => {
    for (const value of [
      null,
      {},
      { ...state, serverContext: undefined },
      {
        ...state,
        serverContext: {
          scoutAuth0: {
            ...state.serverContext.scoutAuth0,
            issuer: "https://evil.example/",
          },
        },
      },
      {
        ...state,
        serverContext: {
          scoutAuth0: { ...state.serverContext.scoutAuth0, clientId: "wrong" },
        },
      },
      {
        ...state,
        serverContext: {
          scoutAuth0: {
            ...state.serverContext.scoutAuth0,
            redirectURI: "https://evil.example/oauth2/callback",
          },
        },
      },
      { ...state, expiresAt: now },
      { ...state, codeVerifier: undefined },
      { ...state, codeVerifier: "short" },
      { ...state, idTokenNonce: undefined },
      { ...state, link: { userId: "native-user", email: claims.email } },
    ])
      expect(admittedScoutAuth0Claims(token(), config, value, now)).toBeNull();
  });

  test("does not treat client additionalData as protected flow provenance", () => {
    const { serverContext: _protected, ...untrusted } = state;
    expect(
      admittedScoutAuth0Claims(
        token(),
        config,
        {
          ...untrusted,
          scoutAuth0: state.serverContext.scoutAuth0,
        } as unknown as typeof state,
        now,
      ),
    ).toBeNull();
  });

  test("provider keeps closed signup and native code/PKCE/nonce with no provider logout assumption", () => {
    const { provider } = createScoutAuth0Adapter(config, async () => null);
    expect(provider).toMatchObject({
      providerId: "auth0",
      accountIssuer: config.issuer,
      discoveryUrl: `${config.issuer}.well-known/openid-configuration`,
      redirectURI: config.redirectURI,
      pkce: true,
      requireIdTokenVerification: true,
      requireEmailVerification: true,
      overrideUserInfo: true,
      disableSignUp: true,
      disableImplicitSignUp: true,
      responseType: "code",
      responseMode: "query",
      allowIdpInitiated: false,
      disableIdTokenNonceBinding: false,
      disableProviderLogout: true,
    });
    expect(provider.getToken).toBeUndefined();
    expect(provider.mapProfileToUser).toBeUndefined();
  });
});
