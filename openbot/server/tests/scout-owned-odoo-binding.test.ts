import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScoutBinding } from "../src/scout/binding";
import { parseScoutMembership } from "../src/scout/membership";
import { createOwnedQueueBindingReader } from "../src/scout/owned/queue-binding";
import {
  bindOwnedOdooContext,
  createOwnedOdooAdmission,
  createOwnedOdooBindingReader,
  parseOwnedOdooBinding,
} from "../src/scout/owned-model/odoo-binding";
import {
  type ProjectTaskContextGrant,
  type ProjectTaskContextPort,
  type ProjectTaskContextReleaseGrant,
  resolveProjectTaskContext,
} from "../src/scout/owned-model/record-context";
import { scoutFixtureConfig } from "./scout-binding.test";
import { membershipFixture } from "./scout-membership.test";

const actor = { id: "scout-fixture-alice" };
const sourceInstanceId = "odoo-community";
const modelFingerprint = "f".repeat(64);
const odooPolicy = () => ({
  version: 1,
  deploymentId: "scout-test",
  sourceInstanceId,
  bindings: [
    {
      userId: actor.id,
      tenantId: "tenant-a",
      revision: 1,
      active: true,
      expiresAt: "2099-01-01T00:00:00Z",
      sourceUid: 11,
      companyIds: [1, 2],
    },
  ],
});
function fixture() {
  const memberships = membershipFixture();
  const mapping = odooPolicy();
  const membership = async () =>
    parseScoutMembership(memberships, actor, "scout-test");
  const principal = async () => {
    const current = await membership();
    return {
      userId: current.userId,
      tenantId: current.tenantId,
      deploymentId: current.deploymentId,
      bindingFingerprint: current.fingerprint,
    };
  };
  const admit = createOwnedOdooAdmission({
    membership,
    binding: async (person) =>
      parseOwnedOdooBinding(mapping, person, sourceInstanceId),
    sourceInstanceId,
  });
  const records = new Map<string, ProjectTaskContextGrant>();
  const releases = new Map<string, ProjectTaskContextReleaseGrant>();
  const calls: string[] = [];
  let afterGrantRead: (() => void) | undefined;
  let afterTaskRead: (() => void) | undefined;
  const store: ProjectTaskContextPort = {
    sourceInstanceId,
    getGrant: async (scope) => {
      calls.push(scope.bindingFingerprint);
      const value = records.get(scope.bindingFingerprint) ?? null;
      afterGrantRead?.();
      return value;
    },
    getReleaseGrant: async (scope) => {
      calls.push(scope.bindingFingerprint);
      return releases.get(scope.bindingFingerprint) ?? null;
    },
    readProjectTask: async (request) => {
      calls.push(request.principal.bindingFingerprint);
      afterTaskRead?.();
      return [
        {
          id: 42,
          name: "Synthetic mapped task",
          stage_id: [9, "Fixture"],
          date_deadline: null,
          company_id: [1, "Synthetic"],
        },
      ];
    },
  };
  const port = bindOwnedOdooContext(store, admit);
  const seed = async () => {
    const scope = await admit(await principal());
    records.set(scope.principal.bindingFingerprint, {
      principal: scope.principal,
      active: true,
      revision: 1,
      expiresAt: "2099-01-01T00:00:00Z",
      sourceIdentity: {
        instanceId: sourceInstanceId,
        uid: 11,
        role: "user",
        qualification: "qualified",
        qualificationExpiresAt: "2099-01-01T00:00:00Z",
        companyIds: [1, 2],
        credentialRef: "00000000-0000-4000-8000-000000000101",
      },
      allowedProjectIds: [501],
    });
    releases.set(scope.principal.bindingFingerprint, {
      principal: scope.principal,
      active: true,
      revision: 1,
      expiresAt: "2099-01-01T00:00:00Z",
      sourceInstanceId,
      dataClass: "odoo.project_task_summary.v1",
      provider: "local",
      modelPolicyFingerprint: modelFingerprint,
    });
    return scope;
  };
  const resolve = async () =>
    resolveProjectTaskContext(
      port,
      await principal(),
      42,
      "local",
      modelFingerprint,
    );
  return {
    memberships,
    mapping,
    membership,
    principal,
    admit,
    port,
    records,
    releases,
    calls,
    seed,
    resolve,
    afterGrantRead: (callback: () => void) => {
      afterGrantRead = callback;
    },
    afterTaskRead: (callback: () => void) => {
      afterTaskRead = callback;
    },
  };
}

