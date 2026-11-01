import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { decryptSecret } from "../../credentials";
import type { Database } from "../../db/client";
import { credentials } from "../../db/schema/core";
import type { OdooUserApiKeyResolver } from "./odoo-json2";
import type { ProjectTaskContextPrincipal } from "./record-context";

export const ODOO_JSON2_CREDENTIAL_PROVIDER = "odoo-json2";

/** A stable, opaque vault key ID scoped to the exact native principal and Odoo identity. */
export function odooJson2CredentialKeyId(
  instanceId: string,
  uid: number,
  principal: ProjectTaskContextPrincipal,
) {
  if (
    !/^[A-Za-z0-9_-]{1,100}$/.test(instanceId) ||
    !Number.isSafeInteger(uid) ||
    uid <= 1 ||
    !principal.userId ||
    principal.userId.length > 200 ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(principal.tenantId) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(principal.deploymentId) ||
    !/^[a-f0-9]{64}$/.test(principal.bindingFingerprint)
  )
    throw new TypeError("Odoo credential scope is invalid");
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        principal.deploymentId,
        principal.tenantId,
        principal.userId,
        principal.bindingFingerprint,
      ]),
    )
    .digest("hex");
  return `${instanceId}:uid:${uid}:principal:${scope}`;
}

/**
 * Resolve one opaque grant reference through OpenBot's encrypted credential vault.
 * A revoked, mis-scoped or mismapped reference returns no key; there is no UID-only fallback.
 */
export function createOdooJson2CredentialResolver(
  database: Database,
  encryptionKey: string,
  instanceId: string,
): OdooUserApiKeyResolver {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(instanceId))
    throw new TypeError("Odoo source instance is not configured");

  return {
    async resolveForUid(uid, credentialRef, principal) {
      if (
        !Number.isSafeInteger(uid) ||
        uid <= 1 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          credentialRef,
        )
      )
        return null;

      let encryptedValue: string | undefined;
      let metadata: Record<string, unknown> | undefined;
      try {
        const [row] = await database
          .select({
            encryptedValue: credentials.encryptedValue,
            metadata: credentials.metadata,
          })
          .from(credentials)
          .where(
            and(
              eq(credentials.id, credentialRef),
              eq(credentials.kind, "connector"),
              eq(credentials.provider, ODOO_JSON2_CREDENTIAL_PROVIDER),
              eq(
                credentials.keyId,
                odooJson2CredentialKeyId(instanceId, uid, principal),
              ),
              isNull(credentials.revokedAt),
            ),
          );
        encryptedValue = row?.encryptedValue;
        metadata = row?.metadata;
      } catch {
        return null;
      }
      if (
        !encryptedValue ||
        metadata?.sourceInstanceId !== instanceId ||
        metadata.uid !== uid ||
        metadata.ownerNativeUserId !== principal.userId ||
        metadata.ownerTenantId !== principal.tenantId ||
        metadata.ownerDeploymentId !== principal.deploymentId ||
        metadata.ownerBindingFingerprint !== principal.bindingFingerprint
      )
        return null;

      try {
        return {
          uid,
          apiKey: await decryptSecret(encryptionKey, encryptedValue),
        };
      } catch {
        return null;
      }
    },
  };
}
