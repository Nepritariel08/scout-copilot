import { and, eq, isNull } from "drizzle-orm";
import { decryptSecret } from "../../credentials";
import type { Database } from "../../db/client";
import { credentials } from "../../db/schema/core";
import type { OdooUserApiKeyResolver } from "./odoo-json2";

export const ODOO_JSON2_CREDENTIAL_PROVIDER = "odoo-json2";

/** A stable vault key ID scoped to one Odoo database and one nonadmin Odoo user. */
export function odooJson2CredentialKeyId(instanceId: string, uid: number) {
  if (
    !/^[A-Za-z0-9_-]{1,100}$/.test(instanceId) ||
    !Number.isSafeInteger(uid) ||
    uid <= 1
  )
    throw new TypeError("Odoo credential scope is invalid");
  return `${instanceId}:uid:${uid}`;
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
    async resolveForUid(uid, credentialRef) {
      if (
        !Number.isSafeInteger(uid) ||
        uid <= 1 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          credentialRef,
        )
      )
        return null;

      let encryptedValue: string | undefined;
      try {
        const [row] = await database
          .select({ encryptedValue: credentials.encryptedValue })
          .from(credentials)
          .where(
            and(
              eq(credentials.id, credentialRef),
              eq(credentials.kind, "connector"),
              eq(credentials.provider, ODOO_JSON2_CREDENTIAL_PROVIDER),
              eq(credentials.keyId, odooJson2CredentialKeyId(instanceId, uid)),
              isNull(credentials.revokedAt),
            ),
          );
        encryptedValue = row?.encryptedValue;
      } catch {
        return null;
      }
      if (!encryptedValue) return null;

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
