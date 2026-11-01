export type RequestScope = { userId: string; isCurrent(): boolean };
type ScopeFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function assertCurrentRequestScope(scope: RequestScope): void {
  if (!scope.userId || !scope.isCurrent())
    throw new Error(
      "Your Scout account or conversation changed. Try again from the current screen.",
    );
}

/** SecureStore is asynchronous: validate again before dispatching the captured cookie. */
export async function scopedSession(
  getCookie: () =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>,
  scope: RequestScope,
): Promise<{ cookie: string | null; expectedUserId: string }> {
  assertCurrentRequestScope(scope);
  const cookie = (await getCookie()) || null;
  assertCurrentRequestScope(scope);
  return { cookie, expectedUserId: scope.userId };
}

/** Bind every dispatch, including chained reads, to its initiating native subject. */
export function scopedFetch(
  getCookie: Parameters<typeof scopedSession>[0],
  scope: RequestScope,
  fetcher: ScopeFetcher,
): ScopeFetcher {
  return async (url, init) => {
    const session = await scopedSession(getCookie, scope);
    const headers = new Headers(init?.headers);
    headers.delete("Cookie");
    if (session.cookie) headers.set("Cookie", session.cookie);
    headers.set("X-Scout-Expected-User", session.expectedUserId);
    const response = await fetcher(url, {
      ...init,
      credentials: "omit",
      headers,
    });
    assertCurrentRequestScope(scope);
    return response;
  };
}
