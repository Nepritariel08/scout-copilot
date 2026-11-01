# Scout private-pilot artifact

Prepared 2026-11-01. This is the source and operator contract for the artifact
step in the existing CI workflow, not a successful build receipt, installation
or activation. Use the exact terminal run and retained files recorded in
[SSC AI Enablement #4](https://github.com/Nepritariel08/ssc-ai-enablement/issues/4#issuecomment-6547459663).
Host ownership, resource limits and rollback remain in the
[private-pilot deployment packet](PRIVATE-PILOT-DEPLOYMENT.md).

## What CI retains

The pilot artifact step checks out the exact pull-request **head SHA**, builds
on Linux with Bun1.4.3 and the frozen lockfile, and explicitly selects
`openbot/examples/scout` branding. Its non-secret `SCOUT_MODEL` build input names
a model; it neither supplies a key nor grants inference. The default OpenDuet
package remains unchanged. Vite builds off the shared Community host; keep the
existing8GB/4vCPU Linode for the capped runtime.

The retained bundle consists of:

| File | Purpose |
| --- | --- |
| `source.tar.gz` | Exact tracked source at the selected head, including workspace manifests, lockfile, migrations, MIT notices and public environment examples; paths are relative to the repository root. |
| `web.tar.gz` | The prebuilt Scout browser application; paths are relative to `app/dist` (`index.html`, `assets/…`). |
| `manifest.json` | The declared exact source/build identity and integrity information used by the verifier. |

CI retention is approximately7 days. Download the bundle before expiry and
record its custody; expiry does not make a different run equivalent. There is
no retained `node_modules`, Linux runtime binary, container image, credential,
private policy or application database. A frozen dependency installation is
still required on the verified target host. The manifest pins Bun1.4.3,
Linux x64, Scout branding, lockfile/archive hashes, byte sizes and file inventory,
with commit/tree proof for the selected source. It is not a signed build
attestation; the manifest alone cannot authenticate the producer or prove CI ran.

## Build and verify

Use the reviewed exact checkout and Bun1.4.3. From `openbot/` on the Linux runner,
select the package with an absolute path: the generator resolves relative
`TENANT_PACKAGE_DIR` values against `openbot/server`, not the repository root.
For example, set `TENANT_PACKAGE_DIR="$PWD/examples/scout"` and the approved
non-secret `SCOUT_MODEL` before the existing frozen install and UI build steps.
See the deployment packet for their commands and dependency lifecycle policy.

From the checkout's `openbot/` directory, the packaging interface is:

```sh
SCOUT_SOURCE_SHA='REPLACE_WITH_VERIFIED_FULL_40_CHARACTER_SHA'
SCOUT_ARTIFACT_DIR='/absolute/new/private/scout-artifact-directory'
bun --no-env-file scripts/scout-pilot-artifact.ts package \
  --expected-source "$SCOUT_SOURCE_SHA" --output "$SCOUT_ARTIFACT_DIR"
bun --no-env-file scripts/scout-pilot-artifact.ts verify \
  --directory "$SCOUT_ARTIFACT_DIR" --expected-source "$SCOUT_SOURCE_SHA"
```

These values are deliberate placeholders. The source SHA must come from the
reviewed GitHub PR head/release record, not from the downloaded manifest. Use a
new output directory outside the checkout. Packaging does not run the build,
install dependencies, start Scout or grant access.

Before staging a downloaded artifact:

1. Establish the independently reviewed full source SHA, its exact PR/release
   and the applicable terminal CI result. Record the workflow/run and artifact
   identity. PR workflows can report a merge SHA; confirm the artifact job's
   explicit head checkout rather than assuming that merge SHA is the selected
   source. A PR-head bundle remains labeled with that SHA. After merge, build
   again at the selected merge/main SHA; never relabel the PR-head bundle.
2. Run `verify` from an independently reviewed checkout of the verifier, using
   that trusted expected SHA. Check the manifest and both archives together;
   do not execute a verifier extracted from an unverified archive. A matching
   manifest/archive set alone cannot authenticate who produced it.
3. Compare the manifest SHA256 or retained artifact digest with independently
   authenticated metadata/output from that exact successful CI run. A hash
   copied from the downloaded manifest is not independent evidence for the
   generated web. If comparing GitHub's outer artifact archive digest, hash
   that download before extraction; it is different from the inner tar hashes.
   Record the manifest/archive hashes with the source/run/artifact identity.
   An expired, missing, mismatched or unverifiable bundle remains unavailable
   for staging; no pending CI run is a pass.

## Preparation and activation

No owner email or Auth0 subject is needed to build or verify this artifact.
After current shared-host ownership is released and a fresh bounded WI75
preparation claim is verified, the operator may stage the checked source and
pinned official Bun binary under isolated Scout paths, install frozen Linux
dependencies, create the dedicated Scout-only roles/database, apply reviewed
migrations and check an empty database backup/isolated restore. Verify target,
path/role/database collisions, available resources, protected DB/backup custody
and rollback before mutation.

During preparation the Scout service stays **disabled and not started**;
ingress, DNS, IdP configuration, Odoo and DSH remain unchanged. No placeholder
identity, inherited service user or dummy requester is needed. An empty-schema
dump/restore is not authenticated history/recovery acceptance.

Stage source and browser assets under the same immutable release SHA. The
production API serves the prebuilt browser application itself through an
absolute `APP_DIST_DIR`, for example
`/opt/scout-pilot/releases/<APPROVED_SHA>/openbot/app/dist`:

| Verified archive | Extraction destination inside the claimed new release |
| --- | --- |
| `source.tar.gz` | `/opt/scout-pilot/releases/<APPROVED_SHA>/` |
| `web.tar.gz` | `/opt/scout-pilot/releases/<APPROVED_SHA>/openbot/app/dist/` |

Create/check those Scout-only destinations after verification and ownership
checks; do not extract over an existing release. From the extracted release's
`openbot/` directory, use the verified pinned Bun binary for
`bun install --production --frozen-lockfile --ignore-scripts`. Review any required
native lifecycle script individually; do not enable scripts globally or build
Vite on Community. Do not point `APP_DIST_DIR` at a build runner's
path, a different release, or a writable development directory. No Vite or
second browser server is needed; API and UI use the same approved HTTPS origin.

Before Scout startup or ingress activation, supply the actual protected IdP
client configuration, exact verified owner identity/account binding, native
role/platform-owner policy, tenant/deployment/requester mapping and private
HTTPS configuration described in [OWNED-AUTH0.md](OWNED-AUTH0.md) and the
deployment packet. Leave model policy absent until separately qualified;
delegated drafts remain disabled. Creating a Bot or staging an artifact grants
neither model access nor execution capabilities.

Record prepared, verified, installed, running, live and accepted states
separately. Artifact retention and exact-head CI do not establish login, real
inference, usable restored conversations, employee/customer access or MatePad
execution. Their acceptance remains separate.
