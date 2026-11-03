# Scout workspace identity adapter for Odoo20 Community

This is source for a new Odoo20 addon, not a deployed sign-in service. It reuses
MSAL1.39.0 authorization code/PKCE and PyJWT2.14.0 RS256/JWKS validation, then
Odoo20's native credential/session and MFA handling. It does not reproduce
Intelligence, replace Odoo business ACLs, or turn Scout enrollment into an Odoo
grant. Odoo remains the authority for records, fields, company access and portal
sharing, including meeting logs/transcripts ingested into Odoo.

## Identity and authentication contract

- A system administrator explicitly binds the resource-tenant GUID and immutable
  Microsoft object GUID to ONE EXISTING Odoo user. Unique constraints cover both
  the identity and Odoo account. No email matching, JIT signup, account creation,
  password reset, login/partner/group/company changes or portal elevation occurs.
- Configuration is server-only: `SCOUT_ODOO_SSO_CONFIG_FILE` names an absolute
  non-symlink JSON file using `config.example.json`. Configuration and credential
  files must each be0600, single-link regular files owned by root or the service
  UID, under root-owned directories that are not group/world writable. Production
  permission qualification is POSIX-only; Windows tests inject synthetic settings.
  Missing/disabled/invalid configuration fails closed and hides the login button.
- Use the existing verified resource tenant. A separate single-tenant Odoo Web
  application registration/credential is preferred. Proposed exact callback:
  `https://odoo.somethingsomewhere.ph/scout_sso/microsoft/callback`.
  Canonical HTTPS origin and database must match the protected configuration.
  Do not add alias callbacks, implicit token grants, Graph data scopes or modify
  the existing Scout Better Auth registration as a side effect.
- MSAL adds `openid profile`; this adapter requests `email` and excludes
  `offline_access`. The ID token supplies identity; no Graph/UserInfo call is
  made. Secret, code verifier, nonce and token-endpoint responses never reach the
  browser. Flow dictionaries are in Odoo's server-side session, not its cookie.
- Each tab gets independent MSAL state/nonce/PKCE material, with at most eight
  unexpired flows per browser session and a five-minute expiry. A hash-only SQL
  admission is consumed and committed BEFORE exchange, including across workers.
  Admission SQL uses a three-second lock timeout and five-second statement timeout.
  Cancellation, exchange timeout, callback rollback or replay cannot retry that
  authorization code automatically; the user must start a new sign-in.
- MSAL's real code-flow decoder validates stored state/nonce; PyJWT additionally
  validates RS256 signature, current JWKS, exact audience/issuer and required time
  claims. Resource `tid` and `oid` are mandatory. Emails/names are never identity
  keys. Signing-key discovery is fixed to the tenant's Microsoft host, with a
  ten-second timeout and bounded cache. No browser-supplied token is accepted.
- A request-local one-use opaque proof invokes native `authenticate()` via the
  `scout_entra` credential extension. It is unavailable through JSON/RPC and reset
  in `finally`. At consumption the protected config, exact mapping/version and
  active existing account are rechecked under admission locks. Native MFA remains
  `default`; Entra sign-in does not skip a configured Odoo TOTP challenge.
- No bearer/ID token is written to Odoo, logs, user records or credential fields.
  The standard code response uses a transient authorization code in the callback
  query, followed by a no-store/no-referrer303. Before live qualification, proxy
  and HTTP access logs MUST redact query strings for the callback; this source
  does not change the host's logging or claim that existing logs are qualified.
  No provider error, exception content, token or claims are echoed by the addon.
- Authentication metadata is separate from business data. Admin-only mapping
  reads and hash-only admissions use privileged auth plumbing; this module has
  no business-record retrieval. Future workspace reads must run as the current
  mapped Odoo user, preserving ACL/record/field/company checks before model
  release, history and cache use. There is no cron, scheduler or automatic replay.

## Workspace boundary

The module adds a native Scout menu and an authenticated entry page with an
honest **Open Scout** new-tab action. This is a transitional entry point, not the
selected fully embedded Odoo workspace. The existing OpenDuet UI/backend and
Better Auth session remain unchanged. Microsoft interactive sign-in is top-level.

Full embedding still requires the coordinator's origin/BFF contract: exact Odoo
and Scout native identities must be proven equal for the current two sessions,
then bound to the allowed workspace origin. Matching email, a successful Odoo
login, iframe presence or `postMessage` data cannot establish that proof. Until
that seam is independently qualified, this addon does not frame Scout or share
cookies, tokens, native bridge capabilities, UID headers or business data. CSP,
frame-ancestors, SameSite/host-only cookies, CSRF, session rotation/logout and
actual desktop/mobile behavior require their own acceptance evidence.

## Qualification and rollout

Use the pinned requirements in an isolated environment; module import never
installs dependencies. Qualify against exact official Odoo20 source and a NEW
synthetic database. The tests cover real ORM constraints, native session/MFA,
mapping/config revocation, protocol denial, signed token/JWKS fixtures, independent
per-tab flows and durable replay/concurrency. No test uses real Microsoft auth,
business data or a browser. See `tools/qualify_odoo20.py` for the bounded local
command and retained source/dependency prerequisites.

The qualification helper accepts only clean official Odoo source commit
`bb238af6f0ddd70d7ff91521c6104472583661d1`, the dedicated synthetic database
`scout_odoo_workspace_test_20261103`, role `scout_workspace_test` and loopback
PostgreSQL port25443. Initialize/start a NEW isolated PG16 cluster first; never
point the helper at any existing Odoo database or server. The Odoo test runner
forces an HTTP thread, so the helper binds a NEW loopback-only ephemeral port0
and closes it at shutdown. It never binds the existing8069 listener.

```powershell
& '<isolated-venv>/Scripts/python.exe' -B `
  scout/odoo_addons/scout_workspace/tools/qualify_odoo20.py `
  --source '<clean-official-Odoo20-source>' `
  --data-dir '<qualification>/odoo-workspace-pg16-20261103/odoo-data'
```

For an already initialized dedicated synthetic database only, add `--update`.
The helper uses `--test-tags=/scout_workspace`; no CI platform or workflow is
added by this module. Local qualification used Python3.12.3, PostgreSQL16,
MSAL1.39.0, PyJWT2.14.0 and the existing Odoo-compatible cryptography42.0.8.
Pin/qualify the complete Odoo dependency environment before any deployment;
do not run a global pip upgrade against the Community service.

At the first qualification checkpoint, all16 addon test methods passed with
zero failed/error results. Odoo's stats counted18 including subtests. Its
Windows synthetic-filestore garbage collector emitted a PermissionError warning;
the addon tests and process exit still passed. This does not qualify Linux file
ownership, actual Entra login, callback log redaction, host deployment or embedding.

Production still needs reviewed module/schema installation on a released host
claim, separate protected configuration/credential provisioning, registration and
explicit account enrollment, callback query-log redaction, one owner login/MFA
and negative-identity tests. Preserve existing password access as the recovery
route. Disabling config/binding closes new SSO admission; existing native Odoo
session revocation/lifetimes remain Odoo's policy, not an invented instant Entra
logout guarantee. Do not uninstall an active module or delete admission metadata
as an automatic retry/rollback technique.

References: [MSAL code flow](https://learn.microsoft.com/en-us/entra/msal/python/getting-started/acquiring-tokens),
[Microsoft immutable claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference).
This addon is LGPL-3; retain Odoo, MSAL MIT and dependency notices.
