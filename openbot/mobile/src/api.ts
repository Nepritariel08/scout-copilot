import { authClient, serverUrl } from "./auth";
import {
  assertCurrentRequestScope,
  type RequestScope,
  scopedFetch,
} from "./request-scope";

export async function api<T>(
  path: string,
  input?: { method?: string; body?: unknown; signal?: AbortSignal },
  scope?: RequestScope,
): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("Use a Scout API path.");
  const fetcher = scope
    ? scopedFetch(() => authClient.getCookie(), scope, fetch)
    : fetch;
  const response = await fetcher(`${serverUrl}${path}`, {
    method: input?.method,
    credentials: "omit",
    headers: {
      ...(input?.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(input?.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    signal: input?.signal,
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json();
  if (scope) assertCurrentRequestScope(scope);
  if (!response.ok)
    throw new Error(
      body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
        ? body.error
        : body && typeof body === "object" && "code" in body
          ? String(body.code)
          : `Request failed (${response.status}).`,
    );
  return body as T;
}

export function scopedApi(scope: RequestScope) {
  return <T>(
    path: string,
    input?: { method?: string; body?: unknown; signal?: AbortSignal },
  ) => api<T>(path, input, scope);
}

export type ScoutAgent = {
  id: string;
  name: string;
  title?: string;
  builtIn: boolean;
};

export type Conversation = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
  lastMessageAt?: string | null;
};

export type ChatMessage = {
  id: string;
  role: string;
  content?: unknown;
  [key: string]: unknown;
};

export { serverUrl };
