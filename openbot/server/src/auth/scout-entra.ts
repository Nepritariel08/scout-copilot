import {
  APIError,
  addOAuthServerContext,
  createAuthMiddleware,
  getOAuthState,
} from "better-auth/api";
import { microsoftEntraId } from "better-auth/plugins/generic-oauth";
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { and, eq } from "drizzle-orm";
import type { ScoutEntraConfig } from "../config";
import type { Database } from "../db/client";
import { accounts, users } from "../db/schema";

type NativeAccount = {
  userId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

export type ScoutEntraAccountReader = (
  key: {
    issuer: string;
  } & ({ subject: string } | { userId: string }),
) => Promise<NativeAccount | null>;

/** A native Entra account exists only after an operator binds the exact tenant-scoped object. */
export function createScoutEntraAccountReader(
  database: Database,
): ScoutEntraAccountReader {
  return async (key) => {
    const issuer = key.issuer;
    const subjectCondition =
      "subject" in key
        ? eq(accounts.accountId, key.subject)
        : eq(accounts.userId, key.userId);
    const matched = await database
      .select({
        userId: accounts.userId,
        email: users.email,
        emailVerified: users.emailVerified,
        name: users.name,
      })
      .from(accounts)
      .innerJoin(users, eq(users.id, accounts.userId))
      .where(
        and(
          eq(accounts.providerId, "microsoft"),
          eq(accounts.issuer, issuer),
          subjectCondition,
        ),
      )
      .limit(2);
    return matched.length === 1 ? matched[0] : null;
  };
}

type OAuthState = {
  codeVerifier?: unknown;
  idTokenNonce?: unknown;
  expiresAt?: unknown;
  link?: unknown;
  serverContext?: Record<string, unknown>;
};

export type ScoutEntraClaims = {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  nbf?: number;
  tid: string;
  oid: string;
  nonce: string;
  name?: string;
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function scoutEntraIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId.toLowerCase()}/v2.0`;
}

/** Verified object ID. The exact resource-tenant issuer is stored alongside this account key. */
export function scoutEntraAccountKey(profile: Record<string, unknown>): string {
  const tid = typeof profile.tid === "string" ? profile.tid.toLowerCase() : "";
  const oid = typeof profile.oid === "string" ? profile.oid.toLowerCase() : "";
  return GUID.test(tid) && GUID.test(oid) ? oid : "";
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Additional admission after generic OAuth has verified the ID token's signature, issuer,
 * audience and native nonce against Entra's discovered JWKS. Decoding here is never a substitute
 * for Better Auth's verification; it enforces this deployment's exact tenant and account binding.
 */
export function admittedScoutEntraClaims(
  token: string | undefined,
  config: ScoutEntraConfig,
  state: OAuthState | null,
  now = Date.now(),
): ScoutEntraClaims | null {
  const marker = state?.serverContext?.scoutEntra;
  if (
    !object(marker) ||
    marker.tenantId !== config.tenantId.toLowerCase() ||
    marker.clientId !== config.clientId ||
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
      claims.iss !== scoutEntraIssuer(config.tenantId) ||
      claims.aud !== config.clientId ||
      (claims.azp !== undefined && claims.azp !== config.clientId) ||
      claims.ver !== "2.0" ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 255 ||
      Array.from(claims.sub).some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      ) ||
      typeof claims.tid !== "string" ||
      !GUID.test(claims.tid) ||
      claims.tid.toLowerCase() !== config.tenantId.toLowerCase() ||
      typeof claims.oid !== "string" ||
      !GUID.test(claims.oid) ||
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      claims.exp * 1000 <= now ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== "number" ||
          !Number.isFinite(claims.nbf) ||
          claims.nbf * 1000 > now)) ||
      claims.nonce !== state.idTokenNonce
    )
      return null;
    return claims as ScoutEntraClaims;
  } catch {
    return null;
  }
}

function denied(): never {
  throw new APIError("FORBIDDEN", {
    code: "SCOUT_ENTRA_IDENTITY_REFUSED",
    message: "This Entra identity has no current provisioned Scout account.",
  });
}

/** Closed native Entra adapter. No email-based enrollment, account linking or client token login. */
export function createScoutEntraAdapter(
  config: ScoutEntraConfig,
  readAccount: ScoutEntraAccountReader,
) {
  const tenantId = config.tenantId.toLowerCase();
  const issuer = scoutEntraIssuer(tenantId);
  const verified = new WeakMap<
    object,
    { subject: string; userId: string; email: string }
  >();
  const before = createAuthMiddleware(async (context) => {
    if (
      context.path !== "/sign-in/social" ||
      context.body?.provider !== "microsoft"
    )
      return;
    if (context.body.idToken !== undefined || context.body.link === true)
      denied();
    await addOAuthServerContext({
      scoutEntra: { tenantId, clientId: config.clientId },
    });
  });

  const provider: GenericOAuthConfig<"microsoft"> = {
    ...microsoftEntraId({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tenantId,
      pkce: true,
      disableSignUp: true,
      disableImplicitSignUp: true,
      // Keep logout local until an exact post-logout registration is qualified.
      disableProviderLogout: true,
    }),
    // Retain the existing UI's `microsoft` provider id and callback route.
    providerId: "microsoft",
    accountIssuer: issuer,
    accountSubject: ({ profile }) => scoutEntraAccountKey(profile),
    requireIdTokenVerification: true,
    // The local preprovisioned account is authoritative; Entra email is mutable and may be absent.
    overrideUserInfo: true,
    responseType: "code",
    responseMode: "query",
    allowIdpInitiated: false,
    disableIdTokenNonceBinding: false,
    async getUserInfo(tokens) {
      const state = await getOAuthState();
      const claims = admittedScoutEntraClaims(tokens.idToken, config, state);
      if (!claims || !state) return null;
      const subject = scoutEntraAccountKey(claims);
      const account = await readAccount({ issuer, subject });
      if (!account) return null;
      verified.set(state, {
        subject,
        userId: account.userId,
        email: account.email,
      });
      return {
        id: claims.oid,
        sub: claims.sub,
        tid: claims.tid,
        oid: claims.oid,
        email: account.email,
        emailVerified: account.emailVerified,
        name:
          typeof claims.name === "string" ? claims.name : (account.name ?? ""),
      };
    },
  };

  async function assertSessionUser(userId: string) {
    const state = await getOAuthState();
    if (!state?.serverContext?.scoutEntra) return;
    const binding = verified.get(state);
    if (!binding || binding.userId !== userId) denied();
    const current = await readAccount({ issuer, subject: binding.subject });
    if (
      !current ||
      current.userId !== userId ||
      current.email !== binding.email
    )
      denied();
  }

  const after = createAuthMiddleware(async (context) => {
    if (context.path !== "/get-session") return;
    const result: unknown = context.context.returned;
    if (result === null || result === undefined) return;
    if (
      !object(result) ||
      !object(result.user) ||
      typeof result.user.id !== "string"
    ) {
      context.context.returned = null;
      return;
    }
    // Recheck the native issuer/OID mapping even when Better Auth served its session from
    // cookie cache. Removing an identity binding must stop an already-issued session too.
    const current = await readAccount({ issuer, userId: result.user.id });
    if (!current || current.userId !== result.user.id)
      context.context.returned = null;
  });

  return {
    provider,
    before,
    after,
    assertSessionUser,
    async validateUserInfo(user: { id?: unknown }, profile: unknown) {
      if (
        !object(profile) ||
        typeof profile.tid !== "string" ||
        typeof profile.oid !== "string" ||
        typeof profile.sub !== "string" ||
        typeof user.id !== "string"
      )
        denied();
      const state = await getOAuthState();
      const binding = state ? verified.get(state) : undefined;
      const subject = scoutEntraAccountKey(profile);
      if (!binding || binding.subject !== subject) denied();
      await assertSessionUser(user.id);
    },
  };
}
