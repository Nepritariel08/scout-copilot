import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { tryClient } from "@/lib/client";

const sampleUrl = "https://example.org/";
const unavailableCodes = new Set([
  "SCOUT_CAPABILITY_UNAVAILABLE",
  "OWNED_FEATURE_UNAVAILABLE",
]);
const alias = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/);
const fleetSchema = z.strictObject({
  isolation: z.literal("per-bot"),
  computers: z
    .array(
      z.strictObject({
        botId: alias,
        running: z.boolean(),
        startedAt: z.string().max(100).nullable(),
      }),
    )
    .max(32)
    .refine(
      (values) =>
        new Set(values.map((value) => value.botId)).size === values.length,
    ),
});
const readSchema = z.strictObject({
  kind: z.literal("scout.computer.public_read.v1"),
  computerId: alias,
  url: z.literal(sampleUrl),
  title: z.string().max(200),
  text: z.string().max(8192),
  truncated: z.boolean(),
  observedAt: z.iso.datetime(),
  untrusted: z.string().min(1).max(512),
  pageFrameId: z.uuid(),
});

function png(value: string) {
  if (value.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    return false;
  try {
    const header = atob(value.slice(0, 44));
    if (
      header.length < 24 ||
      header.slice(12, 16) !== "IHDR" ||
      Array.from(header.slice(0, 8), (character) =>
        character.charCodeAt(0),
      ).join(",") !== "137,80,78,71,13,10,26,10"
    )
      return false;
    const dimension = (offset: number) =>
      ((header.charCodeAt(offset) << 24) >>> 0) +
      (header.charCodeAt(offset + 1) << 16) +
      (header.charCodeAt(offset + 2) << 8) +
      header.charCodeAt(offset + 3);
    return [dimension(16), dimension(20)].every(
      (size) => size > 0 && size <= 8192,
    );
  } catch {
    return false;
  }
}
const frameSchema = z.strictObject({
  frame: z
    .strictObject({
      url: z.literal(sampleUrl),
      title: z.string().max(200).nullable(),
      frame: z.string().refine(png),
    })
    .nullable(),
});

export type OwnedComputerFleet = z.infer<typeof fleetSchema>;
export type OwnedComputerRead = z.infer<typeof readSchema>;
export type OwnedComputerFrame = z.infer<typeof frameSchema>["frame"];

export class OwnedComputerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(
      unavailableCodes.has(code) && status === 503
        ? "Scout's browser is not configured yet."
        : status === 401
          ? "Sign in to Scout again to use your computer."
          : status === 403 || status === 404
            ? "Your access to this computer could not be verified. Ask your Scout administrator to check it."
            : code === "COMPUTER_BUSY"
              ? "Scout is already using this computer. Wait for that request to finish, then open the sample page again."
              : code === "COMPUTER_CANCELLED"
                ? "The request stopped. Open the sample page again when you're ready."
                : "The computer could not be reached or returned an unexpected response. Try again when it is available.",
    );
  }
  get notConfigured() {
    return this.status === 503 && unavailableCodes.has(this.code);
  }
}

async function boundedBody(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 6 * 1024 * 1024)
        throw new OwnedComputerRequestError(
          response.status,
          "COMPUTER_RESPONSE_INVALID",
        );
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function request(
  path: string,
  signal: AbortSignal,
  method?: string,
  body?: Record<string, never>,
) {
  let response: Response;
  try {
    response = await tryClient(path, { signal, method, body });
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    throw new OwnedComputerRequestError(0, "COMPUTER_UNAVAILABLE");
  }
  let raw: string;
  try {
    raw = await boundedBody(response, signal);
  } catch (error) {
    if (signal.aborted || error instanceof OwnedComputerRequestError)
      throw error;
    throw new OwnedComputerRequestError(
      response.status,
      "COMPUTER_RESPONSE_INVALID",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  if (!response.ok) {
    const code =
      value &&
      typeof value === "object" &&
      "code" in value &&
      typeof value.code === "string"
        ? value.code
        : "COMPUTER_UNAVAILABLE";
    throw new OwnedComputerRequestError(response.status, code);
  }
  return value;
}

export const ownedComputerKeys = (userId: string) =>
  ["scout", "owned-computers", userId] as const;
export function ownedComputerFleetQueryOptions(userId: string) {
  return queryOptions({
    queryKey: ownedComputerKeys(userId),
    enabled: Boolean(userId),
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    queryFn: async ({ signal }): Promise<OwnedComputerFleet> => {
      const result = fleetSchema.safeParse(
        await request("/api/computers/fleet", signal),
      );
      if (!result.success)
        throw new OwnedComputerRequestError(200, "COMPUTER_RESPONSE_INVALID");
      return result.data;
    },
  });
}

/** The admitted alias chooses a scoped computer; the request never chooses a URL or principal. */
export async function openOwnedSamplePage(
  agentId: string,
  signal: AbortSignal,
): Promise<OwnedComputerRead> {
  if (!alias.safeParse(agentId).success)
    throw new OwnedComputerRequestError(400, "COMPUTER_INPUT_INVALID");
  const result = readSchema.safeParse(
    await request(`/api/computers/${agentId}/read-public`, signal, "POST", {}),
  );
  if (!result.success || result.data.computerId !== agentId)
    throw new OwnedComputerRequestError(200, "COMPUTER_RESPONSE_INVALID");
  return result.data;
}

export async function readOwnedSampleFrame(
  read: OwnedComputerRead,
  signal: AbortSignal,
): Promise<OwnedComputerFrame> {
  if (
    !alias.safeParse(read.computerId).success ||
    !z.uuid().safeParse(read.pageFrameId).success
  )
    throw new OwnedComputerRequestError(400, "COMPUTER_INPUT_INVALID");
  const result = frameSchema.safeParse(
    await request(
      `/api/computers/${read.computerId}/page-frame/${read.pageFrameId}`,
      signal,
    ),
  );
  if (
    !result.success ||
    (result.data.frame &&
      result.data.frame.title !== null &&
      result.data.frame.title !== read.title)
  )
    throw new OwnedComputerRequestError(200, "COMPUTER_RESPONSE_INVALID");
  return result.data.frame;
}
