# Real Odoo 20 JSON-2 qualification

This is an isolated qualification harness for the existing fixed Odoo JSON-2
reader in `openbot/server/src/scout/owned-model/odoo-json2.ts`. It starts a
disposable Odoo 20 Community instance and PostgreSQL database in a private
GitHub-hosted runner, creates synthetic accounts and records, and drives the
production reader over its real HTTP transport. The harness does not change
Scout runtime policy, provision grants, expose a model endpoint, or connect to
Linode, a shared Odoo instance, or a device.

The qualification fixture uses two internal employees, two portal/customer
accounts, and the administrator in a synthetic two-company database. It checks
employee project visibility under each allowed-company context, exact
`project.task` field/domain arguments, inability to read another employee's
task, refusal of both portal users and an administrator before project/task
reads in the employee adapter, an Odoo UID/API-key mismatch, source-record deletion followed by a fresh
read, and live removal of an employee's internal group. A separately selected
[customer adapter](CUSTOMER-CONTEXT.md) now adds positive reads for two invited
portal customers in separate projects of the same company, cross-customer
denial, live collaboration withdrawal with retained followers, and refusal
after portal-to-internal classification changes. The original employee adapter
continues to deny these portal keys. Passing this test does not complete general
customer access or establish a production connection.

## Pinned images and external contracts

The runner uses official image repositories only and resolves immutable
multi-architecture manifest digests while forcing `linux/amd64`:

- Odoo Community `20.0-20261015`: `library/odoo@sha256:d5e3a26baa044867c826dddc09058f10e2582706bf83c146ea04fea889720c76`
- PostgreSQL `16.10-bookworm`: `library/postgres@sha256:38471f330eb885e04de130b768d6db4e10469e2311879c7e5c699f6d2d8a1c74`

The image release is defined by the [official Odoo Docker 20.0 build](https://github.com/odoo/docker/blob/master/20.0/Dockerfile)
and the [official Odoo image tag](https://hub.docker.com/layers/library/odoo/20.0-20261015/images/sha256-d5e3a26baa044867c826dddc09058f10e2582706bf83c146ea04fea889720c76).
The API contract is the [Odoo 20 External API reference](https://www.odoo.com/documentation/20.0/developer/reference/external_api.html),
including `res.users/context_get` without caller-supplied IDs.
The pinned image's `GET /web/version` contract returns `version_info` and `version`;
the qualification requires `version` to equal the pinned build `20.0-20261015` and the first two
`version_info` entries to be `20, 0`. This follows the [official Odoo 20 route
implementation](https://github.com/odoo/odoo/blob/20.0/addons/rpc/controllers/__init__.py),
not the legacy XML-RPC `server_version` field.

## Execution and evidence

The narrow `.github/workflows/odoo20-context-qualification.yml` workflow runs
on demand or when its scoped paths change. It has `contents: read`, uses
SHA-pinned actions, contains no external credentials, and does not upload
artifacts. Docker resources use generated unique names on the hosted runner;
PostgreSQL is reachable only on the runner's private container network. The
Odoo HTTP port binds to loopback on a random port. Setup/readiness polling and
the job have finite time limits. A cleanup trap removes only the generated
named containers and their anonymous volumes, the private network, and the
private temporary directory; it does not prune unrelated Docker resources.

The seed generates all Odoo API keys at runtime inside the disposable database.
Key material is copied only into a mode-0600 temporary directory, read by the
test process, and deleted by cleanup. The test and runner do not print keys,
database passwords, request authorization headers, complete fixture rows, or
container logs. The emitted summary records the Odoo server version, pinned
image reference, and assertion names only; it is ephemeral workflow output,
not a signed or production qualification record.

No local Docker qualification is claimed. A successful run of the dedicated
workflow establishes that this fixed reader interoperates with the pinned
synthetic Odoo 20 Community release and observes the listed Odoo ACL, group,
company, customer task-slice and record-state behaviors. It does not validate complete customer access,
production credentials, live directory memberships, model-egress policy, or
deployment readiness.

## Customer-classification failure diagnosis

Run `41343229565`, job `124957500719`, failed at the customer reader's strict
group comparison after 24 assertions. The employee metadata/project/task and
portal-refusal checks had executed, but no positive customer qualification was
established. Those logs did not identify the mismatching group or its value;
the failure therefore does not establish a fixture or protocol root cause.

The qualification now reads the seeded customers' effective groups after a
flush/cache invalidation, then independently reads the same four groups through
their own bearer identities before the positive customer stage. Each report is
limited to fixed synthetic customer/phase labels, the four known group IDs,
expected booleans and actual booleans (or null for malformed/missing values).
No API key, token, password, raw response, user/contact or business record is
logged. Redaction and exact expectations have focused pure tests. A mismatch
still fails; no production UID, portal, internal/admin or ACL check was relaxed.

Odoo 20's [own-user group check](https://github.com/odoo/odoo/blob/20.0/odoo/addons/base/models/res_users.py)
uses effective group membership, and its user-type groups are disjoint. Its
[portal wizard](https://github.com/odoo/odoo/blob/20.0/addons/portal/wizard/portal_wizard.py)
uses the portal template and explicit portal/public group management. This
source inspection does not identify which actual pinned-image result differed;
the next exact-source isolated CI readback is required before selecting a fix
or claiming customer qualification.
