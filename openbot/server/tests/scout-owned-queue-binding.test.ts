import { describe, expect, test } from "bun:test";
import {
  createScoutBindingReader,
  parseScoutBinding,
} from "../src/scout/binding";
import { parseScoutMembership } from "../src/scout/membership";
import { createOwnedQueueBindingReader } from "../src/scout/owned/queue-binding";
import { scoutFixtureConfig } from "./scout-binding.test";
import { membershipFixture } from "./scout-membership.test";

const actor = { id: "scout-fixture-alice" };
const deploymentId = "scout-test";
function fixture() {
  const membership = membershipFixture();
  const queue = scoutFixtureConfig();
  const native = async () =>
    parseScoutMembership(membership, actor, deploymentId);
  const read = createOwnedQueueBindingReader({
    deploymentId,
    membership: native,
    queue: async () => parseScoutBinding(queue, actor),
  });
  return { membership, queue, native, read };
}

describe("owned queue requires separate matching current membership and draft authority", () => {
  test("valid intersection retains the real queue fields and pins both policies", async () => {
    const { membership, queue, native, read } = fixture();
    const original = await read(actor);
    expect(original.identity.uid).toBe(11);
    expect(original.command[2]).toBe("scout_queue.mcp_server");
    expect(original.fingerprint).not.toBe((await native()).fingerprint);
    const nativeBefore = (await native()).fingerprint;
    queue.bindings[0].environment.SCOUT_ODOO_UID = "12";
    expect((await read(actor)).fingerprint).not.toBe(original.fingerprint);
    expect((await native()).fingerprint).toBe(nativeBefore);
    const afterQueue = (await read(actor)).fingerprint;
    membership.memberships[0].revision++;
    expect((await read(actor)).fingerprint).not.toBe(afterQueue);
  });
  test("membership alone grants no queue operation, even when no queue credentials exist", async () => {
    const { native } = fixture();
    const read = createOwnedQueueBindingReader({
      deploymentId,
      membership: native,
      queue: createScoutBindingReader("relative-missing-file.json"),
    });
    expect((await native()).userId).toBe(actor.id);
    await expect(read(actor)).rejects.toThrow("SCOUT_NOT_CONFIGURED");
  });
  test("operator source changes queue provenance without changing native membership", async () => {
    const { queue, native, read } = fixture();
    const original = await read(actor);
    const nativeFingerprint = (await native()).fingerprint;
    Object.assign(queue.bindings[0].environment, {
      SCOUT_QUEUE_SOURCE_SURFACE: "api",
    });
    const changed = await read(actor);
    expect(changed.fingerprint).not.toBe(original.fingerprint);
    expect(changed.identity).toEqual(original.identity);
    expect(changed.environment.SCOUT_QUEUE_SOURCE_SURFACE).toBe("api");
    expect((await native()).fingerprint).toBe(nativeFingerprint);
  });
  test("a queue grant cannot admit a revoked native member or replace native policy", async () => {
    const { membership, read } = fixture();
    membership.memberships[0].active = false;
    await expect(read(actor)).rejects.toThrow("SCOUT_ACCESS_DENIED");
    membership.memberships = [];
    await expect(read(actor)).rejects.toThrow("SCOUT_ACCESS_DENIED");
  });
  test("wrong queue user, tenant, deployment and expired authority deny before any connector", async () => {
    for (const mismatch of [
      "user",
      "tenant",
      "deployment",
      "expiry",
    ] as const) {
      const { native, queue } = fixture();
      const value = parseScoutBinding(queue, actor);
      const read = createOwnedQueueBindingReader({
        deploymentId,
        membership: native,
        queue: async () => ({
          ...value,
          ...(mismatch === "user" ? { userId: "another-user" } : {}),
          ...(mismatch === "tenant" ? { tenantId: "another-tenant" } : {}),
          ...(mismatch === "deployment"
            ? { deploymentId: "another-deployment" }
            : {}),
          ...(mismatch === "expiry"
            ? { expiresAt: "2000-01-01T00:00:00Z" }
            : {}),
        }),
      });
      await expect(read(actor)).rejects.toThrow("SCOUT_ACCESS_DENIED");
    }
  });
  test("revocation or reassignment while queue policy is read refuses the old membership", async () => {
    for (const mutate of ["revoke", "revision", "tenant"] as const) {
      const { membership, queue, native } = fixture();
      const read = createOwnedQueueBindingReader({
        deploymentId,
        membership: native,
        queue: async () => {
          if (mutate === "revoke") membership.memberships[0].active = false;
          if (mutate === "revision") membership.memberships[0].revision++;
          if (mutate === "tenant") {
            membership.policies.push({
              ...membership.policies[0],
              tenantId: "tenant-b",
            });
            membership.memberships[0].tenantId = "tenant-b";
          }
          return parseScoutBinding(queue, actor);
        },
      });
      await expect(read(actor)).rejects.toThrow("SCOUT_ACCESS_DENIED");
    }
  });
});
