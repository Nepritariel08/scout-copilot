import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { createAuditStore, recordAuditEvent } from "../../audit";
import { createCredentialStore, encryptSecret } from "../../credentials";
import type { Database } from "../../db/client";
import { credentials } from "../../db/schema/core";
import {
  scoutContextReleaseGrants,
  scoutOdooRecordAccessGrants,
} from "../../db/schema/scout-record-context";
import {
  ODOO_JSON2_CREDENTIAL_PROVIDER,
  odooJson2CredentialKeyId,
} from "./odoo-credentials";
import type {
  ProjectTaskContextPrincipal,
  ProjectTaskContextProvider,
} from "./record-context";

const dataClass = "odoo.project_task_summary.v1" as const;
const recordGrantLifetimeMs = 12 * 60 * 60 * 1000;
const releaseGrantLifetimeMs = 12 * 60 * 60 * 1000;

export type OdooGrantBinding = {
  sourceUid: number;
  companyIds: number[];
  bindingExpiresAt: string;
};

function validPrincipal(value: ProjectTaskContextPrincipal) {
  if (
    !value.userId ||
    value.userId.length > 200 ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(value.tenantId) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(value.deploymentId) ||
    !/^[a-f0-9]{64}$/.test(value.bindingFingerprint)
  )
    throw new TypeError("Odoo grant principal is invalid");
}

function expiry(bindingExpiry: string, maxLifetime: number) {
  const bound = Date.parse(bindingExpiry);
  if (!Number.isFinite(bound) || bound <= Date.now())
    throw new TypeError("Odoo binding has expired");
  return new Date(Math.min(bound, Date.now() + maxLifetime));
}

function lockKey(
  principal: ProjectTaskContextPrincipal,
  sourceInstanceId: string,
) {
  return JSON.stringify([
    principal.deploymentId,
    principal.tenantId,
    principal.userId,
    principal.bindingFingerprint,
    sourceInstanceId,
  ]);
}

/**
 * Issues and retires one user's source and provider grants. All authority rows,
 * local vault changes, and audit receipts share the same transaction.
 */
