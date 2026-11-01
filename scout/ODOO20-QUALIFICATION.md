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
Both seed and own-key RPC reports for both synthetic customers are collected
before any classification assertion. Failed RPC diagnostics become unknown/null,
never a passing boolean, so all four reports remain available before the strict
gate blocks the positive customer stage.

Odoo 20's [own-user group check](https://github.com/odoo/odoo/blob/20.0/odoo/addons/base/models/res_users.py)
uses effective group membership, and its user-type groups are disjoint. Its
[portal wizard](https://github.com/odoo/odoo/blob/20.0/addons/portal/wizard/portal_wizard.py)
uses the portal template and explicit portal/public group management. This
source inspection alone does not establish exact installed-image behavior.

Run `41344258064`, job `124960588849`, at `b92543e10635114033a3f5caa271fe9fe0ee91b4`
failed after 26 assertions. The available bounded output shows portal B's seed
portal=true and the other three groups=false, while its own-key JSON-2 returned
all four=false. This is a seed-versus-RPC discrepancy, not positive customer
qualification. The old runner tail omitted portal A's earlier reports; the
runner now forwards at most six fixed redacted reports before its status tail.

The official Odoo source explains a compatible cause: [`_get_group_ids`](https://github.com/odoo/odoo/blob/25e862d803aed1ff1a7cf3bef73b7686b8ef9741/odoo/addons/base/models/res_users.py)
reads `all_group_ids` without sudo, while [relational conversion](https://github.com/odoo/odoo/blob/25e862d803aed1ff1a7cf3bef73b7686b8ef9741/odoo/orm/fields_relational.py)
filters inaccessible groups. [Base ACLs](https://github.com/odoo/odoo/blob/25e862d803aed1ff1a7cf3bef73b7686b8ef9741/odoo/addons/base/security/ir.access.csv)
grant group reads to internal users, not portals. Odoo's `_is_portal` instead
uses sudo. The referenced official commit is from 2026-10-15; it is not claimed
as the image package's exact source hash. The inference is checked by a new
transaction test inside the exact pinned image, not by pretending a mock proves it.

The fixture now mounts and installs only the minimal [own-identity addon](odoo-addons/scout_own_identity/README.md)
in its disposable database. Its transaction test reproduces group invisibility
and cached false stock membership, then checks exact own attestation and current
role change without account/group/key side effects. That regression invalidates
the synthetic test's ORM cache once before the cold stock call; it then calls
attestation in the same transaction without another cache reset. Production
attestation performs no cache invalidation. Odoo's ORM cache is transaction-layered
and can propagate to its registry on commit; exact cross-request behavior is not
assumed to be immune to stock-call interference.

The JSON-2 stage collects both customers' seed and attestation reports before
classification assertions, then requires actual positive and negative caller-ACL
business reads without cache clearing or elevated record access. Existing
employee-reader portal refusals and stock RPC diagnostics use the same customer
keys after those business reads and before the synthetic role change. This
ordering avoids manufacturing a cache-contamination availability failure with
the diagnostic itself; the poisoned-cache case remains explicit in the addon
transaction regression. All six fixed reports are retained in failure output.
Stock RPC reports are diagnostic data with no authority; exact positive portal
membership and negative internal/admin membership must instead pass the strict
versioned attestation. The original employee reader is unchanged. Project/task
reads continue as the customer without sudo. Caller-supplied IDs, UID or group
arguments to the new model method must receive HTTP 422. No actual customer
qualification, live addon installation or shared-access activation is claimed
until its respective evidence is recorded.

The addon proves identity facts only. It neither fixes global Odoo cache state
nor grants project/task access. If Odoo denies a business read, including from a
cached group result, Scout returns no context. A focused adapter regression
requires that refusal even when own attestation is positive. General cache
availability and any upstream Odoo remedy remain separate from this narrow
authorization repair and must not be inferred from a positive fixture.

The repair's local Bun 1.4.3 checks passed 41 tests with 712 assertions across
the diagnostic, customer adapter and unchanged employee adapter suites. The
three-test focused TypeScript graph, five-file Biome, seven Python syntax files,
workflow YAML parse, Bash syntax and whitespace checks passed. These are source
and mocked-transport checks only. The addon transaction regression and actual
JSON-2/ACL qualification remain pending the root-owned exact-image workflow;
no local Docker or database was used.
