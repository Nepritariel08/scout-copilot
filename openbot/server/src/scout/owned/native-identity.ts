import { createAuditStore } from "../../audit";
import { createAuth } from "../../auth";
import { type AuthService, createRoleRepository } from "../../auth/guards";
import { createOrganizationAuth } from "../../auth/organization";
import { organizationUserStore } from "../../auth/organization-store";
import type { OwnedDeploymentConfig } from "../../config";
import type { Database } from "../../db/client";
import { createPeopleStore } from "../../people/store";
import { createOwnedIdentity } from "./auth";
import type { TenantScope } from "./scope";

/** SCIM is not an admitted owned capability; its native hooks also require interactive transactions. */
export function assertOwnedNativeIdentityConfiguration() {
  // This is the same trusted environment source scimOptions() reads. Do not
  // accept a request/config override that can hide the token from this check.
  if (process.env.SCIM_BEARER_TOKEN?.trim())
    throw new Error(
      "Owned Scout does not support SCIM; unset SCIM_BEARER_TOKEN.",
    );
}

/**
 * Every database dependency of fresh native authentication belongs to the identity
 * pool. Consent transactions hold data connections while calling this boundary;
 * putting even a role, revocation or auth-audit callback back on that pool can
 * exhaust it and prevent the transaction from ever completing.
 */
export function createOwnedNativeIdentity(
  config: OwnedDeploymentConfig,
  identityDatabase: Database,
  scope: TenantScope,
  /** Explicit synthetic issuer seam; production uses the existing native auth implementation. */
  authOverride?: AuthService,
) {
  assertOwnedNativeIdentityConfiguration();
  const people = createPeopleStore(
    identityDatabase,
    config.auth?.initialAdminEmails ?? [],
  );
  const audit = createAuditStore(identityDatabase);
  const nativeAuth =
    authOverride ??
    (config.organizationAuthUrl
      ? createOrganizationAuth({
          authorityUrl: config.organizationAuthUrl,
          materializeUser: async (user) => {
            if (await people.isRevoked(user.email))
              throw new Error("SCOUT_ACCESS_DENIED");
            return organizationUserStore(identityDatabase, {
              requireSubjectMatch: true,
            })(user);
          },
        })
      : createAuth(
          config,
          identityDatabase,
          (email) => people.isRevoked(email),
          audit,
        ));
  return createOwnedIdentity({
    auth: nativeAuth,
    roles: createRoleRepository(identityDatabase),
    scope,
    platformOwnerIds: config.scoutPlatformOwnerIds,
  });
}
