import {
  configuredCompanyIds,
  configuredInstanceId,
  configuredOdooUserUid,
  createOdooJson2ReadTransport,
  credentialKey,
  type OdooJson2ProjectTaskReaderOptions,
  projectIds,
  taskFields,
} from "./odoo-json2";
import { ModelPolicyError } from "./policy";
import type { ProjectTaskReadRequest } from "./record-context";

function denied(): never {
  throw new ModelPolicyError("MODEL_ACCESS_DENIED");
}

/**
 * Invited portal collaborators only. Composition selects this adapter from a protected
 * native-to-Odoo mapping, never a client/model role, company, partner or project hint.
 * Business reads run as that portal user's bearer identity, without sudo or access
 * tokens. The separately installed attestation exposes only its own UID/fixed groups.
 */
export function createOdooJson2CustomerTaskReader(
  options: OdooJson2ProjectTaskReaderOptions,
) {
  const instanceId = configuredInstanceId(options.instanceId);
  const post = createOdooJson2ReadTransport(options);

  const assertCustomer = async (apiKey: string, uid: number) => {
    const identity = await post("res.users", "context_get", apiKey, {}, 1024);
    if (
      !identity ||
      typeof identity !== "object" ||
      Array.isArray(identity) ||
      (identity as Record<string, unknown>).uid !== uid
    )
      return denied();
    // Stock Odoo 20 has_group may hide all groups from portal users because
    // res.groups read access is internal-only. Never infer portal from all-false.
    const attestation = await post(
      "res.users",
      "scout_own_identity_v1",
      apiKey,
      {},
      2048,
    );
    if (
      !attestation ||
      typeof attestation !== "object" ||
      Array.isArray(attestation) ||
      Object.keys(attestation).sort().join(",") !== "contract,groups,uid"
    )
      return denied();
    const own = attestation as Record<string, unknown>;
    if (
      own.contract !== "scout-own-identity-v1" ||
      own.uid !== uid ||
      !own.groups ||
      typeof own.groups !== "object" ||
      Array.isArray(own.groups) ||
      Object.keys(own.groups).sort().join(",") !==
        "base.group_erp_manager,base.group_portal,base.group_system,base.group_user"
    )
      return denied();
    for (const [group, expected] of [
      ["base.group_portal", true],
      ["base.group_user", false],
      ["base.group_system", false],
      ["base.group_erp_manager", false],
    ] as const) {
      const actual = (own.groups as Record<string, unknown>)[group];
      if (actual !== expected) return denied();
    }
  };

  const visibleProjects = async (
    apiKey: string,
    uid: number,
    companyIds: number[],
  ) => {
    await assertCustomer(apiKey, uid);
    // Odoo's portal project rule requires the exact current user's collaboration.
    // Task follower access alone deliberately cannot create a Scout project grant.
    const rows = await post(
      "project.project",
      "search_read",
      apiKey,
      {
        context: { allowed_company_ids: companyIds },
        domain: [["company_id", "in", companyIds]],
        fields: ["id", "company_id"],
        limit: 101,
      },
      65_536,
    );
    await assertCustomer(apiKey, uid);
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 100)
      return denied();
    const ids: number[] = [];
    for (const row of rows) {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).sort().join(",") !== "company_id,id"
      )
        return denied();
      const project = row as Record<string, unknown>;
      if (
        !Number.isSafeInteger(project.id) ||
        Number(project.id) < 1 ||
        Number(project.id) > 2_147_483_647 ||
        !Array.isArray(project.company_id) ||
        project.company_id.length !== 2 ||
        !Number.isSafeInteger(project.company_id[0]) ||
        !companyIds.includes(project.company_id[0]) ||
        typeof project.company_id[1] !== "string" ||
        project.company_id[1].length > 400
      )
        return denied();
      ids.push(project.id as number);
    }
    if (new Set(ids).size !== ids.length) return denied();
    return ids.sort((a, b) => a - b);
  };

  return {
    async verifyUserProjectScope(
      apiKey: string,
      expectedUid: number,
      companyIds: number[],
    ) {
      const uid = configuredOdooUserUid(expectedUid);
      const companies = configuredCompanyIds(companyIds);
      return visibleProjects(
        credentialKey({ uid, apiKey }, uid),
        uid,
        companies,
      );
    },
    async readProjectTask(request: ProjectTaskReadRequest): Promise<unknown> {
      const grantedProjects = projectIds(request, instanceId);
      const uid = request.sourceIdentity.uid;
      let key: string;
      try {
        key = credentialKey(
          await options.credentials.resolveForUid(
            uid,
            request.sourceIdentity.credentialRef,
            request.principal,
          ),
          uid,
        );
      } catch {
        return denied();
      }
      const companies = [...request.sourceIdentity.companyIds];
      const before = await visibleProjects(key, uid, companies);
      const currentProjects = grantedProjects.filter((id) =>
        before.includes(id),
      );
      if (currentProjects.length === 0) return denied();
      const rows = await post(
        "project.task",
        "search_read",
        key,
        {
          context: { allowed_company_ids: companies },
          domain: [
            ["id", "=", request.domain[0][2]],
            ["project_id", "in", currentProjects],
          ],
          fields: [...taskFields],
          limit: 1,
        },
        5120,
      );
      // Recheck live collaboration AND classification after the task read. An old
      // follower relationship or a stored grant cannot survive project withdrawal.
      const after = await visibleProjects(key, uid, companies);
      if (currentProjects.some((id) => !after.includes(id))) return denied();
      if (!Array.isArray(rows)) return denied();
      return rows.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return row;
        const result = { ...(row as Record<string, unknown>) };
        if (result.stage_id === false) result.stage_id = null;
        if (result.date_deadline === false) result.date_deadline = null;
        return result;
      });
    },
  };
}
