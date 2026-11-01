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
reads, an Odoo UID/API-key mismatch, source-record deletion followed by a fresh
read, and live removal of an employee's internal group. Portal access remains
explicitly denied by the current source boundary. Passing this test does not
complete customer access or establish a production connection.

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
company, and record-state behaviors. It does not validate customer access,
production credentials, live directory memberships, model-egress policy, or
deployment readiness.
