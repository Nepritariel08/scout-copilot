import {
  APIError,
  addOAuthServerContext,
  createAuthMiddleware,
  getOAuthState,
} from "better-auth/api";
import { auth0 } from "better-auth/plugins";
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { and, eq } from "drizzle-orm";
import type { ScoutAuth0Config } from "../config";
import type { Database } from "../db/client";
import { accounts, users } from "../db/schema";

type NativeAccount = { userId: string; email: string };
export type ScoutAuth0AccountReader = (key: {
  issuer: string;
  subject: string;
}) => Promise<NativeAccount | null>;

/** Legacy nullable issuers, other providers and email-only matches confer no Auth0 identity. */
export function createScoutAuth0AccountReader(
  database: Database,
): ScoutAuth0AccountReader {
  return async ({ issuer, subject }) => {
    const matched = await database
      .select({ userId: accounts.userId, email: users.email })
      .from(accounts)
      .innerJoin(users, eq(users.id, accounts.userId))
      .where(
        and(
          eq(accounts.providerId, "auth0"),
          eq(accounts.issuer, issuer),
          eq(accounts.accountId, subject),
        ),
      )
      .limit(2);
    return matched.length === 1 ? matched[0] : null;
  };
}

type CallbackState = {
  codeVerifier?: unknown;
  idTokenNonce?: unknown;
  expiresAt?: unknown;
  link?: unknown;
  serverContext?: Record<string, unknown>;
};
type Auth0Claims = {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  email: string;
  email_verified: true;
  nonce: string;
  name?: string;
  picture?: string;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Claim admission AFTER genericOAuth verifies the signed ID token against its discovery JWKS
 * and native state-derived nonce. Decoding here is never a signature-verification substitute.
 * Only the native parsed state and protected serverContext may be passed as `state`.
 */
export function admittedScoutAuth0Claims(
  token: string | undefined,
  config: ScoutAuth0Config,
  state: CallbackState | null,
  now = Date.now(),
): Auth0Claims | null {
  const marker = state?.serverContext?.scoutAuth0;
  if (
    !object(marker) ||
    marker.issuer !== config.issuer ||
    marker.clientId !== config.clientId ||
    marker.redirectURI !== config.redirectURI ||
    state?.link ||
    typeof state?.expiresAt !== "number" ||
    state.expiresAt <= now ||
    typeof state.codeVerifier !== "string" ||
    state.codeVerifier.length < 43 ||
    typeof state.idTokenNonce !== "string" ||
    state.idTokenNonce.length < 32 ||
    !token
  )
    return null;
  try {
    const pieces = token.split(".");
    if (
      pieces.length !== 3 ||
      pieces.some((piece) => !/^[A-Za-z0-9_-]+$/.test(piece))
    )
      return null;
    const header: unknown = JSON.parse(
      Buffer.from(pieces[0], "base64url").toString("utf8"),
    );
    const claims: unknown = JSON.parse(
      Buffer.from(pieces[1], "base64url").toString("utf8"),
    );
    if (
      !object(header) ||
      !["RS256", "PS256"].includes(String(header.alg)) ||
      !object(claims) ||
      claims.iss !== config.issuer ||
      claims.aud !== config.clientId ||
      (claims.azp !== undefined && claims.azp !== config.clientId) ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 255 ||
      Array.from(claims.sub).some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      ) ||
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      claims.exp * 1000 <= now ||
      typeof claims.email !== "string" ||
      !claims.email ||
      claims.email !== claims.email.trim() ||
      !/^[^\s@]+@[^\s@]+$/.test(claims.email) ||
      claims.email_verified !== true ||
      claims.nonce !== state.idTokenNonce
    )
      return null;
    return claims as Auth0Claims;
  } catch {
    return null;
  }
}

function denied(): never {
  throw new APIError("FORBIDDEN", {
    code: "SCOUT_AUTH0_IDENTITY_REFUSED",
    message: "This Auth0 identity has no current provisioned Scout account.",
  });
}

/** Closed native Auth0 adapter. No user provisioning, remote identity headers or token proxy. */
export function createScoutAuth0Adapter(
  config: ScoutAuth0Config,
  readAccount: ScoutAuth0AccountReader,
) {
  // This request-local native state is keyed weakly: no credential/profile cache survives its flow.
  const verified = new WeakMap<
    object,
    { subject: string; userId: string; email: string }
  >();
  const before = createAuthMiddleware(async (context) => {
    if (
      context.path !== "/sign-in/social" ||
      context.body?.provider !== "auth0"
    )
      return;
    // The pilot qualifies only browser authorization-code login, never client-posted ID tokens.
    if (context.body.idToken !== undefined) denied();
    await addOAuthServerContext({
      scoutAuth0: {
        issuer: config.issuer,
        clientId: config.clientId,
        redirectURI: config.redirectURI,
      },
    });
  });

  const provider: GenericOAuthConfig<"auth0"> = {
    ...auth0({
      domain: new URL(config.issuer).host,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectURI: config.redirectURI,
      pkce: true,
      disableSignUp: true,
      disableImplicitSignUp: true,
      // Preserve local logout until the existing Auth0 application's logout URL is qualified.
      disableProviderLogout: true,
    }),
    discoveryUrl: `${config.issuer}.well-known/openid-configuration`,
    accountIssuer: config.issuer,
    requireIdTokenVerification: true,
    requireEmailVerification: true,
    // BetterAuth 1.7.1 must refresh its in-memory user before its verified-email gate.
    overrideUserInfo: true,
    responseType: "code",
    responseMode: "query",
    allowIdpInitiated: false,
    disableIdTokenNonceBinding: false,
    async getUserInfo(tokens) {
      const state = await getOAuthState();
      const claims = admittedScoutAuth0Claims(tokens.idToken, config, state);
      if (!claims || !state) return null;
      const account = await readAccount({
        issuer: config.issuer,
        subject: claims.sub,
      });
      if (
        !account ||
        account.email.toLowerCase() !== claims.email.toLowerCase()
      )
        return null;
      verified.set(state, {
        subject: claims.sub,
        userId: account.userId,
        email: account.email,
      });
      return {
        id: claims.sub,
        sub: claims.sub,
        email: claims.email,
        emailVerified: true,
        name: typeof claims.name === "string" ? claims.name : "",
        image: typeof claims.picture === "string" ? claims.picture : undefined,
      };
    },
  };

  async function assertSessionUser(userId: string) {
    const state = await getOAuthState();
    if (!state?.serverContext?.scoutAuth0) return;
    const binding = verified.get(state);
    if (!binding || binding.userId !== userId) denied();
    const current = await readAccount({
      issuer: config.issuer,
      subject: binding.subject,
    });
    if (
      !current ||
      current.userId !== userId ||
      current.email !== binding.email
    )
      denied();
  }

  return {
    provider,
    before,
    assertSessionUser,
    async validateUserInfo(user: { id?: unknown }, profile: unknown) {
      if (
        !object(profile) ||
        typeof profile.sub !== "string" ||
        typeof user.id !== "string"
      )
        denied();
      const state = await getOAuthState();
      const binding = state ? verified.get(state) : undefined;
      if (!binding || binding.subject !== profile.sub) denied();
      await assertSessionUser(user.id);
    },
  };
}