export function createOwnedOdooGrantService(
  database: Database,
  encryptionKey: string,
  sourceInstanceId: string,
) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sourceInstanceId))
    throw new TypeError("Odoo source instance is not configured");
  const vault = createCredentialStore(database);

  async function lock(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    principal: ProjectTaskContextPrincipal,
  ) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${lockKey(principal, sourceInstanceId)}))`,
    );
  }

  async function recordLatest(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    principal: ProjectTaskContextPrincipal,
  ) {
    const [row] = await tx
      .select()
      .from(scoutOdooRecordAccessGrants)
      .where(
        and(
          eq(scoutOdooRecordAccessGrants.deploymentId, principal.deploymentId),
          eq(scoutOdooRecordAccessGrants.tenantId, principal.tenantId),
          eq(scoutOdooRecordAccessGrants.nativeUserId, principal.userId),
          eq(
            scoutOdooRecordAccessGrants.bindingFingerprint,
            principal.bindingFingerprint,
          ),
          eq(scoutOdooRecordAccessGrants.sourceInstanceId, sourceInstanceId),
        ),
      )
      .orderBy(desc(scoutOdooRecordAccessGrants.revision))
      .limit(1);
    return row;
  }

  return {
    async status(
      principal: ProjectTaskContextPrincipal,
      provider: "openrouter" | "local",
      modelPolicyFingerprint: string,
    ) {
      validPrincipal(principal);
      if (
        !["openrouter", "local"].includes(provider) ||
        !/^[a-f0-9]{64}$/.test(modelPolicyFingerprint)
      )
        throw new TypeError("Odoo grant status scope is invalid");
      const [record] = await database
        .select()
        .from(scoutOdooRecordAccessGrants)
        .where(
          and(
            eq(
              scoutOdooRecordAccessGrants.deploymentId,
              principal.deploymentId,
            ),
            eq(scoutOdooRecordAccessGrants.tenantId, principal.tenantId),
            eq(scoutOdooRecordAccessGrants.nativeUserId, principal.userId),
            eq(
              scoutOdooRecordAccessGrants.bindingFingerprint,
              principal.bindingFingerprint,
            ),
            eq(scoutOdooRecordAccessGrants.sourceInstanceId, sourceInstanceId),
          ),
        )
        .orderBy(desc(scoutOdooRecordAccessGrants.revision))
        .limit(1);
      const [release] = await database
        .select()
        .from(scoutContextReleaseGrants)
        .where(
          and(
            eq(scoutContextReleaseGrants.deploymentId, principal.deploymentId),
            eq(scoutContextReleaseGrants.tenantId, principal.tenantId),
            eq(scoutContextReleaseGrants.nativeUserId, principal.userId),
            eq(
              scoutContextReleaseGrants.bindingFingerprint,
              principal.bindingFingerprint,
            ),
            eq(scoutContextReleaseGrants.sourceInstanceId, sourceInstanceId),
            eq(scoutContextReleaseGrants.dataClass, dataClass),
            eq(scoutContextReleaseGrants.provider, provider),
            eq(
              scoutContextReleaseGrants.modelPolicyFingerprint,
              modelPolicyFingerprint,
            ),
          ),
        )
        .orderBy(desc(scoutContextReleaseGrants.revision))
        .limit(1);
      const [credential] = record
        ? await database
            .select({ id: credentials.id, metadata: credentials.metadata })
            .from(credentials)
            .where(
              and(
                eq(credentials.id, record.credentialRef),
                eq(credentials.kind, "connector"),
                eq(credentials.provider, ODOO_JSON2_CREDENTIAL_PROVIDER),
                eq(
                  credentials.keyId,
                  odooJson2CredentialKeyId(
                    sourceInstanceId,
                    record.sourceUid,
                    principal,
                  ),
                ),
                isNull(credentials.revokedAt),
              ),
            )
            .limit(1)
        : [];
      const credentialLive = Boolean(
        credential &&
          credential.metadata?.ownerNativeUserId === principal.userId &&
          credential.metadata.ownerTenantId === principal.tenantId &&
          credential.metadata.ownerDeploymentId === principal.deploymentId &&
          credential.metadata.ownerBindingFingerprint ===
            principal.bindingFingerprint &&
          (await vault.isLive(credential.id)),
      );
      const now = Date.now();
      return {
        provider,
        record: record
          ? {
              active:
                record.active &&
                credentialLive &&
                record.expiresAt.getTime() > now &&
                record.qualificationExpiresAt.getTime() > now,
              credentialStored: Boolean(credential),
              revision: record.revision,
              expiresAt: record.expiresAt.toISOString(),
              projectCount: record.allowedProjectIds.length,
            }
          : null,
        release: release
          ? {
              active: release.active && release.expiresAt.getTime() > now,
              revision: release.revision,
              expiresAt: release.expiresAt.toISOString(),
              provider: release.provider,
            }
          : null,
      };
    },

    async issueRecord(input: {
      principal: ProjectTaskContextPrincipal;
      binding: OdooGrantBinding;
      apiKey: string;
      allowedProjectIds: number[];
    }) {
      validPrincipal(input.principal);
      if (
        !Number.isSafeInteger(input.binding.sourceUid) ||
        input.binding.sourceUid <= 1 ||
        !Array.isArray(input.binding.companyIds) ||
        input.binding.companyIds.length < 1 ||
        input.binding.companyIds.length > 100 ||
        input.binding.companyIds.some(
          (id) => !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647,
        ) ||
        new Set(input.binding.companyIds).size !==
          input.binding.companyIds.length ||
        !Array.isArray(input.allowedProjectIds) ||
        input.allowedProjectIds.length < 1 ||
        input.allowedProjectIds.length > 100 ||
        input.allowedProjectIds.some(
          (id) => !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647,
        ) ||
        new Set(input.allowedProjectIds).size !==
          input.allowedProjectIds.length ||
        typeof input.apiKey !== "string" ||
        !input.apiKey ||
        input.apiKey.length > 4096 ||
        /\s/.test(input.apiKey)
      )
        throw new TypeError("Odoo grant input is invalid");

      const keyId = odooJson2CredentialKeyId(
        sourceInstanceId,
        input.binding.sourceUid,
        input.principal,
      );
      const encryptedValue = await encryptSecret(encryptionKey, input.apiKey);
      const expiresAt = expiry(
        input.binding.bindingExpiresAt,
        recordGrantLifetimeMs,
      );
      const qualificationExpiresAt = new Date(
        Math.min(expiresAt.getTime(), Date.now() + 15 * 60 * 1000),
      );

      return database.transaction(async (tx) => {
        await lock(tx, input.principal);
        const previous = await recordLatest(tx, input.principal);
        const credentialKey = {
          kind: "connector" as const,
          provider: ODOO_JSON2_CREDENTIAL_PROVIDER,
          keyId,
        };
        const previousCredential = await vault.findLiveByKey(credentialKey, tx);
        const metadata = {
          sourceInstanceId,
          uid: input.binding.sourceUid,
          ownerNativeUserId: input.principal.userId,
          ownerTenantId: input.principal.tenantId,
          ownerDeploymentId: input.principal.deploymentId,
          ownerBindingFingerprint: input.principal.bindingFingerprint,
        };
        if (previousCredential) {
          const [stored] = await tx
            .select({ metadata: credentials.metadata })
            .from(credentials)
            .where(eq(credentials.id, previousCredential.id))
            .limit(1);
          if (
            !stored?.metadata ||
            stored.metadata.ownerNativeUserId !== input.principal.userId ||
            stored.metadata.ownerTenantId !== input.principal.tenantId ||
            stored.metadata.ownerDeploymentId !==
              input.principal.deploymentId ||
            stored.metadata.ownerBindingFingerprint !==
              input.principal.bindingFingerprint
          )
            throw new Error("Odoo credential owner cannot be verified");
        }
        const credential = previousCredential
          ? await vault.rotate(
              {
                ...credentialKey,
                metadata,
                encryptedValue,
                previousCredentialId: previousCredential.id,
              },
              tx,
            )
          : await vault.create(
              { ...credentialKey, metadata, encryptedValue },
              tx,
            );
        const revision = (previous?.revision ?? 0) + 1;
        const [grant] = await tx
          .insert(scoutOdooRecordAccessGrants)
          .values({
            deploymentId: input.principal.deploymentId,
            tenantId: input.principal.tenantId,
            nativeUserId: input.principal.userId,
            bindingFingerprint: input.principal.bindingFingerprint,
            revision,
            active: true,
            sourceInstanceId,
            sourceUid: input.binding.sourceUid,
            qualification: "verified_nonadmin",
            qualificationExpiresAt,
            companyIds: [...input.binding.companyIds].sort((a, b) => a - b),
            allowedProjectIds: [...input.allowedProjectIds].sort(
              (a, b) => a - b,
            ),
            credentialRef: credential.id,
            expiresAt,
          })
          .returning({ id: scoutOdooRecordAccessGrants.id });
        if (!grant) throw new Error("Odoo record grant could not be stored");
        await recordAuditEvent(
          createAuditStore(tx as unknown as Database, { emitTaps: false }),
          {
            eventType: "scout.odoo_context_grant.issued",
            targetType: "scout_odoo_record_access_grant",
            targetId: grant?.id,
            actorUserId: input.principal.userId,
            payload: {
              sourceInstanceId,
              revision,
              companyCount: input.binding.companyIds.length,
              projectCount: input.allowedProjectIds.length,
              expiresAt: expiresAt.toISOString(),
            },
          },
        );
        return {
          revision,
          expiresAt: expiresAt.toISOString(),
          projectCount: input.allowedProjectIds.length,
        };
      });
    },

    async consentRelease(input: {
      principal: ProjectTaskContextPrincipal;
      bindingExpiresAt: string;
      modelPolicyExpiresAt: string;
      provider: ProjectTaskContextProvider;
      modelPolicyFingerprint: string;
    }) {
      validPrincipal(input.principal);
      if (
        !/^[a-f0-9]{64}$/.test(input.modelPolicyFingerprint) ||
        !["openrouter", "local"].includes(input.provider)
      )
        throw new TypeError("Odoo release grant input is invalid");
      const modelPolicyExpiry = Date.parse(input.modelPolicyExpiresAt);
      if (
        !Number.isFinite(modelPolicyExpiry) ||
        modelPolicyExpiry <= Date.now()
      )
        throw new TypeError("Model policy has expired");
      const expiresAt = expiry(
        new Date(
          Math.min(Date.parse(input.bindingExpiresAt), modelPolicyExpiry),
        ).toISOString(),
        releaseGrantLifetimeMs,
      );
      return database.transaction(async (tx) => {
        await lock(tx, input.principal);
        const [latest] = await tx
          .select()
          .from(scoutContextReleaseGrants)
          .where(
            and(
              eq(
                scoutContextReleaseGrants.deploymentId,
                input.principal.deploymentId,
              ),
              eq(scoutContextReleaseGrants.tenantId, input.principal.tenantId),
              eq(
                scoutContextReleaseGrants.nativeUserId,
                input.principal.userId,
              ),
              eq(
                scoutContextReleaseGrants.bindingFingerprint,
                input.principal.bindingFingerprint,
              ),
              eq(scoutContextReleaseGrants.sourceInstanceId, sourceInstanceId),
              eq(scoutContextReleaseGrants.dataClass, dataClass),
              eq(scoutContextReleaseGrants.provider, input.provider),
              eq(
                scoutContextReleaseGrants.modelPolicyFingerprint,
                input.modelPolicyFingerprint,
              ),
            ),
          )
          .orderBy(desc(scoutContextReleaseGrants.revision))
          .limit(1);
        const revision = (latest?.revision ?? 0) + 1;
        const [grant] = await tx
          .insert(scoutContextReleaseGrants)
          .values({
            deploymentId: input.principal.deploymentId,
            tenantId: input.principal.tenantId,
            nativeUserId: input.principal.userId,
            bindingFingerprint: input.principal.bindingFingerprint,
            sourceInstanceId,
            dataClass,
            provider: input.provider,
            modelPolicyFingerprint: input.modelPolicyFingerprint,
            revision,
            active: true,
            expiresAt,
          })
          .returning({ id: scoutContextReleaseGrants.id });
        if (!grant) throw new Error("Odoo release grant could not be stored");
        await recordAuditEvent(
          createAuditStore(tx as unknown as Database, { emitTaps: false }),
          {
            eventType: "scout.odoo_context_release.consent_recorded",
            targetType: "scout_context_release_grant",
            targetId: grant?.id,
            actorUserId: input.principal.userId,
            payload: {
              sourceInstanceId,
              dataClass,
              provider: input.provider,
              modelPolicyFingerprint: input.modelPolicyFingerprint,
              revision,
              expiresAt: expiresAt.toISOString(),
            },
          },
        );
        return {
          revision,
          expiresAt: expiresAt.toISOString(),
          provider: input.provider,
        };
      });
    },

    async revokeRelease(input: {
      principal: ProjectTaskContextPrincipal;
      provider: "openrouter" | "local";
      modelPolicyFingerprint: string;
    }) {
      validPrincipal(input.principal);
      if (
        !["openrouter", "local"].includes(input.provider) ||
        !/^[a-f0-9]{64}$/.test(input.modelPolicyFingerprint)
      )
        throw new TypeError("Odoo release revoke scope is invalid");
      return database.transaction(async (tx) => {
        await lock(tx, input.principal);
        const [latest] = await tx
          .select()
          .from(scoutContextReleaseGrants)
          .where(
            and(
              eq(
                scoutContextReleaseGrants.deploymentId,
                input.principal.deploymentId,
              ),
              eq(scoutContextReleaseGrants.tenantId, input.principal.tenantId),
              eq(
                scoutContextReleaseGrants.nativeUserId,
                input.principal.userId,
              ),
              eq(
                scoutContextReleaseGrants.bindingFingerprint,
                input.principal.bindingFingerprint,
              ),
              eq(scoutContextReleaseGrants.sourceInstanceId, sourceInstanceId),
              eq(scoutContextReleaseGrants.dataClass, dataClass),
              eq(scoutContextReleaseGrants.provider, input.provider),
              eq(
                scoutContextReleaseGrants.modelPolicyFingerprint,
                input.modelPolicyFingerprint,
              ),
            ),
          )
          .orderBy(desc(scoutContextReleaseGrants.revision))
          .limit(1);
        if (!latest?.active) return { revoked: false };
        const now = new Date();
        await tx.insert(scoutContextReleaseGrants).values({
          deploymentId: latest.deploymentId,
          tenantId: latest.tenantId,
          nativeUserId: latest.nativeUserId,
          bindingFingerprint: latest.bindingFingerprint,
          sourceInstanceId: latest.sourceInstanceId,
          dataClass: latest.dataClass,
          provider: latest.provider,
          modelPolicyFingerprint: latest.modelPolicyFingerprint,
          revision: latest.revision + 1,
          active: false,
          expiresAt: now,
        });
        await recordAuditEvent(
          createAuditStore(tx as unknown as Database, { emitTaps: false }),
          {
            eventType: "scout.odoo_context_release.revoked",
            targetType: "scout_context_release_grant",
            actorUserId: input.principal.userId,
            payload: {
              sourceInstanceId,
              dataClass,
              provider: input.provider,
              modelPolicyFingerprint: input.modelPolicyFingerprint,
              revision: latest.revision + 1,
            },
          },
        );
        return { revoked: true, revision: latest.revision + 1 };
      });
    },

    async revokeAll(principal: ProjectTaskContextPrincipal) {
      validPrincipal(principal);
      return database.transaction(async (tx) => {
        await lock(tx, principal);
        const now = new Date();
        const records = await tx
          .select()
          .from(scoutOdooRecordAccessGrants)
          .where(
            and(
              eq(
                scoutOdooRecordAccessGrants.deploymentId,
                principal.deploymentId,
              ),
              eq(scoutOdooRecordAccessGrants.tenantId, principal.tenantId),
              eq(scoutOdooRecordAccessGrants.nativeUserId, principal.userId),
              eq(
                scoutOdooRecordAccessGrants.bindingFingerprint,
                principal.bindingFingerprint,
              ),
              eq(
                scoutOdooRecordAccessGrants.sourceInstanceId,
                sourceInstanceId,
              ),
            ),
          )
          .orderBy(desc(scoutOdooRecordAccessGrants.revision));
        const seenRecords = new Set<string>();
        let recordGrantCount = 0;
        let localCredentialRevoked = false;
        const revokedCredentialRefs = new Set<string>();
        for (const row of records) {
          const group = JSON.stringify([row.tenantId, row.bindingFingerprint]);
          if (seenRecords.has(group)) continue;
          seenRecords.add(group);
          if (!row.active) continue;
          await tx.insert(scoutOdooRecordAccessGrants).values({
            deploymentId: row.deploymentId,
            tenantId: row.tenantId,
            nativeUserId: row.nativeUserId,
            bindingFingerprint: row.bindingFingerprint,
            revision: row.revision + 1,
            active: false,
            sourceInstanceId: row.sourceInstanceId,
            sourceUid: row.sourceUid,
            qualification: row.qualification,
            qualificationExpiresAt: now,
            companyIds: row.companyIds,
            allowedProjectIds: row.allowedProjectIds,
            credentialRef: row.credentialRef,
            expiresAt: now,
          });
          recordGrantCount++;
          if (revokedCredentialRefs.has(row.credentialRef)) continue;
          revokedCredentialRefs.add(row.credentialRef);
          const [liveCredential] = await tx
            .select({ id: credentials.id })
            .from(credentials)
            .where(
              and(
                eq(credentials.id, row.credentialRef),
                eq(credentials.kind, "connector"),
                eq(credentials.provider, ODOO_JSON2_CREDENTIAL_PROVIDER),
                eq(
                  credentials.keyId,
                  odooJson2CredentialKeyId(
                    sourceInstanceId,
                    row.sourceUid,
                    principal,
                  ),
                ),
              ),
            )
            .limit(1);
          if (liveCredential && (await vault.isLive(liveCredential.id, tx))) {
            await vault.revoke(liveCredential.id, tx);
            localCredentialRevoked = true;
          }
        }

        const releases = await tx
          .select()
          .from(scoutContextReleaseGrants)
          .where(
            and(
              eq(
                scoutContextReleaseGrants.deploymentId,
                principal.deploymentId,
              ),
              eq(scoutContextReleaseGrants.tenantId, principal.tenantId),
              eq(scoutContextReleaseGrants.nativeUserId, principal.userId),
              eq(
                scoutContextReleaseGrants.bindingFingerprint,
                principal.bindingFingerprint,
              ),
              eq(scoutContextReleaseGrants.sourceInstanceId, sourceInstanceId),
              eq(scoutContextReleaseGrants.dataClass, dataClass),
            ),
          )
          .orderBy(desc(scoutContextReleaseGrants.revision));
        const seen = new Set<string>();
        let releasesRevoked = 0;
        for (const row of releases) {
          const group = JSON.stringify([
            row.tenantId,
            row.bindingFingerprint,
            row.provider,
            row.modelPolicyFingerprint,
          ]);
          if (seen.has(group)) continue;
          seen.add(group);
          if (!row.active) continue;
          await tx.insert(scoutContextReleaseGrants).values({
            deploymentId: row.deploymentId,
            tenantId: row.tenantId,
            nativeUserId: row.nativeUserId,
            bindingFingerprint: row.bindingFingerprint,
            sourceInstanceId: row.sourceInstanceId,
            dataClass: row.dataClass,
            provider: row.provider,
            modelPolicyFingerprint: row.modelPolicyFingerprint,
            revision: row.revision + 1,
            active: false,
            expiresAt: now,
          });
          releasesRevoked++;
        }

        if (recordGrantCount > 0 || releasesRevoked > 0) {
          await recordAuditEvent(
            createAuditStore(tx as unknown as Database, { emitTaps: false }),
            {
              eventType: "scout.odoo_context_grant.revoked",
              targetType: "scout_odoo_context_authority",
              actorUserId: principal.userId,
              payload: {
                sourceInstanceId,
                recordGrantsRevoked: recordGrantCount,
                releaseGrantsRevoked: releasesRevoked,
              },
            },
          );
        }
        return {
          recordGrantRevoked: recordGrantCount > 0,
          recordGrantsRevoked: recordGrantCount,
          releaseGrantsRevoked: releasesRevoked,
          localCredentialRevoked,
          odooKeyRevokedUpstream: false,
        };
      });
    },
  };
}
