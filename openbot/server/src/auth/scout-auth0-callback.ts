import type { MiddlewareHandler } from "hono";
import type { AuthService } from "./guards";

/** Reuse the existing approved callback while keeping state/code verification in native auth. */
export function scoutAuth0CallbackAlias(
  auth: AuthService | undefined,
): MiddlewareHandler {
  return async (context, next) => {
    const request = context.req.raw;
    const url = new URL(request.url);
    const namespace = url.pathname.replace(/\/+/g, "/").split("/")[1];
    if (namespace?.toLowerCase() !== "oauth2") return next();
    // Hono decodes route segments; inspect the original path rather than a decoded route match.
    if (url.pathname !== "/oauth2/callback" || request.method !== "GET")
      return context.json({ code: "SCOUT_IDENTITY_ROUTE_UNAVAILABLE" }, 404);
    if (!auth)
      return context.json({ code: "SCOUT_IDENTITY_ROUTE_UNAVAILABLE" }, 503);
    url.pathname = "/api/auth/callback/auth0";
    // Return the response directly, retaining every native Set-Cookie and redirect header.
    return auth.handler(
      new Request(url, {
        method: "GET",
        headers: request.headers,
        redirect: "manual",
        signal: request.signal,
      }),
    );
  };
}
