import { ModelPolicyError } from "./policy";
import type { ProjectTaskReadRequest } from "./record-context";

const taskFields = [
  "id",
  "name",
  "stage_id",
  "date_deadline",
  "company_id",
] as const;
const maximumContextBytes = 1024;
const maximumRequestBytes = 4096;
const maximumProjectScopeBytes = 65_536;
const maximumProjectScopeRows = 100;
const defaultTimeoutMs = 5000;

export type OdooUserApiKey = {
  uid: number;
  apiKey: string;
};

/** Must return the protected API key explicitly mapped to this qualified Odoo UID. */
export type OdooUserApiKeyResolver = {
  resolveForUid(
    uid: number,
    credentialRef: string,
  ): Promise<OdooUserApiKey | null>;
};

export type OdooJson2ProjectTaskReaderOptions = {
  /** Trusted server configuration. It cannot be selected by a requester or model. */
  instanceId: string;
  baseUrl: string;
  database: string;
  credentials: OdooUserApiKeyResolver;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function denied(): never {
  throw new ModelPolicyError("MODEL_ACCESS_DENIED");
}

function unavailable(): never {
  throw new ModelPolicyError("MODEL_UNAVAILABLE");
}

function configuredOrigin(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return denied();
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    return denied();
  return new URL(url.origin);
}

function configuredDatabase(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(value)
  )
    return denied();
  return value;
}

function configuredInstanceId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    return denied();
  return value;
}

function validTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 500 || value > 15_000)
    return denied();
  return value;
}

function hasCredentialWhitespaceOrControl(value: string): boolean {
  return (
    /\s/.test(value) ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

function projectIds(
  request: ProjectTaskReadRequest,
  expectedInstanceId: string,
): number[] {
  if (!request || typeof request !== "object") return denied();
  const source = request.sourceIdentity;
  if (
    !source ||
    typeof source !== "object" ||
    source.instanceId !== expectedInstanceId ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(source.instanceId) ||
    !Array.isArray(source.companyIds) ||
    !Number.isSafeInteger(source.uid) ||
    source.uid < 1 ||
    source.uid === 1 ||
    source.role !== "user" ||
    source.qualification !== "qualified" ||
    !Number.isFinite(Date.parse(source.qualificationExpiresAt)) ||
    Date.parse(source.qualificationExpiresAt) <= Date.now() ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      source.credentialRef,
    ) ||
    source.companyIds.length < 1 ||
    source.companyIds.length > 100 ||
    source.companyIds.some(
      (id) => !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647,
    ) ||
    new Set(source.companyIds).size !== source.companyIds.length ||
    request.model !== "project.task" ||
    request.limit !== 1 ||
    request.maxBytes !== maximumRequestBytes ||
    !Array.isArray(request.fields) ||
    request.fields.length !== taskFields.length ||
    request.fields.some((field, index) => field !== taskFields[index]) ||
    !Array.isArray(request.domain) ||
    request.domain.length !== 2
  )
    return denied();

  const [selected, projectScope] = request.domain;
  if (
    !Array.isArray(selected) ||
    selected.length !== 3 ||
    selected[0] !== "id" ||
    selected[1] !== "=" ||
    !Number.isSafeInteger(selected[2]) ||
    selected[2] < 1 ||
    !Array.isArray(projectScope) ||
    projectScope.length !== 3 ||
    projectScope[0] !== "project_id" ||
    projectScope[1] !== "in" ||
    !Array.isArray(projectScope[2]) ||
    projectScope[2].length < 1 ||
    projectScope[2].length > 100 ||
    projectScope[2].some(
      (id) => !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647,
    ) ||
    new Set(projectScope[2]).size !== projectScope[2].length
  )
    return denied();
  return [...projectScope[2]];
}

function credentialKey(value: OdooUserApiKey | null, uid: number): string {
  if (
    !value ||
    value.uid !== uid ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 1 ||
    value.uid === 1 ||
    typeof value.apiKey !== "string" ||
    value.apiKey.length < 1 ||
    value.apiKey.length > 4096 ||
    hasCredentialWhitespaceOrControl(value.apiKey)
  )
    return denied();
  return value.apiKey;
}

async function boundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const discardBody = async () => {
    await response.body?.cancel().catch(() => {});
  };
  if (!response.ok) {
    await discardBody();
    return unavailable();
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    await discardBody();
    return unavailable();
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes) {
      await discardBody();
      return unavailable();
    }
  }
  if (!response.body) return unavailable();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return unavailable();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return unavailable();
  }
}

/**
 * Creates the fixed, read-only JSON-2 task reader. Every call first asks Odoo for
 * the identity derived from the API key, then performs the exact search_read as
 * that same user with the grant's allowed-company context so Odoo ACLs, record
 * rules and field permissions remain active. UID 1 is denied as a defense in
 * depth; grant provisioning must still qualify all users as nonadmin.
 */
