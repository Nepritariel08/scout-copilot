import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  scoutContextReleaseGrants,
  scoutOdooRecordAccessGrants,
} from "../../db/schema/scout-record-context";
import type {
  ProjectTaskContextPort,
  ProjectTaskContextPrincipal,
  ProjectTaskContextProvider,
} from "./record-context";

type ProjectTaskReader = Pick<ProjectTaskContextPort, "readProjectTask">;

function iso(value: Date) {
  return value.toISOString();
}

/**
 * Read the latest exact-principal grant revisions and delegate the fixed source read.
 * This adapter never issues grants and never accepts Odoo connection details from a row.
 */
export function createProjectTaskContextStore(
  database: Database,
  sourceInstanceId: string,
  reader: ProjectTaskReader,
): ProjectTaskContextPort {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sourceInstanceId))
    throw new TypeError("Odoo source instance is not configured");

  return {
    sourceInstanceId,
    async getGrant(principal: ProjectTaskContextPrincipal) {
      const [row] = await database
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
      if (!row) return null;

      return {
        principal: {
          userId: row.nativeUserId,
          tenantId: row.tenantId,
          deploymentId: row.deploymentId,
          bindingFingerprint: row.bindingFingerprint,
        },
        active: row.active,
        revision: row.revision,
        expiresAt: iso(row.expiresAt),
        sourceIdentity: {
          instanceId: row.sourceInstanceId,
          uid: row.sourceUid,
          role: "user",
          qualification:
            row.qualification === "verified_nonadmin" ? "qualified" : "pending",
          qualificationExpiresAt: iso(row.qualificationExpiresAt),
          companyIds: row.companyIds,
          credentialRef: row.credentialRef,
        },
        allowedProjectIds: row.allowedProjectIds,
      };
    },
    async getReleaseGrant(
      principal: ProjectTaskContextPrincipal,
      provider: ProjectTaskContextProvider,
      modelPolicyFingerprint: string,
    ) {
      const [row] = await database
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
            eq(
              scoutContextReleaseGrants.dataClass,
              "odoo.project_task_summary.v1",
            ),
            eq(scoutContextReleaseGrants.provider, provider),
            eq(
              scoutContextReleaseGrants.modelPolicyFingerprint,
              modelPolicyFingerprint,
            ),
          ),
        )
        .orderBy(desc(scoutContextReleaseGrants.revision))
        .limit(1);
      if (!row) return null;

      return {
        principal: {
          userId: row.nativeUserId,
          tenantId: row.tenantId,
          deploymentId: row.deploymentId,
          bindingFingerprint: row.bindingFingerprint,
        },
        active: row.active,
        revision: row.revision,
        expiresAt: iso(row.expiresAt),
        sourceInstanceId: row.sourceInstanceId,
        dataClass: row.dataClass,
        provider: row.provider,
        modelPolicyFingerprint: row.modelPolicyFingerprint,
      };
    },
    readProjectTask: (request) => reader.readProjectTask(request),
  };
}
