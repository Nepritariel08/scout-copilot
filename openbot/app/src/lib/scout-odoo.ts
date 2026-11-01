import { queryOptions } from "@tanstack/react-query";
import { client } from "./client";

/** Public consent precondition. It contains no provider endpoint or credential. */
export type OwnedOdooModelRoute = {
  provider: "openrouter" | "local";
  model: string;
  policyFingerprint: string;
  expiresAt: string;
};

export type OwnedOdooContextStatus = {
  provider: "openrouter" | "local";
  route: OwnedOdooModelRoute;
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

export const scoutOdooKeys = (userId: string, agentId: string) =>
  ["scout-odoo-context", userId, agentId] as const;

export function scoutOdooStatus(userId: string, agentId: string) {
  return queryOptions({
    queryKey: scoutOdooKeys(userId, agentId),
    enabled: Boolean(userId && agentId),
    retry: false,
    queryFn: async () => {
      const response = await client(
        `/api/scout/odoo/context-grants?agentId=${encodeURIComponent(agentId)}`,
        { fallback: "Couldn't load Odoo access status." },
      );
      return (await response.json()) as OwnedOdooContextStatus;
    },
  });
}

/** The key travels only in this authenticated request body; it is never query or mutation data. */
export async function submitOdooApiKey(apiKey: string) {
  const response = await client("/api/scout/odoo/context-grants", {
    method: "POST",
    body: { apiKey },
    fallback: "Couldn't save your Odoo access key.",
  });
  return response.json() as Promise<{
    revision: number;
    projectCount: number;
    expiresAt: string;
  }>;
}

export async function consentOdooContextRelease(
  agentId: string,
  route: OwnedOdooModelRoute,
) {
  if (!(Date.parse(route.expiresAt) > Date.now()))
    throw new Error("The model route expired. Refresh and review it again.");
  const response = await client("/api/scout/odoo/context-grants/release", {
    method: "POST",
    body: {
      agentId,
      consent: true,
      expectedProvider: route.provider,
      expectedModel: route.model,
      expectedPolicyFingerprint: route.policyFingerprint,
    },
    fallback:
      "Couldn't save model-sharing consent. Refresh Odoo access and review the current model route.",
  });
  return response.json();
}

export async function revokeOdooContextRelease(agentId: string) {
  const response = await client("/api/scout/odoo/context-grants/release", {
    method: "DELETE",
    body: { agentId },
    fallback: "Couldn't withdraw model-sharing consent.",
  });
  return response.json();
}

export async function revokeOdooContext() {
  const response = await client("/api/scout/odoo/context-grants", {
    method: "DELETE",
    fallback: "Couldn't revoke Scout's Odoo access.",
  });
  return response.json();
}

type ContextHost = {
  addContext(input: {
    description: string;
    value: string;
    agentIds?: string[];
  }): string;
  removeContext(id: string): void;
};

/** Adds one validated selector for one run, then always removes it. */
export async function withOdooTaskSelection<T>(
  host: ContextHost,
  agentId: string | undefined,
  taskId: string | null,
  run: () => Promise<T>,
): Promise<T> {
  if (taskId === null) return run();
  if (!/^[1-9][0-9]{0,14}$/.test(taskId))
    throw new Error("Choose a valid Odoo task ID.");
  const id = host.addContext({
    description: "scout.project_task_id",
    value: taskId,
    ...(agentId ? { agentIds: [agentId] } : {}),
  });
  try {
    return await run();
  } finally {
    host.removeContext(id);
  }
}
