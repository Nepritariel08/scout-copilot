import { describe, expect, test } from "bun:test";
import { constants, generateKeyPairSync, sign } from "node:crypto";
import {
  admittedScoutEntraClaims,
  createScoutEntraAdapter,
  scoutEntraAccountKey,
  scoutEntraIssuer,
} from "../src/auth/scout-entra";
import type { ScoutEntraConfig } from "../src/config";

const config: ScoutEntraConfig = {
  tenantId: "8f2c1e40-0000-0000-0000-000000000000",
  clientId: "6d6707a2-0000-0000-0000-000000000000",
  clientSecret: "synthetic-client-secret",
};
const now = 1_800_000_000_000;
const state = {
  codeVerifier: "synthetic-native-pkce-verifier-".repeat(4),
  idTokenNonce: "synthetic-server-generated-native-nonce",
  expiresAt: now + 600_000,
  serverContext: {
    scoutEntra: {
      tenantId: config.tenantId,
      clientId: config.clientId,
    },
  },
};
const claims = {
  iss: scoutEntraIssuer(config.tenantId),
  aud: config.clientId,
  sub: "synthetic-pairwise-subject",
  exp: now / 1000 + 300,
  ver: "2.0",
  tid: config.tenantId,
  oid: "4e70e6f1-0000-0000-0000-000000000000",
  nonce: state.idTokenNonce,
  name: "Synthetic Entra Person",
};
// Signed only with this process's synthetic key. The production callback relies on Better Auth's
// configured Entra JWKS verification before the adapter applies these additional claim checks.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
function token(values: Record<string, unknown> = claims, algorithm = "RS256") {
  const body = [{ alg: algorithm, typ: "JWT" }, values].map((value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url"),
  );
  const input = body.join(".");
  return `${input}.${sign(
    algorithm === "PS256" ? "sha256" : "sha256",
    Buffer.from(input),
    {
      key: privateKey,
      padding:
        algorithm === "PS256"
          ? constants.RSA_PKCS1_PSS_PADDING
          : constants.RSA_PKCS1_PADDING,
      ...(algorithm === "PS256" ? { saltLength: 32 } : {}),
    },
  ).toString("base64url")}`;
}

describe("owned Entra identity binding", () => {
  test("uses a tenant-scoped immutable object key, never email or UPN", () => {
    expect(scoutEntraAccountKey(claims)).toBe(claims.oid);
    expect(
      scoutEntraAccountKey({
        tid: config.tenantId,
        email: "person@example.test",
      }),
    ).toBe("");
    expect(scoutEntraAccountKey({ tid: "common", oid: claims.oid })).toBe("");
  });

  test("accepts the exact signed-resource-tenant claim shape after native verification", () => {
    expect(admittedScoutEntraClaims(token(), config, state, now)).toMatchObject(
      { tid: config.tenantId, oid: claims.oid, sub: claims.sub },
    );
  });

  test.each([
    ["issuer", { iss: "https://login.microsoftonline.com/common/v2.0" }],
    ["audience", { aud: "another-client" }],
    ["authorized party", { azp: "another-client" }],
    ["tenant", { tid: "00000000-0000-0000-0000-000000000000" }],
    ["tenant format", { tid: "common" }],
    ["object id format", { oid: "email@example.test" }],
    ["version", { ver: "1.0" }],
    ["nonce", { nonce: "client-controlled-nonce" }],
    ["expiry", { exp: now / 1000 - 1 }],
    ["not-before", { nbf: now / 1000 + 60 }],
  ])("rejects a mismatched %s claim", (_label, changed) => {
    expect(
      admittedScoutEntraClaims(
        token({ ...claims, ...changed }),
        config,
        state,
        now,
      ),
    ).toBeNull();
  });

  test("rejects expired, linked, or misbound native OAuth state", () => {
    expect(
      admittedScoutEntraClaims(
        token(),
        config,
        { ...state, expiresAt: now },
        now,
      ),
    ).toBeNull();
    expect(
      admittedScoutEntraClaims(token(), config, { ...state, link: true }, now),
    ).toBeNull();
    expect(
      admittedScoutEntraClaims(
        token(),
        config,
        {
          ...state,
          serverContext: {
            scoutEntra: { tenantId: config.tenantId, clientId: "other-client" },
          },
        },
        now,
      ),
    ).toBeNull();
    expect(admittedScoutEntraClaims(undefined, config, state, now)).toBeNull();
  });

  test("registers one closed generic OAuth provider under the existing Microsoft UI id", () => {
    const adapter = createScoutEntraAdapter(config, async () => null);
    expect(adapter.provider).toMatchObject({
      providerId: "microsoft",
      accountIssuer: scoutEntraIssuer(config.tenantId),
      requireIdTokenVerification: true,
      disableSignUp: true,
      disableImplicitSignUp: true,
      responseType: "code",
      responseMode: "query",
      allowIdpInitiated: false,
      disableIdTokenNonceBinding: false,
    });
    expect(adapter.provider.accountSubject).toBeTypeOf("function");
  });
});
