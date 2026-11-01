import { ModelPolicyError } from "./policy";
import type { ProjectTaskReadRequest } from "./record-context";

const taskFields = ["id", "name", "stage_id", "date_deadline"] as const;
const maximumContextBytes = 1024;
const maximumRequestBytes = 4096;
const defaultTimeoutMs = 5000;

export type OdooUserApiKey = {
  uid: number;
  apiKey: string;
};

/** Must return the protected API key explicitly mapped to this qualified Odoo UID. */
export type OdooUserApiKeyResolver = {
  resolveForUid(uid: number): Promise<OdooUserApiKey | null>;
};

export type OdooJson2ProjectTaskReaderOptions = {
  /** Trusted server configuration. It cannot be selected by a requester or model. */
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

function projectIds(request: ProjectTaskReadRequest): number[] {
  if (!request || typeof request !== "object") return denied();
  const source = request.sourceIdentity;
  if (
    !source ||
    typeof source !== "object" ||
    !Array.isArray(source.companyIds) ||
    !Number.isSafeInteger(source.uid) ||
    source.uid < 1 ||
    source.uid === 1 ||
    source.role !== "user" ||
    source.qualification !== "qualified" ||
    source.companyIds.length < 1 ||
    source.companyIds.length > 100 ||
    source.companyIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
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
    projectScope[2].some((id) => !Number.isSafeInteger(id) || id < 1) ||
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
  const origin = configuredOrigin(options.baseUrl);
  const database = configuredDatabase(options.database);
  const timeoutMs = validTimeout(options.timeoutMs ?? defaultTimeoutMs);
  const transport = options.fetch ?? fetch;

  const post = async (
    model: "res.users" | "project.task",
    method: "context_get" | "search_read",
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

  return {
    async readProjectTask(request: ProjectTaskReadRequest): Promise<unknown> {
      const allowedProjectIds = projectIds(request);
      let apiKey: string;
      try {
        apiKey = credentialKey(
          await options.credentials.resolveForUid(request.sourceIdentity.uid),
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
