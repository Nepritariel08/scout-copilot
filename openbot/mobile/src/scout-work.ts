/** Mobile ports for the existing authenticated Scout web contracts. No credential enrollment. */
export type AuthenticatedApi = <T>(
  path: string,
  input?: { method?: string; body?: unknown },
) => Promise<T>;

export type WorkScope = { userId: string; channelId: string; agentId: string };
export type OdooTaskSelection = WorkScope & { taskId: string };

/** Late reads must not replace another identity/channel's view or clear its loading/error state. */
export async function refreshForCurrentScope<T>(input: {
  isCurrent(): boolean;
  read(): Promise<T>;
  apply(value: T): void;
  failed(error: unknown): void;
  finished(): void;
}): Promise<T | undefined> {
  if (!input.isCurrent()) return undefined;
  try {
    const value = await input.read();
    if (!input.isCurrent()) return undefined;
    input.apply(value);
    return value;
  } catch (error) {
    if (input.isCurrent()) input.failed(error);
    return undefined;
  } finally {
    if (input.isCurrent()) input.finished();
  }
}

export function sameWorkScope(left: WorkScope, right: WorkScope): boolean {
  return (
    left.userId === right.userId &&
    left.channelId === right.channelId &&
    left.agentId === right.agentId
  );
}

export function validOdooTaskId(value: string): boolean {
  return /^[1-9][0-9]{0,14}$/.test(value);
}

export function selectedOdooTask(
  selection: OdooTaskSelection | undefined,
  scope: WorkScope,
): string | null {
  return selection &&
    sameWorkScope(selection, scope) &&
    validOdooTaskId(selection.taskId)
    ? selection.taskId
    : null;
}

/** A ref-shaped port lets the composer consume the selection synchronously, once. */
export function consumeOdooTaskSelection(
  pending: { current: OdooTaskSelection | undefined },
  scope: WorkScope,
): string | null {
  const taskId = selectedOdooTask(pending.current, scope);
  pending.current = undefined;
  return taskId;
}

export type OdooContextStatus = {
  provider: "openrouter" | "local";
  route: {
    provider: "openrouter" | "local";
    model: string;
    policyFingerprint: string;
    expiresAt: string;
  };
  record: {
    active: boolean;
    credentialStored: boolean;
    revision: number;
    expiresAt: string;
    projectCount: number;
  } | null;
  release: {
    active: boolean;
    revision: number;
    expiresAt: string;
    provider: "openrouter" | "local";
  } | null;
};

export function canSelectOdooTask(
  status: OdooContextStatus | undefined,
  now = Date.now(),
): boolean {
  return Boolean(
    status?.record?.active &&
      status.route?.provider === status.provider &&
      Date.parse(status.route.expiresAt) > now &&
      Date.parse(status.record.expiresAt) > now &&
      status.release?.active &&
      status.release.provider === status.provider &&
      Date.parse(status.release.expiresAt) > now,
  );
}

export async function readOdooContext(
  client: AuthenticatedApi,
  agentId: string,
) {
  const status = await client<OdooContextStatus>(
    `/api/scout/odoo/context-grants?agentId=${encodeURIComponent(agentId)}`,
  );
  if (
    !status.route?.model ||
    status.route.provider !== status.provider ||
    !/^[a-f0-9]{64}$/.test(status.route.policyFingerprint) ||
    !Number.isFinite(Date.parse(status.route.expiresAt))
  )
    throw new Error(
      "Scout did not return a reviewable model route. Refresh or update the server before sharing task summaries.",
    );
  return status;
}

/** This only records/withdraws explicit provider release consent, never an Odoo API key. */
export function changeOdooRelease(
  client: AuthenticatedApi,
  agentId: string,
  allow: boolean,
  route?: OdooContextStatus["route"],
) {
  if (
    allow &&
    (!route?.model ||
      !/^[a-f0-9]{64}$/.test(route.policyFingerprint) ||
      !(Date.parse(route.expiresAt) > Date.now()))
  )
    throw new Error(
      "Refresh Odoo access and review the current model route before allowing task summaries.",
    );
  return client<unknown>("/api/scout/odoo/context-grants/release", {
    method: allow ? "POST" : "DELETE",
    body: {
      agentId,
      ...(allow && route
        ? {
            consent: true,
            expectedProvider: route.provider,
            expectedModel: route.model,
            expectedPolicyFingerprint: route.policyFingerprint,
          }
        : {}),
    },
  });
}

