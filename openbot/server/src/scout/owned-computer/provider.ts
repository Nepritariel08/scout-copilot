import type { ComputerProvider } from "../../computer/provider";
import { createDockerSupervisorProvider } from "../../computer/supervisor";
import { OwnedComputerError, type OwnedComputerRuntime } from "./bindings";

export type ComputerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Bound bytes before the upstream transport's JSON parser; redirects never carry service tokens. */
export function boundedComputerFetch(
  check: () => Promise<void>,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  const bounded: ComputerFetch = async (input, init) => {
    await check();
    if (signal.aborted) throw new OwnedComputerError("COMPUTER_CANCELLED");
    const response = await fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(35_000),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
    const limit = 5 * 1024 * 1024;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      if (reader)
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > limit)
            throw new OwnedComputerError("COMPUTER_UNAVAILABLE");
          chunks.push(next.value);
        }
    } catch {
      await reader?.cancel().catch(() => {});
      throw new OwnedComputerError("COMPUTER_UNAVAILABLE");
    } finally {
      reader?.releaseLock();
    }
    await check();
    if (signal.aborted) throw new OwnedComputerError("COMPUTER_CANCELLED");
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return new Response(
      response.status === 204 || response.status === 304 ? null : body,
      { status: response.status, headers: response.headers },
    );
  };
  return Object.assign(bounded, { preconnect: fetchImpl.preconnect });
}

export function ownedComputerProvider(
  config: OwnedComputerRuntime,
  fetchImpl: typeof fetch,
): ComputerProvider {
  return createDockerSupervisorProvider({
    baseUrl: config.supervisorUrl,
    token: config.supervisorToken,
    fetchImpl,
    timeoutMs: 10_000,
  });
}

export function loopbackComputerAddress(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new OwnedComputerError("COMPUTER_UNAVAILABLE");
  return url.origin;
}
