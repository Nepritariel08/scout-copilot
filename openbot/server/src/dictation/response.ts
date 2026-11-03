/** Bound actual bytes, including chunked/misleading Content-Length responses. */
export async function speechResponseBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel();
    throw new Error("SPEECH_RESPONSE_INVALID");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SPEECH_RESPONSE_INVALID");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("SPEECH_RESPONSE_INVALID");
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("SPEECH_RESPONSE_INVALID");
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function speechResponseJson(response: Response, limit = 32_768) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await speechResponseBytes(response, limit),
      ),
    ) as unknown;
  } catch {
    throw new Error("SPEECH_RESPONSE_INVALID");
  }
}