export function webContextSetupUrl(
  serverUrl: string,
  channelId: string,
): string {
  const origin = new URL(serverUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password)
    throw new Error("Open Odoo setup on the approved HTTPS Scout server.");
  return new URL(
    `/channel/${encodeURIComponent(channelId)}`,
    origin.origin,
  ).toString();
}

/** Public receipt projection; matches shared/scout.ts without importing server dependencies. */
export type DraftReceipt = {
  id: string;
  channelId: string;
  sourceId: string;
  title: string;
  state:
    | "submission_unknown"
    | "queued"
    | "running"
    | "review_required"
    | "completed"
    | "cancelled"
    | "failed";
  workItemId: number | null;
  revision: number | null;
  result: string | null;
  draftDigest: string | null;
  accepted: boolean;
  errorCode: string | null;
  updatedAt: string;
};

export async function readDrafts(client: AuthenticatedApi, channelId: string) {
  const capabilities = await client<{ delegatedDrafts?: boolean }>(
    "/api/capabilities",
  );
  if (capabilities.delegatedDrafts !== true)
    return { available: false, tasks: [] as DraftReceipt[] };
  const page = await client<{ tasks: DraftReceipt[] }>(
    `/api/scout/tasks?channelId=${encodeURIComponent(channelId)}`,
  );
  if (!Array.isArray(page.tasks))
    throw new Error("Scout returned unreadable draft receipts.");
  return {
    available: true,
    tasks: page.tasks.filter((task) => task.channelId === channelId),
  };
}

export function canAcceptDraft(task: DraftReceipt): boolean {
  return (
    task.state === "review_required" &&
    !task.accepted &&
    typeof task.result === "string" &&
    task.result.length > 0 &&
    Number.isSafeInteger(task.revision) &&
    Number(task.revision) > 0 &&
    typeof task.draftDigest === "string" &&
    /^[a-f0-9]{64}$/.test(task.draftDigest)
  );
}

export function sameReviewedDraft(
  current: DraftReceipt,
  reviewed: DraftReceipt,
): boolean {
  return (
    canAcceptDraft(current) &&
    canAcceptDraft(reviewed) &&
    current.id === reviewed.id &&
    current.channelId === reviewed.channelId &&
    current.revision === reviewed.revision &&
    current.draftDigest === reviewed.draftDigest &&
    current.result === reviewed.result
  );
}

async function draftAction(
  client: AuthenticatedApi,
  channelId: string,
  task: DraftReceipt,
  body: {
    action: "refresh" | "accept";
    revision?: number | null;
    draftDigest?: string | null;
  },
) {
  if (task.channelId !== channelId || !task.id)
    throw new Error("This draft belongs to a different conversation.");
  const response = await client<{ task: DraftReceipt }>(
    `/api/scout/tasks/${encodeURIComponent(task.id)}`,
    { method: "POST", body },
  );
  if (response.task.id !== task.id || response.task.channelId !== channelId)
    throw new Error("Scout returned a different draft receipt.");
  return response.task;
}

export function refreshDraft(
  client: AuthenticatedApi,
  channelId: string,
  task: DraftReceipt,
) {
  return draftAction(client, channelId, task, { action: "refresh" });
}

/** Accept only the exact version explicitly reviewed. Never retry against a newer receipt. */
export function acceptReviewedDraft(
  client: AuthenticatedApi,
  channelId: string,
  current: DraftReceipt,
  reviewed: DraftReceipt,
) {
  if (!sameReviewedDraft(current, reviewed))
    throw new Error("The draft changed. Refresh and review it again.");
  return draftAction(client, channelId, reviewed, {
    action: "accept",
    revision: reviewed.revision,
    draftDigest: reviewed.draftDigest,
  }).then((receipt) => {
    if (
      receipt.state !== "completed" ||
      !receipt.accepted ||
      receipt.draftDigest !== reviewed.draftDigest ||
      receipt.result !== reviewed.result
    )
      throw new Error(
        "Draft acceptance was not confirmed. Refresh and review its receipt.",
      );
    return receipt;
  });
}
