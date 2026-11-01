# Existing Auth0 sign-in for owned Scout

Prepared 2026-11-01 for the owner-private pilot. This is a source and operator
review packet, not an executed account grant, credential migration or live login.
The primary record remains [SSC AI Enablement #4](https://github.com/Nepritariel08/ssc-ai-enablement/issues/4#issuecomment-6547459663).
Use the existing [private deployment packet](PRIVATE-PILOT-DEPLOYMENT.md) for
host ownership, exact release/artifact, ingress, rollback and acceptance.

## Registration and protected configuration

Reuse the existing Auth0 application rather than deploying another identity
service. Its recorded issuer is `https://ssc-agent-control.us.auth0.com/`; its
recorded callback is
`https://scout.somethingsomewhere.ph/oauth2/callback`. Public discovery confirms
the issuer, authorization/token/JWKS endpoints and advertised protocol support;
it does not verify this application's settings or credentials.

The [incomplete overlay](owned.env.example) has these source inputs:

| Input | Required value or custody |
| --- | --- |
| `SCOUT_RUNTIME_MODE` | `owned`; this Auth0 adapter refuses the default licensed composition. |
| `AUTH0_OAUTH_ISSUER` | Exact canonical `https://ssc-agent-control.us.auth0.com/`, including `/`. |
| `AUTH0_OAUTH_REDIRECT_URI` | Exact existing `https://scout.somethingsomewhere.ph/oauth2/callback`. No trailing slash, query or encoded alias. |
| `AUTH0_OAUTH_CLIENT_ID` / `AUTH0_OAUTH_CLIENT_SECRET` | Existing approved application's paired values, delivered through protected deployment-secret references. No values belong in Git, this document or chat. |
| `BETTER_AUTH_URL` | `https://scout.somethingsomewhere.ph`, sharing the callback origin. |
| `TRUSTED_ORIGINS` | The exact approved Scout origin; do not add wildcard origins. |
| `BETTER_AUTH_SECRET` | Protected native session secret, at least 32 characters, separate from Auth0's client secret. Preserve it with the matching native database backup. |
| `INITIAL_ADMIN_EMAILS` | Exact operator-approved addresses. The owner's address is still pending; no shared RDC/service account is substituted. |
| `OPENBOT_ORGANIZATION_AUTH_URL` | Empty for this native Auth0 route; that variable selects a different pinned OpenBot authority protocol. |

The client ID and secret must be resolved from their existing protected custody
by the authorized operator. This packet does not create, rotate, print or test
them. The example is deliberately incomplete and refuses startup until required
values, native identity and protected policy have been supplied.

Before live use, verify the existing application's exact callback allowlist,
authorization-code grant, enabled connection, client authentication method,
RS256/PS256 signing configuration and usable secret. These application-specific
facts remain unverified here. Repair and verify the Scout HTTPS ingress before
any callback acceptance test. Changing provider registration or access requires
its own established authority; preserving the recorded callback is the first
route to qualify. [Auth0 callback rules](https://auth0.com/docs/authenticate/login/redirect-users-after-login)

## Native flow and identity boundary

The browser starts native `POST /api/auth/sign-in/social` with provider `auth0`.
The exact `GET /oauth2/callback` alias forwards internally to BetterAuth's native
Auth0 callback; it grants no identity through headers. Both authorization and
token exchange retain the registered legacy redirect URI. The adapter uses
authorization code, S256 PKCE, native state and the server-generated OIDC nonce;
its marker travels in BetterAuth's protected `serverContext` rather than client
`additionalData`. Missing/expired state or ID token refuses admission. There is
no IdP-initiated or client-posted-ID-token alternative in this pilot.

BetterAuth verifies the signature/JWKS, issuer, audience and expected native
nonce before the adapter admits claims. The additional checks require RS256 or
PS256, exact configured issuer/client audience, nonempty immutable subject,
required unexpired `exp`, fresh `email_verified === true`, a valid email matching
the provisioned native user's email, and the exact native nonce. A locally
verified email does not replace the fresh Auth0 claim. No missing-token
`/userinfo` fallback supplies identity. [Auth0 ID-token validation](https://auth0.com/docs/secure/tokens/id-tokens/validate-id-tokens)

An operator must provision the native `users` row and exact
`accounts(provider_id='auth0', issuer, account_id=sub, user_id=nativeUserId)`
binding **before login**. A null legacy issuer, another provider, another
subject or a matching email alone is insufficient. The adapter rechecks that
binding before native session creation. Signup and implicit/explicit account
linking are disabled for this composition. Obtain the exact Auth0 subject from
verified IdP administration or an independently verified live assertion; do not
infer it from an email, display name, RDC account or the subject format.

For a preprovisioned local user whose email is still unverified, native profile
refresh updates the same-email verification flag from the admitted signed
claim before BetterAuth's existing verification gate. Only explicit identity
and display fields enter that refresh; provider groups, roles and preferences
do not become native grants or settings.

## Reviewable provisioning template; do not execute from this document

This template targets only the dedicated Scout database after its reviewed
migrations. Use an authorized database client that binds parameters separately
from SQL, on one connection for the complete transaction. Supply `$1` through
`$5` to the `INSERT` statement only:

1. `$1`: the exact issuer above, independently checked against provider evidence.
2. `$2`: the verified immutable Auth0 `sub`; never an invented placeholder.
3. `$3`: the approved native `users.id`, at most 200 characters; do not reuse a
   prior person's ID to make their history accessible.
4. `$4`: the reviewed native email, normalized to lowercase and matching the
   verified identity; the actual owner's address remains pending.
5. `$5`: a new reviewed native `accounts.id`, or its exact existing idempotent ID.

The transaction serializes cooperating provisioning operators, checks existing
identity ownership and refuses conflicts instead of relinking/updating an
account. PostgreSQL constraints and serializable isolation still apply; an
advisory lock does not constrain unrelated writers. On any error, `ROLLBACK`;
review the conflict before a bounded retry. Do not execute individual fragments.

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL search_path = pg_catalog, public;

CREATE TEMP TABLE scout_auth0_provision_input (
  issuer text NOT NULL,
  subject text NOT NULL,
  native_user_id text NOT NULL,
  email text NOT NULL,
  account_row_id text NOT NULL
) ON COMMIT DROP;

INSERT INTO scout_auth0_provision_input
  (issuer, subject, native_user_id, email, account_row_id)
VALUES ($1, $2, $3, $4, $5);

SELECT pg_advisory_xact_lock(hashtextextended('scout-auth0-provision', 0));

DO $provision$
DECLARE
  requested scout_auth0_provision_input%ROWTYPE;
BEGIN
  SELECT * INTO STRICT requested FROM scout_auth0_provision_input;
  IF requested.issuer <> 'https://ssc-agent-control.us.auth0.com/'
     OR length(requested.subject) NOT BETWEEN 1 AND 255
     OR requested.subject ~ '[[:space:][:cntrl:]]'
     OR length(requested.native_user_id) NOT BETWEEN 1 AND 200
     OR requested.native_user_id ~ '[[:space:][:cntrl:]]'
     OR requested.email <> lower(btrim(requested.email))
     OR requested.email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
     OR length(requested.account_row_id) = 0 THEN
    RAISE EXCEPTION 'Invalid reviewed Auth0 provisioning input';
  END IF;

  IF EXISTS (
    SELECT 1 FROM users u
    WHERE (u.id = requested.native_user_id AND u.email <> requested.email)
       OR (lower(u.email) = requested.email AND u.id <> requested.native_user_id)
  ) THEN
    RAISE EXCEPTION 'Native user/email ownership conflict; no automatic merge';
  END IF;

  IF EXISTS (
    SELECT 1 FROM accounts a
    WHERE (
      (a.issuer = requested.issuer AND a.account_id = requested.subject)
      OR (a.provider_id = 'auth0' AND a.account_id = requested.subject)
      OR a.id = requested.account_row_id
      OR (a.user_id = requested.native_user_id AND a.provider_id = 'auth0')
    ) AND NOT (
      a.id = requested.account_row_id
      AND a.provider_id = 'auth0'
      AND a.issuer IS NOT DISTINCT FROM requested.issuer
      AND a.account_id = requested.subject
      AND a.user_id = requested.native_user_id
    )
  ) THEN
    RAISE EXCEPTION 'Auth0 account ownership conflict; no automatic relink';
  END IF;

  INSERT INTO users (id, email, email_verified)
  VALUES (requested.native_user_id, requested.email, false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO accounts (id, provider_id, issuer, account_id, user_id)
  VALUES (requested.account_row_id, 'auth0', requested.issuer,
          requested.subject, requested.native_user_id)
  ON CONFLICT (id) DO NOTHING;
END
$provision$;

SELECT a.id, a.provider_id, a.issuer, a.account_id, a.user_id, u.email
FROM scout_auth0_provision_input requested
JOIN accounts a ON a.id = requested.account_row_id
JOIN users u ON u.id = a.user_id;

COMMIT;
```

No token, password or secret is inserted. A new native email starts unverified;
the fresh signed provider claim is still required and native verification logic
can update that flag during login. Preserve existing user/account ownership;
this template intentionally refuses migration, reassignment or additional
subjects for an already bound Auth0 user. Review those as separate changes.

Identity provisioning grants no native role, platform administration or tenant.
Review the native role separately. A parameterized native-role grant uses
`INSERT INTO user_roles (user_id, role) VALUES ($1, $2::role) ON CONFLICT DO NOTHING`
with the approved native ID and explicitly approved `user` or `admin` value,
followed by role readback. `INITIAL_ADMIN_EMAILS` also reapplies native admin
seeding on login; it is configuration authority, not identity proof.

A platform owner additionally requires that exact native ID in protected
`SCOUT_PLATFORM_OWNER_IDS`, a native admin role, and current protected tenant
membership. An Auth0 `sub` is an external account key; it is not automatically
the native ID named in that environment variable. Configure the current native
ID in `SCOUT_QUEUE_BINDINGS_FILE` separately, with the correct deployment,
tenant, revision, expiry and least-authority Odoo requester. Never share one
owner/service Odoo identity with employees or customers. See
[platform ownership](OWNED-RUNTIME.md#platform-ownership-and-identity-administration)
and [requester policy](QUEUE.md). Default platform-owner IDs remain empty and
delegated drafts remain disabled.

## Enterprise policy, logout and revocation

This generic Auth0 route arrives as enterprise method `oauth`; it does not
automatically become `sso-oidc`. Existing `ssoRequired` policy still refuses it
unless the verified address is an `INITIAL_ADMIN_EMAILS` break-glass exception.
Those exceptions retain their `session.break_glass` audit event. Do not disable
the policy or relabel the method merely to make login succeed.

Logout clears the native Scout session locally. Auth0 global logout and its
allowed post-logout URLs have not been qualified; an existing Auth0 SSO cookie
may let the next deliberate login complete without another password prompt.

Removing the Auth0 account mapping prevents a new mapped login; it does not
retroactively revoke an already issued native session. For removal, use the
qualified native people/session revocation and current tenant-policy denial,
with readback of each intended boundary. Owned guards recheck current native
identity and tenant membership, including event/stream delivery. Auth0 account
disablement, native session lifetime/revocation and Scout tenant-policy expiry
are separate controls; provider disablement alone is not an immediate local
session-revocation promise.

## Qualification and data location

The source suites cover strict claims/flow settings, protected configuration,
SQL issuer/subject lookup and removal. The separately qualified synthetic native
OIDC callback suite must establish signature, state/cookie, PKCE/nonce, exact
legacy redirect URI on authorization and token POST, closed enrollment and
refusal behavior. Use the exact current source/CI receipts in the primary
record; passing mocked/synthetic tests or exact-head CI does not establish live
Auth0 credentials, owner login, tenant binding or human acceptance. This SQL
template has not been executed by its preparation.

Owned conversation persistence stays in the dedicated Linode Scout PostgreSQL
store; authentication is hosted by Auth0. OpenRouter receives only context
admitted by the separate model-release policy and usage limits. Owning Scout
does not make identity hosting or remote inference local. The unchanged
licensed Intelligence composition retains its entitlements and defaults.

Keep the existing 8 GB Community Linode and the measured private-pilot limits
in [the deployment packet](PRIVATE-PILOT-DEPLOYMENT.md). No server resize,
additional IdP/backend, scheduler, MatePad installation/inference qualification
or physical PC-off test is authorized or established by this auth packet.