describe("independent protected Odoo identity and saved context admission", () => {
  test("requires exact deployment, tenant, native subject and fixed source; expired/revoked/absent mappings deny", async () => {
    const f = fixture(),
      principal = await f.principal();
    const parsed = parseOwnedOdooBinding(
      f.mapping,
      principal,
      sourceInstanceId,
    );
    expect(parsed.sourceUid).toBe(11);
    for (const value of [
      { ...f.mapping, deploymentId: "foreign" },
      { ...f.mapping, sourceInstanceId: "foreign" },
      { ...f.mapping, bindings: [] },
      {
        ...f.mapping,
        bindings: [{ ...f.mapping.bindings[0], userId: "foreign" }],
      },
      {
        ...f.mapping,
        bindings: [{ ...f.mapping.bindings[0], tenantId: "foreign" }],
      },
      { ...f.mapping, bindings: [{ ...f.mapping.bindings[0], active: false }] },
      {
        ...f.mapping,
        bindings: [
          { ...f.mapping.bindings[0], expiresAt: "2000-01-01T00:00:00Z" },
        ],
      },
    ])
      expect(() =>
        parseOwnedOdooBinding(value, principal, sourceInstanceId),
      ).toThrow("MODEL_ACCESS_DENIED");
    for (const value of [
      { ...f.mapping, command: ["python"] },
      { ...f.mapping, bindings: [{ ...f.mapping.bindings[0], sourceUid: 1 }] },
      {
        ...f.mapping,
        bindings: [{ ...f.mapping.bindings[0], apiKeyFile: "/unused" }],
      },
      { ...f.mapping, bindings: [{ ...f.mapping.bindings[0], role: "admin" }] },
      {
        ...f.mapping,
        bindings: [{ ...f.mapping.bindings[0], companyIds: [1, 1] }],
      },
      {
        ...f.mapping,
        bindings: [...f.mapping.bindings, f.mapping.bindings[0]],
      },
      {
        ...f.mapping,
        bindings: [
          ...f.mapping.bindings,
          {
            ...f.mapping.bindings[0],
            userId: "other-user",
            tenantId: "other-tenant",
          },
        ],
      },
    ])
      expect(() =>
        parseOwnedOdooBinding(value, principal, sourceInstanceId),
      ).toThrow("MODEL_NOT_CONFIGURED");
  });
  test("actual protected mapping file is reread and missing/malformed configuration grants no source authority", async () => {
    const f = fixture(),
      principal = await f.principal();
    const directory = await mkdtemp(join(tmpdir(), "scout-odoo-map-"));
    const path = join(directory, "odoo-bindings.json");
    const read = createOwnedOdooBindingReader(path, sourceInstanceId);
    try {
      await expect(read(principal)).rejects.toThrow("MODEL_NOT_CONFIGURED");
      await writeFile(path, JSON.stringify(f.mapping), { mode: 0o600 });
      expect((await read(principal)).sourceUid).toBe(11);
      f.mapping.bindings[0].active = false;
      await writeFile(path, JSON.stringify(f.mapping));
      await expect(read(principal)).rejects.toThrow("MODEL_ACCESS_DENIED");
      await writeFile(path, "SYNTHETIC_PRIVATE_PARSE_ERROR");
      await expect(read(principal)).rejects.toThrow("MODEL_NOT_CONFIGURED");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("source grants and credential reads use combined Odoo scope while the model retains native membership scope", async () => {
    const f = fixture(),
      admission = await f.seed(),
      native = await f.principal();
    expect(admission.principal.bindingFingerprint).not.toBe(
      native.bindingFingerprint,
    );
    const record = (await f.port.getGrant(native)) as ProjectTaskContextGrant;
    expect(record.principal).toEqual(native);
    const selected = await f.resolve();
    expect(selected.prompt).toContain("Synthetic mapped task");
    await selected.assertCurrent(native, "local");
    expect(
      f.calls.every(
        (value) => value === admission.principal.bindingFingerprint,
      ),
    ).toBe(true);
    // Rows from the old queue-derived/native scope cannot stand in for combined source grants.
    f.records.clear();
    f.releases.clear();
    f.records.set(native.bindingFingerprint, record);
    await expect(f.resolve()).rejects.toThrow("MODEL_ACCESS_DENIED");
  });
  test("a replacement context port cannot change the configured fixed Odoo source", async () => {
    const f = fixture();
    let reads = 0;
    const port = bindOwnedOdooContext(
      {
        sourceInstanceId: "foreign-source",
        getGrant: async () => {
          reads++;
          return null;
        },
        getReleaseGrant: async () => {
          reads++;
          return null;
        },
        readProjectTask: async () => {
          reads++;
          return [];
        },
      },
      f.admit,
    );
    await expect(port.getGrant(await f.principal())).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
    await expect(
      port.getReleaseGrant(await f.principal(), "local", modelFingerprint),
    ).rejects.toThrow("MODEL_ACCESS_DENIED");
    expect(reads).toBe(0);
  });
  test("queue authority rotation does not rotate Odoo admission or revoke saved selected context", async () => {
    const f = fixture(),
      admission = await f.seed(),
      queue = scoutFixtureConfig();
    const queueReader = createOwnedQueueBindingReader({
      membership: f.membership,
      queue: async () => parseScoutBinding(queue, actor),
      deploymentId: "scout-test",
    });
    const queueBefore = await queueReader(actor),
      selected = await f.resolve();
    queue.bindings[0].environment.SCOUT_ODOO_UID = "12";
    expect((await queueReader(actor)).fingerprint).not.toBe(
      queueBefore.fingerprint,
    );
    expect((await f.admit(await f.principal())).principal).toEqual(
      admission.principal,
    );
    await selected.assertCurrent(await f.principal(), "local");
  });
  test("changed, removed, expired and revoked Odoo mappings block saved record/release grants and in-flight context", async () => {
    for (const change of [
      "revision",
      "uid",
      "company",
      "removed",
      "expiry",
      "revoke",
    ] as const) {
      const f = fixture();
      await f.seed();
      const selected = await f.resolve(),
        native = await f.principal();
      const mapping = f.mapping.bindings[0];
      if (change === "revision") mapping.revision++;
      if (change === "uid") mapping.sourceUid = 12;
      if (change === "company") mapping.companyIds = [1];
      if (change === "removed") f.mapping.bindings = [];
      if (change === "expiry") mapping.expiresAt = "2000-01-01T00:00:00Z";
      if (change === "revoke") mapping.active = false;
      await expect(f.resolve()).rejects.toThrow("MODEL_ACCESS_DENIED");
      await expect(selected.assertCurrent(native, "local")).rejects.toThrow(
        "MODEL_ACCESS_DENIED",
      );
      expect((await f.membership()).fingerprint).toBe(
        native.bindingFingerprint,
      );
    }
  });
  test("native membership rotation or revocation cannot reuse the previous Odoo source admission", async () => {
    for (const revoke of [false, true]) {
      const f = fixture();
      await f.seed();
      const selected = await f.resolve(),
        native = await f.principal();
      if (revoke) f.memberships.memberships[0].active = false;
      else f.memberships.memberships[0].revision++;
      await expect(selected.assertCurrent(native, "local")).rejects.toThrow(
        "MODEL_ACCESS_DENIED",
      );
    }
  });
  test("mapping revocation during saved-grant or Odoo task reads withholds the result", async () => {
    for (const duringGrant of [false, true]) {
      const f = fixture();
      await f.seed();
      if (duringGrant)
        f.afterGrantRead(() => {
          f.mapping.bindings[0].active = false;
        });
      else
        f.afterTaskRead(() => {
          f.mapping.bindings[0].active = false;
        });
      await expect(f.resolve()).rejects.toThrow("MODEL_ACCESS_DENIED");
    }
  });
  test("mapping change while admission is being resolved cannot return the earlier grant", async () => {
    const f = fixture();
    let first = true;
    const admit = createOwnedOdooAdmission({
      membership: f.membership,
      sourceInstanceId,
      binding: async (principal) => {
        const value = parseOwnedOdooBinding(
          f.mapping,
          principal,
          sourceInstanceId,
        );
        if (first) {
          first = false;
          f.mapping.bindings[0].revision++;
        }
        return value;
      },
    });
    await expect(admit(await f.principal())).rejects.toThrow(
      "MODEL_ACCESS_DENIED",
    );
  });
});