export function createOdooJson2ProjectTaskReader(
  options: OdooJson2ProjectTaskReaderOptions,
) {
  const instanceId = configuredInstanceId(options.instanceId);
  const origin = configuredOrigin(options.baseUrl);
  const database = configuredDatabase(options.database);
  const timeoutMs = validTimeout(options.timeoutMs ?? defaultTimeoutMs);
  const transport = options.fetch ?? fetch;

  const post = async (
    model: "res.users" | "project.task" | "project.project",
    method: "context_get" | "has_group" | "search_read",
    apiKey: string,
    body: Record<string, unknown>,
    maxResponseBytes: number,
  ) => {
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized, "utf8") > maximumRequestBytes)
      return denied();
    let response: Response;
    try {
      response = await transport(
        new URL(`/json/2/${model}/${method}`, origin),
        {
          method: "POST",
          headers: {
            authorization: `bearer ${apiKey}`,
            "content-type": "application/json; charset=utf-8",
            "user-agent": "Scout-Owned-ReadOnly-Context/1.0",
            "x-odoo-database": database,
          },
          body: serialized,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch {
      return unavailable();
    }
    if (response.redirected) {
      await response.body?.cancel().catch(() => {});
      return unavailable();
    }
    return boundedJson(response, maxResponseBytes);
  };

  const assertCurrentUserIsNotAdministrator = async (
    apiKey: string,
    uid: number,
  ) => {
    // Unknown values, missing methods, and failed checks must never be treated
    // as evidence that an Odoo user is safe to release context for.
    for (const groupExtId of ["base.group_system", "base.group_erp_manager"]) {
      const isAdministrator = await post(
        "res.users",
        "has_group",
        apiKey,
        { ids: [uid], group_ext_id: groupExtId },
        maximumContextBytes,
      );
      if (isAdministrator !== false) return denied();
    }
  };

  /**
   * Qualify one server-bound native user's own Odoo key and snapshot the
   * projects that the same nonadmin user can currently read. The request can
   * provide neither the UID nor project/company scope. Project ACLs and record
   * rules on Odoo are the authority; over-cap or malformed results deny.
   */
  const verifyUserProjectScope = async (
    apiKey: string,
    expectedUid: number,
    companyIds: number[],
  ): Promise<number[]> => {
    const uid = configuredOdooUserUid(expectedUid);
    const companies = configuredCompanyIds(companyIds);
    const key = credentialKey({ uid, apiKey }, uid);
    const identity = await post(
      "res.users",
      "context_get",
      key,
      {},
      maximumContextBytes,
    );
    if (
      !identity ||
      typeof identity !== "object" ||
      Array.isArray(identity) ||
      (identity as Record<string, unknown>).uid !== uid
    )
      return denied();

    await assertCurrentUserIsNotAdministrator(key, uid);
    const rows = await post(
      "project.project",
      "search_read",
      key,
      {
        context: { allowed_company_ids: companies },
        domain: [["company_id", "in", companies]],
        fields: ["id", "company_id"],
        limit: maximumProjectScopeRows + 1,
      },
      maximumProjectScopeBytes,
    );
    await assertCurrentUserIsNotAdministrator(key, uid);
    if (
      !Array.isArray(rows) ||
      rows.length === 0 ||
      rows.length > maximumProjectScopeRows
    )
      return denied();

    const projects: number[] = [];
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
        !Array.isArray(project.company_id) ||
        project.company_id.length !== 2 ||
        !Number.isSafeInteger(project.company_id[0]) ||
        !companies.includes(Number(project.company_id[0])) ||
        typeof project.company_id[1] !== "string" ||
        project.company_id[1].length > 400
      )
        return denied();
      projects.push(Number(project.id));
    }
    if (new Set(projects).size !== projects.length) return denied();
    return projects.sort((left, right) => left - right);
  };

  return {
    verifyUserProjectScope,
    async readProjectTask(request: ProjectTaskReadRequest): Promise<unknown> {
      const allowedProjectIds = projectIds(request, instanceId);
      let apiKey: string;
      try {
        apiKey = credentialKey(
          await options.credentials.resolveForUid(
            request.sourceIdentity.uid,
            request.sourceIdentity.credentialRef,
          ),
          request.sourceIdentity.uid,
        );
      } catch (error) {
        if (error instanceof ModelPolicyError) throw error;
        return denied();
      }

      const identity = await post(
        "res.users",
        "context_get",
        apiKey,
        {},
        maximumContextBytes,
      );
      if (
        !identity ||
        typeof identity !== "object" ||
        Array.isArray(identity) ||
        (identity as Record<string, unknown>).uid !== request.sourceIdentity.uid
      )
        return denied();

      await assertCurrentUserIsNotAdministrator(
        apiKey,
        request.sourceIdentity.uid,
      );

      const [selected] = request.domain;
      const rows = await post(
        "project.task",
        "search_read",
        apiKey,
        {
          context: {
            allowed_company_ids: [...request.sourceIdentity.companyIds],
          },
          domain: [
            ["id", "=", selected[2]],
            ["project_id", "in", allowedProjectIds],
          ],
          fields: [...taskFields],
          limit: 1,
        },
        maximumRequestBytes + 1024,
      );
      // Check again after Odoo returns the task. This catches a privilege
      // promotion that overlaps the read instead of trusting the grant's
      // earlier nonadmin qualification until it expires.
      await assertCurrentUserIsNotAdministrator(
        apiKey,
        request.sourceIdentity.uid,
      );
      if (!Array.isArray(rows)) return rows;
      return rows.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return row;
        const normalized = { ...(row as Record<string, unknown>) };
        // Odoo represents empty scalar and many2one fields as false in JSON.
        if (normalized.stage_id === false) normalized.stage_id = null;
        if (normalized.date_deadline === false) normalized.date_deadline = null;
        return normalized;
      });
    },
  };
}

function configuredOdooUserUid(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 1) return denied();
  return value;
}

function configuredCompanyIds(value: number[]): number[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 100 ||
    value.some(
      (id) =>
        !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647,
    ) ||
    new Set(value).size !== value.length
  )
    return denied();
  return [...value].sort((left, right) => left - right);
}
