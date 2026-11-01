/**
 * HTTP admission for the qualified owned pilot, independent of installed optional feature stores.
 * This is not authorization: native session, tenant/resource, model and platform-owner checks still
 * run in their existing handlers. Adding an adapter requires an explicit route/method entry here.
 */
type Route = { methods: readonly string[]; path: RegExp };
const route = (methods: string, path: RegExp): Route => ({
  methods: methods.split(" "),
  path,
});
const hasControls = (value: string, last: number) =>
  Array.from(value).some(
    (character) =>
      character.charCodeAt(0) <= last || character.charCodeAt(0) === 127,
  );

/**
 * Inspect the raw URL pathname, before a router decodes it. Static route names must be literal.
 * Resource/provider identifiers can use canonical percent encoding; encoded separators, dot
 * traversal, controls and a second encoded layer never become a different route after admission.
 * Collection URLs have one spelling: no trailing slash, duplicate slash, query or fragment here.
 */
function unambiguousPath(pathname: string): boolean {
  if (
    !pathname.startsWith("/api/") ||
    pathname.length > 4096 ||
    /[?#\\]/.test(pathname) ||
    hasControls(pathname, 32) ||
    pathname.endsWith("/")
  )
    return false;
  for (const segment of pathname.slice(1).split("/")) {
    if (!segment) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      /[/\\%?#]/.test(decoded) ||
      hasControls(decoded, 31)
    )
      return false;
    if (
      segment.includes("%") &&
      encodeURIComponent(decoded) !==
        segment.replace(/%[0-9a-f]{2}/gi, (value) => value.toUpperCase())
    )
      return false;
  }
  return true;
}

const API: readonly Route[] = [
  // Existing shell/onboarding/preferences. Preferences contain only the two cosmetic UI choices.
  route("GET", /^\/api\/(?:capabilities|me)$/),
  route("POST", /^\/api\/me\/onboarding$/),
  route("GET PATCH", /^\/api\/settings\/preferences$/),
  route("GET PUT", /^\/api\/settings\/instructions$/),

  // Native scoped profiles. Endpoint probing remains an unqualified remote-agent capability.
  route("GET POST", /^\/api\/agents$/),
  route("GET", /^\/api\/agents\/capabilities$/),
  route("GET PATCH DELETE", /^\/api\/agents\/[^/]+$/),
  route("GET", /^\/api\/agents\/[^/]+\/handoff$/),
  route(
    "POST",
    /^\/api\/agents\/[^/]+\/(?:declined|duplicate|hide|unhide|pin|unpin|callback-token)$/,
  ),
  route("DELETE", /^\/api\/agents\/[^/]+\/callback-token$/),

  // Scoped conversation stores and live events. In owned mode first-day without a greeting calls
  // only store.direct; automaticTurns=false rejects greetings before any native worker insertion.
  route("GET POST", /^\/api\/channels$/),
  route("GET", /^\/api\/channels\/events$/),
  route("POST", /^\/api\/channels\/first-day$/),
  route("GET DELETE", /^\/api\/channels\/[^/]+$/),
  route("POST", /^\/api\/channels\/[^/]+\/(?:activity|busy|attachments)$/),
  route("PUT", /^\/api\/channels\/[^/]+\/(?:pin|read)$/),
  route("GET HEAD DELETE", /^\/api\/attachments\/[^/]+$/),
  route("GET", /^\/api\/openduet\/pages$/),
  route("GET DELETE", /^\/api\/openduet\/pages\/[^/]+$/),
  route("PATCH", /^\/api\/openduet\/pages\/[^/]+\/checklist$/),
  route("GET POST", /^\/api\/openduet\/channels$/),
  route("PATCH", /^\/api\/openduet\/channels\/[^/]+$/),
  route(
    "POST",
    /^\/api\/openduet\/channels\/[^/]+\/(?:archive|unarchive|keep)$/,
  ),

  // Owned history, requester port and conservative model receipts.
  route("POST", /^\/api\/threads\/mint$/),
  route("GET", /^\/api\/threads\/[^/]+$/),
  route("GET POST", /^\/api\/scout\/threads$/),
  route("GET", /^\/api\/scout\/threads\/[^/]+\/(?:messages|events)$/),
  route("POST", /^\/api\/scout\/threads\/[^/]+\/stop$/),
  route("GET", /^\/api\/scout\/model\/[^/]+\/receipts$/),
  // User-owned Odoo context enrollment, explicit model-release consent and revoke.
  route("POST DELETE", /^\/api\/scout\/odoo\/context-grants$/),
  route("POST", /^\/api\/scout\/odoo\/context-grants\/release$/),

  // Public MIT runner routes adapted in history/endpoint.ts. The installed SDK matcher also
  // accepts arbitrary prefixes and many auxiliary routes; none are admitted by these anchored paths.
  route("GET", /^\/api\/copilotkit\/info$/),
  route("GET", /^\/api\/copilotkit\/threads\/[^/]+\/messages$/),
  route("POST", /^\/api\/copilotkit\/agent\/[^/]+\/(?:run|connect)$/),
  route("POST", /^\/api\/copilotkit\/agent\/[^/]+\/stop\/[^/]+$/),

  // Existing deployment administration, still protected by the exact platform-owner boundary.
  route(
    "GET",
    /^\/api\/admin\/(?:status|audit-events|people|identity-providers|credentials|package)$/,
  ),
  route("POST", /^\/api\/admin\/people\/[^/]+\/(?:role|access)$/),
  route("DELETE", /^\/api\/admin\/identity-providers\/[^/]+$/),
  route("POST", /^\/api\/admin\/credentials$/),
  route("POST", /^\/api\/admin\/credentials\/[^/]+\/(?:rotate|revoke)$/),
  // The shell reads this capability projection. Enterprise execution/settings adapters stay closed.
  route("GET", /^\/api\/admin\/enterprise\/me$/),
];

const DELEGATED_DRAFTS: readonly Route[] = [
  route("GET POST", /^\/api\/scout\/tasks$/),
  route("POST", /^\/api\/scout\/tasks\/[^/]+$/),
];

const AUTH: readonly Route[] = [
  // Native Better Auth1.7.1 login/session lifecycle and the owned organization-session exchange.
  route("GET POST", /^\/api\/auth\/(?:get-session|organization\/session)$/),
  route(
    "POST",
    /^\/api\/auth\/(?:sign-out|revoke-session|revoke-sessions|revoke-other-sessions)$/,
  ),
  route("GET", /^\/api\/auth\/(?:list-sessions|desktop|ok|error)$/),
  route("POST", /^\/api\/auth\/sign-in\/(?:social|sso)$/),
  route("GET POST", /^\/api\/auth\/callback\/[^/]+$/),
  // Installed desktop/mobile login transports; authentication and proof checks stay in the plugins.
  route("POST", /^\/api\/auth\/electron\/(?:token|transfer-user)$/),
  route("GET", /^\/api\/auth\/electron\/init-oauth-proxy$/),
  route("GET", /^\/api\/auth\/expo-authorization-proxy$/),

  // Installed SSO1.7.1 management. Admission does not replace exact platform-owner authorization.
  route("GET", /^\/api\/auth\/sso\/(?:providers|get-provider)$/),
  route(
    "POST",
    /^\/api\/auth\/sso\/(?:register|update-provider|delete-provider|request-domain-verification|verify-domain)$/,
  ),
  // OIDC callbacks, public SAML metadata, assertions and own-session SAML logout protocol.
  route("GET", /^\/api\/auth\/sso\/callback(?:\/[^/]+)?$/),
  route("GET", /^\/api\/auth\/sso\/saml2\/sp\/metadata$/),
  route("GET POST", /^\/api\/auth\/sso\/saml2\/sp\/(?:acs|slo)\/[^/]+$/),
  route("POST", /^\/api\/auth\/sso\/saml2\/logout\/[^/]+$/),
];

function allowed(
  routes: readonly Route[],
  pathname: string,
  method: string,
): boolean {
  return (
    unambiguousPath(pathname) &&
    routes.some(
      (entry) => entry.methods.includes(method) && entry.path.test(pathname),
    )
  );
}

/** The existing requester contract remains opt-in until its selected live transport is qualified. */
export const ownedApiAllowed = (
  pathname: string,
  method: string,
  options: { delegatedDrafts?: boolean } = {},
): boolean =>
  allowed(API, pathname, method) ||
  (options.delegatedDrafts === true &&
    allowed(DELEGATED_DRAFTS, pathname, method));
export const ownedAuthAllowed = (pathname: string, method: string): boolean =>
  allowed(AUTH, pathname, method);
